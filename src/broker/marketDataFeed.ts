/**
 * Market data feed — maintains rolling OHLCV buffers for MNQ, ES and NQ.
 *
 * Pulls historical 1m and 5m bars from the broker on demand, subscribes to
 * real-time 1m bars (aggregated from 5s by the broker client) and appends them
 * into the rolling buffers. Reports freshness so the safety layer can block on
 * stale data.
 */

import type { OHLCV } from '../engine/signalEngine';
import type { IBrokerClient } from './IBrokerClient';
import type { MarketDataState } from '../types';
import type { SystemLogger } from '../logging/systemLogger';

const MAX_BARS = 400;
const STALE_MS = 30_000;

const SYMBOLS = ['MNQ', 'ES', 'NQ'] as const;
type Symbol = (typeof SYMBOLS)[number];

export class MarketDataFeed {
  private readonly broker: IBrokerClient;
  private readonly logger: SystemLogger;

  private readonly bars1m: Record<Symbol, OHLCV[]> = { MNQ: [], ES: [], NQ: [] };
  private readonly bars5m: Record<Symbol, OHLCV[]> = { MNQ: [], ES: [], NQ: [] };
  private lastUpdate = 0;
  private subscribed = false;

  constructor(broker: IBrokerClient, logger: SystemLogger) {
    this.broker = broker;
    this.logger = logger;
  }

  /** Loads initial historical bars for all symbols (1m and 5m). */
  async bootstrap(): Promise<void> {
    for (const sym of SYMBOLS) {
      const [b1, b5] = await Promise.all([
        this.broker.getBars(sym, '1m', MAX_BARS),
        this.broker.getBars(sym, '5m', MAX_BARS),
      ]);
      this.bars1m[sym] = b1;
      this.bars5m[sym] = b5;
    }
    this.lastUpdate = Date.now();
    this.logger.info('Market data bootstrap complete');
  }

  /** Subscribes to live 1m bars and folds them into rolling buffers. */
  subscribe(): void {
    if (this.subscribed) return;
    for (const sym of SYMBOLS) {
      this.broker.subscribeRealtime(sym, (bar) => this.onLiveBar(sym, bar));
    }
    this.subscribed = true;
  }

  unsubscribe(): void {
    if (!this.subscribed) return;
    for (const sym of SYMBOLS) this.broker.unsubscribeRealtime(sym);
    this.subscribed = false;
  }

  private onLiveBar(sym: Symbol, bar: OHLCV): void {
    this.appendBar(this.bars1m[sym], bar);
    this.foldInto5m(sym, bar);
    this.lastUpdate = Date.now();
  }

  private appendBar(buf: OHLCV[], bar: OHLCV): void {
    const lastTs = buf.length ? this.toMs(buf[buf.length - 1].timestamp) : -1;
    const ts = this.toMs(bar.timestamp);
    if (ts === lastTs) {
      buf[buf.length - 1] = bar; // replace in-progress bar
    } else {
      buf.push(bar);
      if (buf.length > MAX_BARS) buf.shift();
    }
  }

  private foldInto5m(sym: Symbol, bar: OHLCV): void {
    const buf = this.bars5m[sym];
    const ts = this.toMs(bar.timestamp);
    const bucket = Math.floor(ts / 300_000) * 300_000;
    const last = buf[buf.length - 1];
    const lastBucket = last ? Math.floor(this.toMs(last.timestamp) / 300_000) * 300_000 : -1;

    if (bucket === lastBucket && last) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume = (last.volume ?? 0) + (bar.volume ?? 0);
    } else {
      buf.push({ ...bar, timestamp: bucket });
      if (buf.length > MAX_BARS) buf.shift();
    }
  }

  /** Re-fetches historical bars (used on reconnect or periodic refresh). */
  async refresh(): Promise<void> {
    await this.bootstrap();
  }

  private toMs(ts: number | string | Date): number {
    if (typeof ts === 'number') return ts;
    if (ts instanceof Date) return ts.getTime();
    return new Date(ts).getTime();
  }

  getState(): MarketDataState {
    const age = this.lastUpdate ? Date.now() - this.lastUpdate : Number.MAX_SAFE_INTEGER;
    return {
      mnqBars: this.bars1m.MNQ,
      esBars: this.bars5m.ES,
      nqBars: this.bars1m.NQ,
      mnq5mBars: this.bars5m.MNQ,
      es5mBars: this.bars5m.ES,
      lastUpdate: this.lastUpdate,
      isStale: age >= STALE_MS,
    };
  }

  ageMs(): number {
    return this.lastUpdate ? Date.now() - this.lastUpdate : Number.MAX_SAFE_INTEGER;
  }
}
