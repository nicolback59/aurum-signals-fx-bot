/**
 * Trade executor — the single path from a validated signal to a live bracket
 * order. Runs the safety checklist, sizes the trade, persists it and places
 * the bracket. Refuses to execute when auto-execute is disabled.
 */

import { randomUUID } from 'node:crypto';

import { runChecklist } from '../safety/safetyController';
import { calcRiskModel } from '../risk/riskEngine';
import type { IBrokerClient } from '../broker/IBrokerClient';
import type { TradeLogger } from '../logging/tradeLogger';
import type { SystemLogger } from '../logging/systemLogger';
import type { Signal } from '../engine/signalEngine';
import type {
  BotTrade,
  ExecutionResult,
  MarketDataState,
  SafetyContext,
  BotConfig,
  RiskModel,
} from '../types';

export interface ExecutorDeps {
  broker: IBrokerClient;
  tradeLogger: TradeLogger;
  sys: SystemLogger;
  config: BotConfig;
}

export interface ExecutionEnv {
  botEnabled: boolean;
  weeklyTradeCount: number;
  hasOpenTrade: boolean;
  marketDataAgeMs: number;
  recentFingerprints: Array<{ fingerprint: string; ts: number }>;
  now: Date;
}

export class TradeExecutor {
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  async executeTrade(
    signal: Signal,
    _marketData: MarketDataState,
    env: ExecutionEnv,
  ): Promise<ExecutionResult> {
    const { broker, tradeLogger, sys, config } = this.deps;

    // 1. Risk model first — needed by the safety checklist.
    const riskModel: RiskModel = calcRiskModel(signal.entry, signal.sl, signal.direction);

    // 2. Safety checklist.
    const ctx: SafetyContext = {
      botEnabled: env.botEnabled,
      apiConnected: broker.isConnected(),
      now: env.now,
      weeklyTradeCount: env.weeklyTradeCount,
      maxTradesPerWeek: config.maxTradesPerWeek,
      score: signal.score,
      minScore: config.minScore,
      esConfirmed: signal.esConfirm?.confirmed ?? false,
      riskModel,
      marketDataAgeMs: env.marketDataAgeMs,
      hasOpenTrade: env.hasOpenTrade,
      atr: signal.indicators.atr,
      adx: signal.indicators.adx,
      fingerprint: signal.fingerprint,
      recentFingerprints: env.recentFingerprints,
    };

    const safety = runChecklist(ctx);
    if (!safety.allPassed) {
      const reasons = safety.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.reason}`);
      tradeLogger.logRejection(signal, reasons, signal.fingerprint);
      return { executed: false, reason: safety.blockedBy ?? 'SAFETY_BLOCKED', safety };
    }

    // 3. Risk validity (defense in depth; also covered by checklist).
    if (!riskModel.valid) {
      tradeLogger.logRejection(signal, [`RISK_INVALID: ${riskModel.reason}`], signal.fingerprint);
      return { executed: false, reason: 'RISK_INVALID', safety };
    }

    // 4. Auto-execute kill switch.
    if (config.disableAutoExecute) {
      sys.warn('Auto-execute disabled — signal passed all checks but not placed', {
        fingerprint: signal.fingerprint,
      });
      return { executed: false, reason: 'AUTO_EXECUTE_DISABLED', safety };
    }

    // 5. Build the trade record.
    const trade: BotTrade = {
      id: randomUUID(),
      direction: signal.direction,
      signalType: signal.signalType,
      grade: signal.grade,
      score: signal.score,
      entry: riskModel.entry,
      stop: riskModel.stop,
      target: riskModel.target,
      contracts: riskModel.contracts,
      riskDollars: riskModel.riskDollars,
      targetDollars: riskModel.targetDollars,
      actualRR: riskModel.rr,
      status: 'OPEN',
      openTime: env.now.toISOString(),
      closeTime: null,
      closePrice: null,
      pnl: null,
      pnlR: null,
      esConfirmed: signal.esConfirm?.confirmed ?? false,
      rejectReason: null,
      orderId: null,
      signal,
    };

    // 6. Place the bracket order.
    try {
      const orderResult = await broker.placeOrder({
        symbol: 'MNQ',
        direction: trade.direction,
        quantity: trade.contracts,
        entryPrice: trade.entry,
        stopPrice: trade.stop,
        targetPrice: trade.target,
        bracket: true,
      });
      trade.orderId = orderResult.orderId;
    } catch (e) {
      const reason = `ORDER_PLACEMENT_FAILED: ${(e as Error).message}`;
      trade.status = 'REJECTED';
      trade.rejectReason = reason;
      tradeLogger.logRejection(signal, [reason], signal.fingerprint);
      return { executed: false, reason, safety };
    }

    // 7. Persist + log.
    tradeLogger.logExecuted(trade);

    return { executed: true, trade, orderId: trade.orderId ?? undefined, safety };
  }
}
