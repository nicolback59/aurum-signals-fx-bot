/**
 * Tradovate REST API adapter.
 *
 * Authenticates using a Tradovate access token (API key from the developer portal
 * or obtained via /auth/accesstokenrequest). Resolves the active account, fetches
 * historical MNQ bars, and places bracket orders via REST.
 *
 * Real-time bars are approximated by polling the quote endpoint every 5 s.
 *
 * Live API base:  https://live.tradovateapi.com/v1
 * Demo API base:  https://demo.tradovateapi.com/v1
 */

import type { IBrokerClient } from '../broker/IBrokerClient';
import type { OHLCV } from '../engine/signalEngine';
import type { SystemLogger } from '../logging/systemLogger';
import type { Timeframe, OrderRequest, OrderResult, Order, Position } from '../types';

const LIVE_BASE = 'https://live.tradovateapi.com/v1';
const DEMO_BASE = 'https://demo.tradovateapi.com/v1';

// Tradovate bar resolution codes (minutes)
const TF_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
};

interface TradovateAccount {
  id: number;
  name: string;
  userId: number;
  active: boolean;
}

interface TradovateContract {
  id: number;
  name: string;
  contractMaturityId: number;
}

interface TradovateQuote {
  id: number;
  contractId: number;
  timestamp: string;
  bidPrice?: number;
  askPrice?: number;
  lastPrice?: number;
  lastSize?: number;
}

export class TradovateAdapter implements IBrokerClient {
  private readonly accessToken: string;
  private readonly logger: SystemLogger;
  private readonly baseUrl: string;
  private accountId: number | null = null;
  private accountName: string | null = null;
  private contractCache: Map<string, number> = new Map();
  private connected = false;
  private realtimePollers: Map<string, NodeJS.Timeout> = new Map();
  private syntheticBars: Map<string, OHLCV[]> = new Map();

