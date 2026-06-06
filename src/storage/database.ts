/**
 * Local SQLite persistence (better-sqlite3).
 *
 * Stores executed/rejected trades, system logs and rejected signals. All
 * timestamps are stored as ISO-8601 UTC strings.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import type {
  BotTrade,
  SystemLogEntry,
  WeeklyStats,
  DailyStats,
} from '../types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  opened_at TEXT,
  closed_at TEXT,
  direction TEXT,
  signal_type TEXT,
  grade TEXT,
  score INTEGER,
  entry REAL,
  stop REAL,
  target REAL,
  contracts INTEGER,
  risk_dollars REAL,
  target_dollars REAL,
  close_price REAL,
  pnl_dollars REAL,
  pnl_r REAL,
  status TEXT,
  reject_reason TEXT,
  es_confirmed INTEGER,
  signal_json TEXT
);
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  level TEXT,
  message TEXT,
  data TEXT
);
CREATE TABLE IF NOT EXISTS rejected_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  score INTEGER,
  grade TEXT,
  signal_type TEXT,
  direction TEXT,
  reject_reasons TEXT,
  fingerprint TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON system_logs(ts);
`;

interface TradeRow {
  id: string;
  opened_at: string | null;
  closed_at: string | null;
  direction: string;
  signal_type: string;
  grade: string;
  score: number;
  entry: number;
  stop: number;
  target: number;
  contracts: number;
  risk_dollars: number;
  target_dollars: number;
  close_price: number | null;
  pnl_dollars: number | null;
  pnl_r: number | null;
  status: string;
  reject_reason: string | null;
  es_confirmed: number;
  signal_json: string;
}

export class BotDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  // ── Trades ───────────────────────────────────────────────────────────────────

  insertTrade(t: BotTrade): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trades (
        id, opened_at, closed_at, direction, signal_type, grade, score,
        entry, stop, target, contracts, risk_dollars, target_dollars,
        close_price, pnl_dollars, pnl_r, status, reject_reason, es_confirmed, signal_json
      ) VALUES (
        @id, @opened_at, @closed_at, @direction, @signal_type, @grade, @score,
        @entry, @stop, @target, @contracts, @risk_dollars, @target_dollars,
        @close_price, @pnl_dollars, @pnl_r, @status, @reject_reason, @es_confirmed, @signal_json
      )
    `);
    stmt.run(this.toRow(t));
  }

  updateTradeClose(
    id: string,
    closedAt: string,
    closePrice: number,
    pnl: number,
    pnlR: number,
    status: string,
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET closed_at=?, close_price=?, pnl_dollars=?, pnl_r=?, status=? WHERE id=?`,
      )
      .run(closedAt, closePrice, pnl, pnlR, status, id);
  }

  getTrade(id: string): BotTrade | null {
    const row = this.db.prepare(`SELECT * FROM trades WHERE id=?`).get(id) as
      | TradeRow
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  getOpenTrade(): BotTrade | null {
    const row = this.db
      .prepare(`SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1`)
      .get() as TradeRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listTrades(limit = 500): BotTrade[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades ORDER BY COALESCE(opened_at, '') DESC LIMIT ?`)
      .all(limit) as TradeRow[];
    return rows.map((r) => this.fromRow(r));
  }

  countTradesSince(isoStart: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM trades WHERE opened_at >= ? AND status != 'REJECTED'`,
      )
      .get(isoStart) as { n: number };
    return row.n;
  }

  // ── Logs ─────────────────────────────────────────────────────────────────────

  insertLog(entry: SystemLogEntry): void {
    this.db
      .prepare(`INSERT INTO system_logs (ts, level, message, data) VALUES (?,?,?,?)`)
      .run(entry.ts, entry.level, entry.message, entry.data ?? null);
  }

  listLogs(limit = 300): SystemLogEntry[] {
    const rows = this.db
      .prepare(`SELECT id, ts, level, message, data FROM system_logs ORDER BY id DESC LIMIT ?`)
      .all(limit) as SystemLogEntry[];
    return rows;
  }

  // ── Rejected signals ─────────────────────────────────────────────────────────

  insertRejectedSignal(args: {
    ts: string;
    score: number;
    grade: string;
    signalType: string;
    direction: string;
    rejectReasons: string;
    fingerprint: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO rejected_signals (ts, score, grade, signal_type, direction, reject_reasons, fingerprint)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        args.ts,
        args.score,
        args.grade,
        args.signalType,
        args.direction,
        args.rejectReasons,
        args.fingerprint,
      );
  }

  // ── Aggregates ───────────────────────────────────────────────────────────────

  weeklyStats(isoWeekStart: string, isoWeekEnd: string, weekLabel: string): WeeklyStats {
    const rows = this.db
      .prepare(
        `SELECT signal_type, pnl_dollars, pnl_r, status FROM trades
         WHERE opened_at >= ? AND opened_at < ? AND status IN ('WIN','LOSS','BE')`,
      )
      .all(isoWeekStart, isoWeekEnd) as Array<{
      signal_type: string;
      pnl_dollars: number | null;
      pnl_r: number | null;
      status: string;
    }>;
    return this.aggregateWeekly(weekLabel, rows);
  }

  dailyStats(isoDayStart: string, isoDayEnd: string, dayLabel: string): DailyStats {
    const rows = this.db
      .prepare(
        `SELECT pnl_dollars, pnl_r, status FROM trades
         WHERE opened_at >= ? AND opened_at < ? AND status IN ('WIN','LOSS','BE')`,
      )
      .all(isoDayStart, isoDayEnd) as Array<{
      pnl_dollars: number | null;
      pnl_r: number | null;
      status: string;
    }>;
    const wins = rows.filter((r) => r.status === 'WIN').length;
    const losses = rows.filter((r) => r.status === 'LOSS').length;
    const netPnl = rows.reduce((s, r) => s + (r.pnl_dollars ?? 0), 0);
    const avgR = rows.length ? rows.reduce((s, r) => s + (r.pnl_r ?? 0), 0) / rows.length : 0;
    return {
      date: dayLabel,
      tradeCount: rows.length,
      wins,
      losses,
      winRate: rows.length ? wins / rows.length : 0,
      netPnl,
      avgR,
    };
  }

  private aggregateWeekly(
    weekLabel: string,
    rows: Array<{ signal_type: string; pnl_dollars: number | null; pnl_r: number | null; status: string }>,
  ): WeeklyStats {
    const wins = rows.filter((r) => r.status === 'WIN').length;
    const losses = rows.filter((r) => r.status === 'LOSS').length;
    const netPnl = rows.reduce((s, r) => s + (r.pnl_dollars ?? 0), 0);
    const avgR = rows.length ? rows.reduce((s, r) => s + (r.pnl_r ?? 0), 0) / rows.length : 0;

    const bySetup = new Map<string, number>();
    for (const r of rows) {
      bySetup.set(r.signal_type, (bySetup.get(r.signal_type) ?? 0) + (r.pnl_dollars ?? 0));
    }
    let bestSetup = '-';
    let worstSetup = '-';
    let best = -Infinity;
    let worst = Infinity;
    for (const [setup, pnl] of bySetup) {
      if (pnl > best) {
        best = pnl;
        bestSetup = setup;
      }
      if (pnl < worst) {
        worst = pnl;
        worstSetup = setup;
      }
    }

    return {
      week: weekLabel,
      tradeCount: rows.length,
      wins,
      losses,
      winRate: rows.length ? wins / rows.length : 0,
      netPnl,
      avgR,
      bestSetup,
      worstSetup,
    };
  }

  // ── Row mapping ──────────────────────────────────────────────────────────────

  private toRow(t: BotTrade): TradeRow {
    return {
      id: t.id,
      opened_at: t.openTime,
      closed_at: t.closeTime,
      direction: t.direction,
      signal_type: t.signalType,
      grade: t.grade,
      score: t.score,
      entry: t.entry,
      stop: t.stop,
      target: t.target,
      contracts: t.contracts,
      risk_dollars: t.riskDollars,
      target_dollars: t.targetDollars,
      close_price: t.closePrice,
      pnl_dollars: t.pnl,
      pnl_r: t.pnlR,
      status: t.status,
      reject_reason: t.rejectReason,
      es_confirmed: t.esConfirmed ? 1 : 0,
      signal_json: JSON.stringify(t.signal),
    };
  }

  private fromRow(r: TradeRow): BotTrade {
    return {
      id: r.id,
      direction: r.direction as BotTrade['direction'],
      signalType: r.signal_type as BotTrade['signalType'],
      grade: r.grade as BotTrade['grade'],
      score: r.score,
      entry: r.entry,
      stop: r.stop,
      target: r.target,
      contracts: r.contracts,
      riskDollars: r.risk_dollars,
      targetDollars: r.target_dollars,
      actualRR: r.stop !== r.entry ? Math.abs(r.target - r.entry) / Math.abs(r.entry - r.stop) : 0,
      status: r.status as BotTrade['status'],
      openTime: r.opened_at,
      closeTime: r.closed_at,
      closePrice: r.close_price,
      pnl: r.pnl_dollars,
      pnlR: r.pnl_r,
      esConfirmed: r.es_confirmed === 1,
      rejectReason: r.reject_reason,
      orderId: null,
      signal: JSON.parse(r.signal_json) as BotTrade['signal'],
    };
  }

  close(): void {
    this.db.close();
  }
}
