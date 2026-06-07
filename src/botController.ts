/**
 * Bot controller — the orchestrator. Owns the broker connection, market data
 * feed, signal evaluation loop, trade execution and open-trade monitoring.
 * Emits BotState snapshots and trade/signal events for the IPC bridge.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

// safeStorage is only available in the main process; guard for backtest/test contexts
let _safeStorage: typeof import('electron').safeStorage | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _safeStorage = (require('electron') as typeof import('electron')).safeStorage;
} catch {
  // not running in Electron
}

import {
  evaluateForBot,
  isInBotTradingWindow,
  msUntilNextWindow,
  isMarketOpen,
} from './engine/signalEngine';
import { IBClient } from './broker/ibClient';
import { TopstepAdapter } from './providers/topstepAdapter';
import { TradovateAdapter } from './providers/tradovateAdapter';
import type { IBrokerClient } from './broker/IBrokerClient';
import { MarketDataFeed } from './broker/marketDataFeed';
import { TradeExecutor } from './execution/tradeExecutor';
import { calcPnl, calcPnlR } from './risk/riskEngine';
import { BotDatabase } from './storage/database';
import { SystemLogger } from './logging/systemLogger';
import { TradeLogger } from './logging/tradeLogger';
import { currentWeekStartIso, currentDayStartIso } from './reporting/weeklyReport';

import type { OHLCV, Signal } from './engine/signalEngine';
import type {
  BotConfig,
  BotState,
  BotTrade,
  BiasLabel,
  SignalSnapshot,
  MarketDataState,
  ConnectionStatus,
  StartupLogEntry,
} from './types';

const LOOP_INTERVAL_MS = 5_000;
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    ibHost: env.IB_HOST ?? '127.0.0.1',
    ibPort: Number(env.IB_PORT ?? 7497),
    ibClientId: Number(env.IB_CLIENT_ID ?? 1),
    ibAccount: env.IB_ACCOUNT ?? '',
    paperTrading: (env.PAPER_TRADING ?? 'true') === 'true',
    minScore: Number(env.BOT_MIN_SCORE ?? 80),
    maxTradesPerDay: Number(env.BOT_MAX_TRADES_PER_DAY ?? 1),
    maxTradesPerWeek: Number(env.BOT_MAX_TRADES_PER_WEEK ?? 5),
    riskDollars: Number(env.BOT_RISK_DOLLARS ?? 600),
    targetDollars: Number(env.BOT_TARGET_DOLLARS ?? 2000),
    disableAutoExecute: (env.DISABLE_AUTO_EXECUTE ?? 'false') === 'true',
    brokerType: 'ib',
    brokerApiKey: '',
    accountMode: 'evaluation',
  };
}

export class BotController extends EventEmitter {
  private config: BotConfig;
  private readonly db: BotDatabase;
  private readonly sys: SystemLogger;
  private readonly tradeLogger: TradeLogger;
  private broker: IBrokerClient;
  private feed: MarketDataFeed;
  private executor: TradeExecutor;

  private runState: BotState['runState'] = 'stopped';
  private loopTimer: NodeJS.Timeout | null = null;
  private botEnabled = false;
  private lastError: string | null = null;
  private lastSignal: SignalSnapshot | null = null;
  private openTrade: BotTrade | null = null;
  private bias: BotState['bias'] = { esBias: 'NEUTRAL', mnqBias: 'NEUTRAL' };

  // Set to true if the broker connection drops during a running session.
  // Requires bot restart to clear — prevents trading on a recovered-but-suspect feed.
  private connectionEverDropped = false;
  private prevBrokerConnected = false;

  private readonly recentFingerprints: Array<{ fingerprint: string; ts: number }> = [];

  private connectionStatus: ConnectionStatus = {
    phase: 'disconnected',
    apiAuthStatus: 'unconfigured',
    accountVerified: false,
    mnqFeedActive: false,
    lastDataUpdate: null,
    latencyMs: null,
    reconnectAttempts: 0,
    systemHealth: 'healthy',
    mnqLastPrice: null,
    mnqLastVolume: null,
  };
  private apiValidated = false;
  private startupLogs: StartupLogEntry[] = [];

  constructor(config: BotConfig, db: BotDatabase) {
    super();
    this.config = config;
    this.db = db;
    this.db.initDefaultUser();
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

  /** Async factory — opens the database then constructs the controller. */
  static async create(config: BotConfig, dbPath?: string): Promise<BotController> {
    const resolvedDbPath = dbPath ?? path.join(os.homedir(), '.aurum-fx-bot', 'bot.db');
    const db = await BotDatabase.open(resolvedDbPath);
    return new BotController(config, db);
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  private applyDbSettings(): void {
    const s = this.db.getAllSettings();
    if (s.auto_execute !== undefined) {
      this.config.disableAutoExecute = s.auto_execute === 'false';
    }
    if (s.max_trades_per_day) {
      this.config.maxTradesPerDay = Math.max(1, Number(s.max_trades_per_day));
    }
    if (s.max_trades_per_week) {
      this.config.maxTradesPerWeek = Math.max(1, Number(s.max_trades_per_week));
    }
    if (s.risk_dollars) {
      this.config.riskDollars = Math.max(50, Number(s.risk_dollars));
    }
    if (s.target_dollars) {
      this.config.targetDollars = Math.max(100, Number(s.target_dollars));
    }
    if (s.broker_type) {
      this.config.brokerType = s.broker_type as BotConfig['brokerType'];
    }
    // Prefer encrypted key; fall back to plaintext for migration
    const encKey = s.broker_api_key_enc;
    const plainKey = s.broker_api_key;
    let resolvedKey = plainKey ?? '';
    if (encKey && _safeStorage?.isEncryptionAvailable()) {
      try {
        resolvedKey = _safeStorage.decryptString(Buffer.from(encKey, 'base64'));
      } catch {
        resolvedKey = plainKey ?? '';
      }
    }
    if (resolvedKey !== undefined) {
      if (this.config.brokerApiKey !== resolvedKey) {
        this.apiValidated = false;
        this.connectionStatus.apiAuthStatus = 'unconfigured';
      }
      this.config.brokerApiKey = resolvedKey;
    }
    if (s.account_mode) {
      this.config.accountMode = s.account_mode as BotConfig['accountMode'];
    }
    this.sys.info('Settings applied', {
      brokerType: this.config.brokerType,
      apiKeyConfigured: this.config.brokerApiKey.length > 0,
      autoExecute: !this.config.disableAutoExecute,
      riskDollars: this.config.riskDollars,
      targetDollars: this.config.targetDollars,
      maxTradesPerWeek: this.config.maxTradesPerWeek,
    });
  }

  private createBroker(): IBrokerClient {
    if (this.config.brokerType === 'topstep' && this.config.brokerApiKey) {
      this.sys.info('Using Topstep (ProjectX) broker');
      return new TopstepAdapter(this.config.brokerApiKey, this.sys);
    }
    if (this.config.brokerType === 'tradovate' && this.config.brokerApiKey) {
      this.sys.info('Using Tradovate broker');
      return new TradovateAdapter(this.config.brokerApiKey, this.sys);
    }
    this.sys.info('Using Interactive Brokers (TWS)');
    return new IBClient({
      host: this.config.ibHost,
      port: this.config.ibPort,
      clientId: this.config.ibClientId,
      account: this.config.ibAccount,
      logger: this.sys,
    });
  }

  reloadSettings(): void {
    this.applyDbSettings();
    this.emitState();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.runState === 'running' || this.runState === 'connecting') return;
    this.applyDbSettings();

    // Reset startup log for this run
    this.startupLogs = [];

    const brokerLabel = this.brokerLabel();
    const needsKey = this.config.brokerType !== 'ib';

    // Gate: API key required for REST brokers
    if (needsKey && !this.config.brokerApiKey) {
      this.addStartupLog('ERROR', 'API key not configured — go to Settings and enter your API key first');
      this.runState = 'error';
      this.lastError = 'API key required — not configured';
      this.connectionStatus.phase = 'error';
      this.connectionStatus.systemHealth = 'critical';
      this.emitState();
      return;
    }

    // Recreate broker/feed/executor so settings changes take effect on next start
    this.broker = this.createBroker();
    this.feed = new MarketDataFeed(this.broker, this.sys);
    this.executor = new TradeExecutor({
      broker: this.broker,
      tradeLogger: this.tradeLogger,
      sys: this.sys,
      config: this.config,
    });

    this.runState = 'connecting';
    this.botEnabled = true;
    this.lastError = null;
    this.connectionEverDropped = false;
    this.prevBrokerConnected = false;
    this.connectionStatus.phase = 'connecting';
    this.connectionStatus.systemHealth = 'healthy';
    this.connectionStatus.mnqFeedActive = false;
    this.emitState();

    this.addStartupLog('INFO', `Bot initialization started`);
    this.addStartupLog('INFO', `Broker: ${brokerLabel}`);

    if (needsKey) {
      this.addStartupLog('INFO', `API key configured — proceeding with authentication`);
    } else {
      this.addStartupLog('INFO', `Using Interactive Brokers TWS — no API key required`);
    }

    try {
      // Phase 1: Connect & authenticate
      this.addStartupLog('INFO', `Connecting to ${brokerLabel}...`);
      this.connectionStatus.phase = 'authenticating';
      this.connectionStatus.apiAuthStatus = 'validating';
      this.emitState();

      const connectStart = Date.now();
      await this.broker.connect();
      const latency = Date.now() - connectStart;
      this.connectionStatus.latencyMs = latency;

      this.addStartupLog('SUCCESS', `Authentication successful (${latency}ms)`);
      this.sys.info(`Bot starting — connecting via ${this.config.brokerType}`);

      // Phase 2: Account verification
      this.addStartupLog('INFO', 'Verifying account authorization...');
      this.connectionStatus.apiAuthStatus = 'authenticated';
      this.connectionStatus.accountVerified = true;
      this.connectionStatus.phase = 'connected';
      this.apiValidated = true;
      this.emitState();
      this.addStartupLog('SUCCESS', 'Account verified and authorized for MNQ trading');

      // Phase 3: Market data bootstrap
      this.addStartupLog('INFO', 'Bootstrapping MNQ market data feed...');
      this.addStartupLog('INFO', 'Loading historical MNQ 1m and 5m bars...');
      this.addStartupLog('INFO', 'Loading ES and NQ reference data...');
      this.connectionStatus.phase = 'data-feed-active';
      this.emitState();

      await this.feed.bootstrap();

      // Phase 4: Real-time subscription
      this.addStartupLog('SUCCESS', 'Historical bar data loaded successfully');
      this.addStartupLog('INFO', 'Subscribing to real-time MNQ price feed...');
      this.feed.subscribe();
      this.connectionStatus.mnqFeedActive = true;

      // Capture initial MNQ snapshot
      const mkt = this.feed.getState();
      if (mkt.mnqBars.length > 0) {
        const last = mkt.mnqBars[mkt.mnqBars.length - 1];
        this.connectionStatus.mnqLastPrice = last.close;
        this.connectionStatus.mnqLastVolume = last.volume ?? null;
        this.connectionStatus.lastDataUpdate = new Date().toISOString();
        this.addStartupLog('SUCCESS', `MNQ data feed active — last price: ${last.close.toFixed(2)}`);
      } else {
        this.addStartupLog('WARN', 'MNQ data feed active — awaiting first bar');
      }

      // Phase 5: Strategy init
      this.addStartupLog('INFO', 'Initializing signal evaluation strategy...');
      this.addStartupLog('INFO', `Min score gate: ${this.config.minScore} | Risk: $${this.config.riskDollars} | Target: $${this.config.targetDollars}`);
      this.addStartupLog('INFO', `Max trades/week: ${this.config.maxTradesPerWeek} | Auto-execute: ${this.config.disableAutoExecute ? 'OFF' : 'ON'}`);
      this.addStartupLog('INFO', 'Trading window: 09:30–10:30 ET (NY Open)');

      this.runState = 'running';
      this.connectionStatus.phase = 'bot-running';
      this.connectionStatus.systemHealth = 'healthy';

      this.addStartupLog('SUCCESS', '✓ All systems operational — BOT IS NOW RUNNING');
      this.addStartupLog('SUCCESS', `Monitoring MNQ signals on ${brokerLabel}`);

      this.sys.info('Bot running');
      this.scheduleLoop();
      void this.tick();
    } catch (e) {
      this.runState = 'error';
      this.lastError = (e as Error).message;
      this.connectionStatus.phase = 'error';
      this.connectionStatus.apiAuthStatus = 'failed';
      this.connectionStatus.systemHealth = 'critical';
      this.addStartupLog('ERROR', `Startup failed: ${this.lastError}`);
      this.addStartupLog('ERROR', 'Check your API key, account permissions, and network connection');
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
    this.addStartupLog('INFO', 'Stop requested — halting signal processing...');
    this.addStartupLog('INFO', 'Unsubscribing from MNQ real-time feed...');
    this.feed.unsubscribe();
    this.addStartupLog('INFO', 'Disconnecting from broker...');
    await this.broker.disconnect();
    this.runState = 'stopped';
    this.connectionStatus.phase = 'stopped';
    this.connectionStatus.mnqFeedActive = false;
    this.connectionStatus.systemHealth = 'healthy';
    this.addStartupLog('INFO', 'Bot stopped — all connections closed');
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

      // Detect connection drops — once dropped, flag persists until bot restarts.
      const nowConnected = this.broker.isConnected();
      if (this.prevBrokerConnected && !nowConnected) {
        this.connectionEverDropped = true;
        this.connectionStatus.systemHealth = 'critical';
        this.connectionStatus.reconnectAttempts += 1;
        this.sys.warn('Broker connection lost during active session — trading locked until restart');
      }
      this.prevBrokerConnected = nowConnected;

      // Track live MNQ data for the UI
      if (market.mnqBars.length > 0) {
        const last = market.mnqBars[market.mnqBars.length - 1];
        this.connectionStatus.mnqLastPrice = last.close;
        this.connectionStatus.mnqLastVolume = last.volume ?? null;
      }
      if (!market.isStale) {
        this.connectionStatus.lastDataUpdate = new Date().toISOString();
        this.connectionStatus.mnqFeedActive = true;
      } else if (this.connectionStatus.mnqFeedActive) {
        this.connectionStatus.systemHealth = 'degraded';
      }

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
    const dailyCount = this.dailyTradeCount();
    const connectionStable = !this.connectionEverDropped && this.broker.isConnected();

    const exec = await this.executor.executeTrade(signal, market, {
      botEnabled: this.botEnabled,
      connectionStable,
      dailyTradeCount: dailyCount,
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

  private dailyTradeCount(): number {
    return this.db.countTradesSince(currentDayStartIso());
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
      dailyTradeCount: this.safeDailyCount(),
      maxTradesPerDay: this.config.maxTradesPerDay,
      weeklyTradeCount: this.safeWeeklyCount(),
      maxTradesPerWeek: this.config.maxTradesPerWeek,
      bias: this.bias,
      signal: this.lastSignal,
      openTrade: this.openTrade,
      lastError: this.lastError,
      lastUpdate: now.toISOString(),
      brokerType: this.config.brokerType,
      apiKeyConfigured: this.config.brokerApiKey.length > 0,
      autoExecuteEnabled: !this.config.disableAutoExecute,
      connectionStatus: { ...this.connectionStatus },
      apiValidated: this.apiValidated,
      accountMode: this.config.accountMode,
      licenseValid: true,
    };
  }

  private safeWeeklyCount(): number {
    try {
      return this.weeklyTradeCount();
    } catch {
      return 0;
    }
  }

  private safeDailyCount(): number {
    try {
      return this.dailyTradeCount();
    } catch {
      return 0;
    }
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  // ── Startup log helpers ──────────────────────────────────────────────────────

  private addStartupLog(level: StartupLogEntry['level'], message: string): void {
    const entry: StartupLogEntry = { ts: new Date().toISOString(), level, message };
    this.startupLogs.push(entry);
    this.emit('startup-log', entry);
  }

  private brokerLabel(): string {
    switch (this.config.brokerType) {
      case 'topstep': return 'Topstep (ProjectX)';
      case 'tradovate': return 'Tradovate';
      case 'rithmic': return 'Rithmic';
      default: return 'Interactive Brokers (TWS)';
    }
  }

  // ── API validation (test connection without starting the bot) ─────────────────

  async validateApiConnection(): Promise<{ success: boolean; message: string }> {
    if (this.runState === 'running') {
      return { success: true, message: 'Already connected and running' };
    }
    this.applyDbSettings();
    const needsKey = this.config.brokerType !== 'ib';
    if (needsKey && !this.config.brokerApiKey) {
      return { success: false, message: 'API key not configured — save your key in Settings first' };
    }

    this.connectionStatus.apiAuthStatus = 'validating';
    this.emitState();
    this.addStartupLog('INFO', `Validating connection to ${this.brokerLabel()}...`);

    try {
      const tmp = this.createBroker();
      const t0 = Date.now();
      await tmp.connect();
      const latency = Date.now() - t0;
      await tmp.disconnect();

      this.connectionStatus.apiAuthStatus = 'authenticated';
      this.connectionStatus.accountVerified = true;
      this.connectionStatus.latencyMs = latency;
      this.connectionStatus.phase = 'connected';
      this.connectionStatus.systemHealth = 'healthy';
      this.apiValidated = true;

      const msg = `Connection validated — ${this.brokerLabel()} authenticated (${latency}ms)`;
      this.addStartupLog('SUCCESS', msg);
      this.sys.info(msg);
      this.emitState();
      return { success: true, message: msg };
    } catch (e) {
      const msg = (e as Error).message;
      this.connectionStatus.apiAuthStatus = 'failed';
      this.connectionStatus.phase = 'error';
      this.connectionStatus.systemHealth = 'critical';
      this.apiValidated = false;
      this.addStartupLog('ERROR', `Validation failed: ${msg}`);
      this.sys.error(`API validation failed: ${msg}`);
      this.emitState();
      return { success: false, message: `Validation failed: ${msg}` };
    }
  }

  getStartupLogs(): StartupLogEntry[] {
    return [...this.startupLogs];
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