  constructor(accessToken: string, logger: SystemLogger, demo = false) {
    this.accessToken = accessToken;
    this.logger = logger;
    this.baseUrl = demo ? DEMO_BASE : LIVE_BASE;
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Verify the access token by listing accounts
    const accounts = await this.get<TradovateAccount[]>('/account/list');
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('Tradovate: no accounts found — check your access token');
    }
    const active = accounts.find((a) => a.active) ?? accounts[0];
    this.accountId = active.id;
    this.accountName = active.name;
    this.connected = true;
    this.logger.info(`Tradovate connected — account "${active.name}" (id ${active.id})`);
  }

  async disconnect(): Promise<void> {
    for (const t of this.realtimePollers.values()) clearInterval(t);
    this.realtimePollers.clear();
    this.syntheticBars.clear();
    this.accountId = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.accountId !== null;
  }

  // ── Market data ───────────────────────────────────────────────────────────────

  async getBars(symbol: string, timeframe: Timeframe, count: number): Promise<OHLCV[]> {
    const contractId = await this.resolveContractId(symbol);
    const minutes = TF_MINUTES[timeframe] ?? 1;
    const toMs = Date.now();
    const fromMs = toMs - count * minutes * 60 * 1000 * 2;

    try {
      // Tradovate historical bar endpoint
      const resp = await this.get<{
        s: string;
        t?: number[];
        o?: number[];
        h?: number[];
        l?: number[];
        c?: number[];
        v?: number[];
      }>(
        `/md/getChart?contractId=${contractId}&resolution=${minutes}&from=${Math.floor(fromMs / 1000)}&to=${Math.floor(toMs / 1000)}&count=${count}`,
      );

      if (resp.s !== 'ok' || !resp.t?.length) {
        this.logger.warn(`Tradovate getBars: empty response for ${symbol} ${timeframe}, falling back to quote`);
        return this.getBarsFromQuote(symbol, contractId, count, minutes);
      }

      const bars: OHLCV[] = resp.t.map((t, i) => ({
        time: t * 1000,
        open: resp.o?.[i] ?? 0,
        high: resp.h?.[i] ?? 0,
        low: resp.l?.[i] ?? 0,
        close: resp.c?.[i] ?? 0,
        volume: resp.v?.[i] ?? 0,
      }));

      return bars.slice(-count);
    } catch {
      // Fall back to quote-based synthetic bars if chart endpoint unavailable
      return this.getBarsFromQuote(symbol, contractId, count, minutes);
    }
  }

  private async getBarsFromQuote(
    symbol: string,
    contractId: number,
    count: number,
    _minutes: number,
  ): Promise<OHLCV[]> {
    const cached = this.syntheticBars.get(symbol) ?? [];
    if (cached.length > 0) return cached.slice(-count);

    // Build a minimal starting bar from current quote
    try {
      const quote = await this.get<TradovateQuote>(`/quote/find?name=${encodeURIComponent(symbol)}`);
      const price = quote.lastPrice ?? quote.askPrice ?? quote.bidPrice ?? 0;
      if (price > 0) {
        const now = Date.now();
        const bar: OHLCV = { time: now, open: price, high: price, low: price, close: price, volume: quote.lastSize ?? 0 };
        this.syntheticBars.set(symbol, [bar]);
        return [bar];
      }
    } catch {
      // quote unavailable — return empty
    }
    return [];
  }

  subscribeRealtime(symbol: string, callback: (bar: OHLCV) => void): void {
    if (this.realtimePollers.has(symbol)) return;

    let currentBar: OHLCV | null = null;
    let currentMinute = -1;

    const poll = async (): Promise<void> => {
      try {
        const quote = await this.get<TradovateQuote>(`/quote/find?name=${encodeURIComponent(symbol)}`);
        const price = quote.lastPrice ?? quote.askPrice ?? quote.bidPrice;
        if (!price) return;

        const now = Date.now();
        const minuteBucket = Math.floor(now / 60_000);
        const volume = quote.lastSize ?? 0;

        if (minuteBucket !== currentMinute) {
          // New 1-minute bar
          if (currentBar) {
            const bars = this.syntheticBars.get(symbol) ?? [];
            bars.push(currentBar);
            if (bars.length > 400) bars.splice(0, bars.length - 400);
            this.syntheticBars.set(symbol, bars);
            callback(currentBar);
          }
          currentBar = { time: minuteBucket * 60_000, open: price, high: price, low: price, close: price, volume };
          currentMinute = minuteBucket;
        } else if (currentBar) {
          currentBar.high = Math.max(currentBar.high, price);
          currentBar.low = Math.min(currentBar.low, price);
          currentBar.close = price;
          currentBar.volume = (currentBar.volume ?? 0) + volume;
        }
      } catch {
        // non-fatal
      }
    };

    const timer = setInterval(() => void poll(), 5_000);
    this.realtimePollers.set(symbol, timer);
  }

  unsubscribeRealtime(symbol: string): void {
    const t = this.realtimePollers.get(symbol);
    if (t) {
      clearInterval(t);
      this.realtimePollers.delete(symbol);
    }
  }

  // ── Orders ────────────────────────────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.accountId || !this.accountName) throw new Error('Tradovate: not connected');

    const body = {
      accountSpec: this.accountName,
      accountId: this.accountId,
      action: order.direction === 'LONG' ? 'Buy' : 'Sell',
      symbol: order.symbol,
      orderQty: order.quantity,
      orderType: 'Limit',
      price: order.entryPrice,
      isAutomated: true,
      bracket1: {
        action: order.direction === 'LONG' ? 'Sell' : 'Buy',
        orderType: 'Stop',
        stopPrice: order.stopPrice,
        qty: order.quantity,
      },
      bracket2: {
        action: order.direction === 'LONG' ? 'Sell' : 'Buy',
        orderType: 'Limit',
        price: order.targetPrice,
        qty: order.quantity,
      },
    };

    const resp = await this.post<{
      orderId?: number;
      failureReason?: string;
      failureText?: string;
    }>('/order/placeorder', body);

    if (!resp.orderId) {
      throw new Error(`Tradovate order failed: ${resp.failureText ?? resp.failureReason ?? 'unknown'}`);
    }

    const orderId = String(resp.orderId);
    this.logger.info(`Tradovate order placed: ${orderId} ${order.direction} ${order.quantity}x ${order.symbol} @ ${order.entryPrice}`);

    return {
      orderId,
      parentOrderId: orderId,
      stopOrderId: '',
      targetOrderId: '',
      status: 'SUBMITTED',
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.accountId || !this.accountName) throw new Error('Tradovate: not connected');
    await this.post('/order/cancelorder', {
      orderId: Number(orderId),
      accountSpec: this.accountName,
      accountId: this.accountId,
    });
  }

  async getOpenOrders(): Promise<Order[]> {
    if (!this.accountId) return [];
    const resp = await this.get<Array<{ id: number; contractId: number; action: string; orderQty: number; ordStatus: string }>>(
      `/order/list?accountId=${this.accountId}`,
    );
    return (resp ?? [])
      .filter((o) => o.ordStatus === 'Working')
      .map((o) => ({
        orderId: String(o.id),
        symbol: String(o.contractId),
        action: o.action,
        quantity: o.orderQty,
        orderType: 'Limit',
        status: o.ordStatus,
      }));
  }

  async getPositions(): Promise<Position[]> {
    if (!this.accountId) return [];
    const resp = await this.get<Array<{ contractId: number; netPos: number; netPrice: number; openPnl: number }>>(
      `/position/list?accountId=${this.accountId}`,
    );
    return (resp ?? []).map((p) => ({
      symbol: String(p.contractId),
      quantity: p.netPos,
      avgCost: p.netPrice,
      marketValue: 0,
      unrealizedPnl: p.openPnl,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private async resolveContractId(symbol: string): Promise<number> {
    const cached = this.contractCache.get(symbol);
    if (cached) return cached;

    const resp = await this.get<TradovateContract[]>(
      `/contract/suggest?t=${encodeURIComponent(symbol)}&l=1`,
    );
    const contract = Array.isArray(resp) ? resp[0] : undefined;
    if (!contract) throw new Error(`Tradovate: contract not found for symbol "${symbol}"`);

    this.contractCache.set(symbol, contract.id);
    return contract.id;
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`Tradovate GET ${path} → ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Tradovate POST ${path} → ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<T>;
  }
}
