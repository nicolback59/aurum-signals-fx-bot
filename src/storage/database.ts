/**
 * Local SQLite persistence via sql.js (pure WASM — no native compilation).
 *
 * The database is held in memory and flushed to disk after every write.
 * Initialisation is async; use BotDatabase.open(path) instead of new.
 */

import type { SqlJsStatic, Database as SqlDatabase } from 'sql.js';
import path from 'node:path';
import fs from 'node:fs';

import type { BotTrade, SystemLogEntry, WeeklyStats, DailyStats } from '../types';

// Lazily initialised sql.js runtime (shared across instances).
let _SQL: SqlJsStatic | null = null;
async function getSqlJs(): Promise<SqlJsStatic> {
  if (!_SQL) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js') as (cfg?: object) => Promise<SqlJsStatic>;
    _SQL = await initSqlJs();
  }
  return _SQL;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  private readonly db: SqlDatabase;
  private readonly dbPath: string;

  private constructor(db: SqlDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.db.exec(SCHEMA);
  }

  /** Async factory — load or create the database file at dbPath. */
  static async open(dbPath: string): Promise<BotDatabase> {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const SQL = await getSqlJs();
    const db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();

    return new BotDatabase(db, dbPath);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private save(): void {
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  /** Execute a write statement with named params (object keys are used without @ prefix). */
  private write(sql: string, params: Record<string, unknown>): void {
    const stmt = this.db.prepare(sql);
    stmt.run(this.namedParams(params));
    stmt.free();
    this.save();
  }

  /** Execute a write statement with positional params. */
  private writePos(sql: string, params: unknown[]): void {
    const stmt = this.db.prepare(sql);
    stmt.run(params as any[]);
    stmt.free();
    this.save();
  }

  /** Read a single row with positional params. */
  private readOne<T>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
    stmt.free();
    return row;
  }

  /** Read all rows with positional params. */
  private readAll<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  /** Prefix every key with @ so sql.js can match named bind params. */
  private namedParams(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[`@${k}`] = v ?? null;
    }
    return out;
  }

  // ── Trades ───────────────────────────────────────────────────────────────────

  insertTrade(t: BotTrade): void {
    this.write(
      `INSERT OR REPLACE INTO trades (
        id, opened_at, closed_at, direction, signal_type, grade, score,
        entry, stop, target, contracts, risk_dollars, target_dollars,
        close_price, pnl_dollars, pnl_r, status, reject_reason, es_confirmed, signal_json
      ) VALUES (
        @id, @opened_at, @closed_at, @direction, @signal_type, @grade, @score,
        @entry, @stop, @target, @contracts, @risk_dollars, @target_dollars,
        @close_price, @pnl_dollars, @pnl_r, @status, @reject_reason, @es_confirmed, @signal_json
      )`,
      this.toRow(t) as unknown as Record<string, unknown>,
    );
  }

  updateTradeClose(
    id: string,
    closedAt: string,
    closePrice: number,
    pnl: number,
    pnlR: number,
    status: string,
  ): void {
    this.writePos(
      `UPDATE trades SET closed_at=?, close_price=?, pnl_dollars=?, pnl_r=?, status=? WHERE id=?`,
      [closedAt, closePrice, pnl, pnlR, status, id],
    );
  }

  getTrade(id: string): BotTrade | null {
    const row = this.readOne<TradeRow>(`SELECT * FROM trades WHERE id=?`, [id]);
    return row ? this.fromRow(row) : null;
  }

  getOpenTrade(): BotTrade | null {
    const row = this.readOne<TradeRow>(
      `SELECT * FROM trades WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1`,
    );
    return row ? this.fromRow(row) : null;
  }

  listTrades(limit = 500): BotTrade[] {
    const rows = this.readAll<TradeRow>(
      `SELECT * FROM trades ORDER BY COALESCE(opened_at, '') DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => this.fromRow(r));
  }

  countTradesSince(isoStart: string): number {
    const row = this.readOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trades WHERE opened_at >= ? AND status != 'REJECTED'`,
      [isoStart],
    );
    return row?.n ?? 0;
  }

  // ── Logs ─────────────────────────────────────────────────────────────────────

  insertLog(entry: SystemLogEntry): void {
    this.writePos(
      `INSERT INTO system_logs (ts, level, message, data) VALUES (?,?,?,?)`,
      [entry.ts, entry.level, entry.message, entry.data ?? null],
    );
  }

  listLogs(limit = 300): SystemLogEntry[] {
    return this.readAll<SystemLogEntry>(
      `SELECT id, ts, level, message, data FROM system_logs ORDER BY id DESC LIMIT ?`,
      [limit],
    );
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
    this.writePos(
      `INSERT INTO rejected_signals (ts, score, grade, signal_type, direction, reject_reasons, fingerprint)
       VALUES (?,?,?,?,?,?,?)`,
      [args.ts, args.score, args.grade, args.signalType, args.direction, args.rejectReasons, args.fingerprint],
    );
  }

  // ── Aggregates ───────────────────────────────────────────────────────────────

  weeklyStats(isoWeekStart: string, isoWeekEnd: string, weekLabel: string): WeeklyStats {
    const rows = this.readAll<{ signal_type: string; pnl_dollars: number | null; pnl_r: number | null; status: string }>(
      `SELECT signal_type, pnl_dollars, pnl_r, status FROM trades
       WHERE opened_at >= ? AND opened_at < ? AND status IN ('WIN','LOSS','BE')`,
      [isoWeekStart, isoWeekEnd],
    );
    return this.aggregateWeekly(weekLabel, rows);
  }

  dailyStats(isoDayStart: string, isoDayEnd: string, dayLabel: string): DailyStats {
    const rows = this.readAll<{ pnl_dollars: number | null; pnl_r: number | null; status: string }>(
      `SELECT pnl_dollars, pnl_r, status FROM trades
       WHERE opened_at >= ? AND opened_at < ? AND status IN ('WIN','LOSS','BE')`,
      [isoDayStart, isoDayEnd],
    );
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
      if (pnl > best) { best = pnl; bestSetup = setup; }
      if (pnl < worst) { worst = pnl; worstSetup = setup; }
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

  // ── Auth ─────────────────────────────────────────────────────────────────────

  initDefaultUser(): void {
    const exists = this.readOne<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE username='admin'`);
    if (!exists || exists.n === 0) {
      // Default: admin / admin (SHA-256 hex of "admin")
      const hash = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';
      this.writePos(`INSERT INTO users (username, password_hash) VALUES ('admin', ?)`, [hash]);
    }
  }

  verifyUser(username: string, passwordHash: string): boolean {
    const row = this.readOne<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE username=?`,
      [username],
    );
    return row?.password_hash === passwordHash;
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.readOne<{ value: string }>(`SELECT value FROM settings WHERE key=?`, [key]);
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.writePos(`INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)`, [key, value]);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.readAll<{ key: string; value: string }>(`SELECT key, value FROM settings`);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  close(): void {
    this.save();
    this.db.close();
  }
}
