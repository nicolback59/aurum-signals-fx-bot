/**
 * System logger — structured logging to the local SQLite database and an
 * in-memory ring buffer for the UI. No raw console.log in production paths.
 */

import type { BotDatabase } from '../storage/database';
import type { LogLevel, SystemLogEntry } from '../types';

const RING_SIZE = 500;

export class SystemLogger {
  private readonly db: BotDatabase | null;
  private readonly ring: SystemLogEntry[] = [];

  constructor(db: BotDatabase | null = null) {
    this.db = db;
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    const entry: SystemLogEntry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(data !== undefined ? { data: JSON.stringify(data) } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (this.db) {
      try {
        this.db.insertLog(entry);
      } catch {
        /* never let logging crash the bot */
      }
    }
  }

  info(message: string, data?: unknown): void {
    this.write('INFO', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('WARN', message, data);
  }

  error(message: string, data?: unknown): void {
    this.write('ERROR', message, data);
  }

  trade(message: string, data?: unknown): void {
    this.write('TRADE', message, data);
  }

  recent(limit = 200): SystemLogEntry[] {
    return this.ring.slice(-limit).reverse();
  }
}
