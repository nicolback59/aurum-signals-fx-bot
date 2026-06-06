/**
 * Bot controller — the orchestrator. Owns the broker connection, market data
 * feed, signal evaluation loop, trade execution and open-trade monitoring.
 * Emits BotState snapshots and trade/signal events for the IPC bridge.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

import {
  evaluateForBot,
  isInBotTradingWindow,
  msUntilNextWindow,
  isMarketOpen,
} from './engine/signalEngine';
import { IBClient } from './broker/ibClient';
import { MarketDataFeed } from './broker/marketDataFeed';
import { TradeExecutor } from './execution/tradeExecutor';
import { calcPnl, calcPnlR } from './risk/riskEngine';
import { BotDatabase } from './storage/database';
import { SystemLogger } from './logging/systemLogger';
import { TradeLogger } from './logging/tradeLogger';
import { currentWeekStartIso } from './reporting/weeklyReport';

import type { OHLCV, Signal } from './engine/signalEngine';
import type {
  BotConfig,
  BotState,
  BotTrade,
  BiasLabel,
  SignalSnapshot,
  MarketDataState,
} from './types';

const LOOP_INTERVAL_MS = 30_000;
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    ibHost: env.IB_HOST ?? '127.0.0.1',
    ibPort: Number(env.IB_PORT ?? 7497),
    ibClientId: Number(env.IB_CLIENT_ID ?? 1),
    ibAccount: env.IB_ACCOUNT ?? '',
    paperTrading: (env.PAPER_TRADING ?? 'true') === 'true',
    minScore: Number(env.BOT_MIN_SCORE ?? 80),
    maxTradesPerWeek: Number(env.BOT_MAX_TRADES_PER_WEEK ?? 5),
    riskDollars: Number(env.BOT_RISK_DOLLARS ?? 600),
    targetDollars: Number(env.BOT_TARGET_DOLLARS ?? 2000),
    disableAutoExecute: (env.DISABLE_AUTO_EXECUTE ?? 'false') === 'true',
  };
}

export class BotController extends EventEmitter {
  private readonly config: BotConfig;
  private readonly db: BotDatabase;
  private readonly sys: SystemLogger;
  private readonly tradeLogger: TradeLogger;
  private readonly broker: IBClient;
  private readonly feed: MarketDataFeed;
  private readonly executor: TradeExecutor;

  private runState: BotState['runState'] = 'stopped';
  private loopTimer: NodeJS.Timeout | null = null;
  private botEnabled = false;
  private lastError: string | null = null;
  private lastSignal: SignalSnapshot | null = null;
  private openTrade: BotTrade | null = null;
  private bias: BotState['bias'] = { esBias: 'NEUTRAL', mnqBias: 'NEUTRAL' };

  private readonly recentFingerprints: Array<{ fingerprint: string; ts: number }> = [];

  constructor(config: BotConfig, dbPath?: string) {
    super();
    this.config = config;
    const resolvedDbPath = dbPath ?? path.join(os.homedir(), '.aurum-fx-bot', 'bot.db');
    this.db = new BotDatabase(resolvedDbPath);
    this.sys = new SystemLogger(this.db);
    this.tradeLogger = new TradeLogger(this.db, this.sys);
    this.broker = new IBClient({
      host: config.ibHost,
      port: config.ibPort,
      clientId: config.ibClientId,
      account: config.ibAccount,
      logger: this.sys,
    });
    this.feed = new MarketDataFeed(this.broker, this.sys);
    this.executor = new TradeExecutor({
      broker: this.broker,
      tradeLogger: this.tradeLogger,
      sys: this.sys,
      config,
    });

    this.openTrade = this.db.getOpenTrade();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.runState === 'running' || this.runState === 'connecting') return;
    this.runState = 'connecting';
    this.botEnabled = true;
    this.lastError = null;
    this.emitState();

    try {
      this.sys.info('Bot starting — connecting to IB');
      await this.broker.connect();
      await this.feed.bootstrap();
      this.feed.subscribe();
      this.runState = 'running';
      this.sys.info('Bot running');
      this.scheduleLoop();
      void this.tick();
    } catch (e) {
      this.runState = 'error';
      this.lastError = (e as Error).message;
      this.sys.error(`Bot start failed: ${this.lastError}`);
    }
    this.emitState();
  }

  async stop(): Promise<void> {
    this.botEnabled = false;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.feed.unsubscribe();
    await this.broker.disconnect();
    this.runState = 'stopped';
    this.sys.info('Bot stopped');
    this.emitState();
  }

  private scheduleLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = setInterval(() => void this.tick(), LOOP_INTERVAL_MS);
  }

  // ── Main loop ────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.botEnabled) return;
    try {
      this.pruneFingerprints();

      const market = this.feed.getState();
      this.updateBias(market);

      // Always monitor an open trade regardless of window.
      if (this.openTrade) await this.monitorOpenTrade(market);

      const now = new Date();
      if (!isInBotTradingWindow(now)) {
        this.lastSignal = this.emptySnapshot(now, ['OUTSIDE_TRADING_WINDOW']);
        this.emitState();
        return;
      }

      if (market.isStale) {
        this.sys.warn('Skipping evaluation — market data stale');
        this.lastSignal = this.emptySnapshot(now, ['DATA_STALE']);
        this.emitState();
        return;
      }

      await this.evaluateAndMaybeTrade(market, now);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.sys.error(`Tick error: ${this.lastError}`);
    }
    this.emitState();
  }

  private async evaluateAndMaybeTrade(market: MarketDataState, now: Date): Promise<void> {
    const result = evaluateForBot({
      instrument: 'MNQ',
      bars: market.mnqBars,
      bars5m: market.mnq5mBars,
      esBars: market.esBars,
      es5mBars: market.es5mBars,
      nqBars: market.nqBars,
      timestamp: now,
    });

    this.lastSignal = this.snapshotFromResult(result.signal, result.rejectReasons, now);
    this.emit('signal-evaluated', this.lastSignal);

    if (!result.botTradable || !result.signal) {
      if (result.signal) {
        this.tradeLogger.logRejection(
          result.signal,
          [...result.rejectReasons, ...result.botRejectReasons],
          result.signal.fingerprint,
        );
      }
      return;
    }

    const signal = result.signal;
    const weeklyCount = this.weeklyTradeCount();

    const exec = await this.executor.executeTrade(signal, market, {
      botEnabled: this.botEnabled,
      weeklyTradeCount: weeklyCount,
      hasOpenTrade: this.openTrade != null,
      marketDataAgeMs: this.feed.ageMs(),
      recentFingerprints: this.recentFingerprints,
      now,
    });

    if (exec.executed && exec.trade) {
      this.openTrade = exec.trade;
      this.recentFingerprints.push({ fingerprint: signal.fingerprint, ts: now.getTime() });
      this.emit('trade-executed', exec.trade);
    }
  }

  // ── Open trade monitoring ────────────────────────────────────────────────────

  private async monitorOpenTrade(market: MarketDataState): Promise<void> {
    const trade = this.openTrade;
    if (!trade) return;
    const lastBar = market.mnqBars[market.mnqBars.length - 1];
    if (!lastBar) return;

    const price = lastBar.close;
    const isLong = trade.direction === 'LONG';
    const hitStop = isLong ? lastBar.low <= trade.stop : lastBar.high >= trade.stop;
    const hitTarget = isLong ? lastBar.high >= trade.target : lastBar.low <= trade.target;

    if (!hitStop && !hitTarget) return;

    const exitPrice = hitStop ? trade.stop : trade.target;
    const status: BotTrade['status'] = hitStop ? 'LOSS' : 'WIN';
    const pnl = calcPnl(trade.entry, exitPrice, trade.contracts, trade.direction);
    const pnlR = calcPnlR(pnl, trade.riskDollars);

    const closed: BotTrade = {
      ...trade,
      status,
      closeTime: new Date().toISOString(),
      closePrice: exitPrice,
      pnl,
      pnlR,
    };
    this.tradeLogger.logClosed(closed);
    this.openTrade = null;
    this.emit('trade-executed', closed);
    void price; // kept for clarity / future trailing logic
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private weeklyTradeCount(): number {
    return this.db.countTradesSince(currentWeekStartIso());
  }

  private pruneFingerprints(): void {
    const cutoff = Date.now() - FINGERPRINT_TTL_MS;
    for (let i = this.recentFingerprints.length - 1; i >= 0; i--) {
      if (this.recentFingerprints[i].ts < cutoff) this.recentFingerprints.splice(i, 1);
    }
  }

  private updateBias(market: MarketDataState): void {
    this.bias = {
      esBias: this.biasOf(market.es5mBars),
      mnqBias: this.biasOf(market.mnq5mBars),
    };
  }

  private biasOf(bars: OHLCV[]): BiasLabel {
    if (bars.length < 22) return 'NEUTRAL';
    const closes = bars.map((b) => b.close);
    const e = (period: number): number => {
      const k = 2 / (period + 1);
      let prev = closes[0];
      for (const c of closes) prev = c * k + prev * (1 - k);
      return prev;
    };
    const ema9 = e(9);
    const ema21 = e(21);
    if (ema9 > ema21) return 'BULL';
    if (ema9 < ema21) return 'BEAR';
    return 'NEUTRAL';
  }

  private snapshotFromResult(
    signal: Signal | null,
    rejectReasons: string[],
    now: Date,
  ): SignalSnapshot {
    if (!signal) return this.emptySnapshot(now, rejectReasons);
    const es = signal.esConfirm;
    return {
      hasSignal: true,
      score: signal.score,
      grade: signal.grade,
      signalType: signal.signalType,
      direction: signal.direction,
      esConfirmed: es?.confirmed ?? false,
      esChecks: es
        ? {
            aboveVwap: es.confirmed,
            emaAligned: es.confirmed,
            htfAligned: es.confirmed,
            structure: es.confirmed,
            momentum: es.confirmed,
          }
        : null,
      rejectReasons,
      evaluatedAt: now.toISOString(),
    };
  }

  private emptySnapshot(now: Date, rejectReasons: string[]): SignalSnapshot {
    return {
      hasSignal: false,
      score: 0,
      grade: null,
      signalType: null,
      direction: null,
      esConfirmed: false,
      esChecks: null,
      rejectReasons,
      evaluatedAt: now.toISOString(),
    };
  }

  // ── State ────────────────────────────────────────────────────────────────────

  getState(): BotState {
    const now = new Date();
    const market = isMarketOpen(now);
    const inWindow = isInBotTradingWindow(now);
    const nextWindow = inWindow ? 0 : msUntilNextWindow(now);
    return {
      runState: this.runState,
      apiConnected: this.broker.isConnected(),
      marketOpen: market.open,
      inTradingWindow: inWindow,
      nextWindowMs: nextWindow,
      weeklyTradeCount: this.safeWeeklyCount(),
      maxTradesPerWeek: this.config.maxTradesPerWeek,
      bias: this.bias,
      signal: this.lastSignal,
      openTrade: this.openTrade,
      lastError: this.lastError,
      lastUpdate: now.toISOString(),
    };
  }

  private safeWeeklyCount(): number {
    try {
      return this.weeklyTradeCount();
    } catch {
      return 0;
    }
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  // ── Accessors for IPC ────────────────────────────────────────────────────────

  getDb(): BotDatabase {
    return this.db;
  }

  getLogger(): SystemLogger {
    return this.sys;
  }

  getConfig(): BotConfig {
    return this.config;
  }
}
