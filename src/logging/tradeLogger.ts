/**
 * Trade logger — persists executed and rejected trades and surfaces concise
 * human-readable log lines via the system logger.
 */

import type { BotDatabase } from '../storage/database';
import type { SystemLogger } from './systemLogger';
import type { BotTrade } from '../types';
import type { Signal } from '../engine/signalEngine';

export class TradeLogger {
  private readonly db: BotDatabase;
  private readonly sys: SystemLogger;

  constructor(db: BotDatabase, sys: SystemLogger) {
    this.db = db;
    this.sys = sys;
  }

  logExecuted(trade: BotTrade): void {
    this.db.insertTrade(trade);
    this.sys.trade(
      `EXECUTED ${trade.direction} ${trade.signalType} grade=${trade.grade} ` +
        `score=${trade.score} entry=${trade.entry} stop=${trade.stop} ` +
        `target=${trade.target} contracts=${trade.contracts} risk=$${trade.riskDollars.toFixed(0)}`,
      { id: trade.id, orderId: trade.orderId },
    );
  }

  logClosed(trade: BotTrade): void {
    this.db.updateTradeClose(
      trade.id,
      trade.closeTime ?? new Date().toISOString(),
      trade.closePrice ?? 0,
      trade.pnl ?? 0,
      trade.pnlR ?? 0,
      trade.status,
    );
    this.sys.trade(
      `CLOSED ${trade.id} status=${trade.status} ` +
        `pnl=$${(trade.pnl ?? 0).toFixed(2)} R=${(trade.pnlR ?? 0).toFixed(2)}`,
    );
  }

  logRejection(signal: Signal | null, reasons: string[], fingerprint: string): void {
    this.db.insertRejectedSignal({
      ts: new Date().toISOString(),
      score: signal?.score ?? 0,
      grade: signal?.grade ?? 'REJECT',
      signalType: signal?.signalType ?? 'NONE',
      direction: signal?.direction ?? 'NONE',
      rejectReasons: reasons.join('; '),
      fingerprint,
    });
    this.sys.info(`REJECTED signal: ${reasons.join('; ')}`, { fingerprint });
  }
}
