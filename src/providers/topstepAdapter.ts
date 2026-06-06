/**
 * Topstep ProjectX Hub REST adapter.
 *
 * Authenticates with an API key, resolves the active account and MNQ contract,
 * then delegates order placement to the ProjectX REST API.
 *
 * Real-time bars are approximated by polling getBars() every 5 s until a full
 * SignalR WebSocket integration is added.
 *
 * API base: https://gateway.topstepx.com
 */

import type { IBrokerClient } from '../broker/IBrokerClient';
import type { OHLCV } from '../engine/signalEngine';
import type { SystemLogger } from '../logging/systemLogger';
import type { Timeframe, OrderRequest, OrderResult, Order, Position } from '../types';

const BASE_URL = 'https://gateway.topstepx.com';

// Topstep bar-size codes used by retrieveBars
const TF_CODE: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
};

interface TopstepAccount {
  id: number;
  name: string;
  balance: number;
  canTrade: boolean;
}

interface TopstepContract {
  id: number;
  name: string;
  description: string;
  tickSize: number;
  tickValue: number;
}

export class TopstepAdapter implements IBrokerClient {
  private readonly apiKey: string;
  private readonly logger: SystemLogger;
  private token: string | null = null;
  private accountId: number | null = null;
  private contractCache: Map<string, number> = new Map();
  private connected = false;
  private realtimePollers: Map<string, NodeJS.Timeout> = new Map();

  constructor(apiKey: string, logger: SystemLogger) {
    this.apiKey = apiKey;
    this.logger = logger;
  }

  // ── Connection ────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // 1. Authenticate
    const auth = await this.post<{ success: boolean; token?: string; errorMessage?: string }>(
      '/api/Auth/loginKey',
      { apiKey: this.apiKey },
      false,
    );
    if (!auth.success || !auth.token) {
      throw new Error(`Topstep auth failed: ${auth.errorMessage ?? 'invalid API key'}`);
    }
    this.token = auth.token;

    // 2. Resolve active account
    const acctResp = await this.get<{ success: boolean; accounts?: TopstepAccount[]; errorMessage?: string }>(
      '/api/Account/search?onlyFavorites=false',
    );
    if (!acctResp.success || !acctResp.accounts?.length) {
      throw new Error(`Topstep account lookup failed: ${acctResp.errorMessage ?? 'no accounts'}`);
    }
    const tradable = acctResp.accounts.find((a) => a.canTrade) ?? acctResp.accounts[0];
    this.accountId = tradable.id;
    this.connected = true;
    this.logger.info(`Topstep connected — account "${tradable.name}" (id ${tradable.id})`);
  }

  async disconnect(): Promise<void> {
    for (const t of this.realtimePollers.values()) clearInterval(t);
    this.realtimePollers.clear();
    this.token = null;
    this.accountId = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.token !== null;
  }

  // ── Market data ───────────────────────────────────────────────────────────────

  async getBars(symbol: string, timeframe: Timeframe, count: number): Promise<OHLCV[]> {
    const contractId = await this.resolveContractId(symbol);
    const unit = TF_CODE[timeframe] ?? 1;
    const to = new Date().toISOString();
    const from = new Date(Date.now() - count * unit * 60 * 1000 * 2).toISOString();

    const resp = await this.get<{
      success: boolean;
      bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
      errorMessage?: string;
    }>(
      `/api/History/retrieveBars?contractId=${contractId}&unit=${unit}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${count}`,
    );

    if (!resp.success || !resp.bars) {
      this.logger.warn(`Topstep getBars failed: ${resp.errorMessage ?? 'no data'}`);
      return [];
    }

    return resp.bars.slice(-count).map((b) => ({
      time: new Date(b.t).getTime(),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  subscribeRealtime(symbol: string, callback: (bar: OHLCV) => void): void {
    if (this.realtimePollers.has(symbol)) return;
    let lastTime = 0;
    const poll = async (): Promise<void> => {
      try {
        const bars = await this.getBars(symbol, '1m', 2);
        const latest = bars[bars.length - 1];
        if (latest && latest.time !== lastTime) {
          lastTime = latest.time;
          callback(latest);
        }
      } catch {
        // polling errors are non-fatal
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
    if (!this.accountId) throw new Error('Topstep: not connected');
    const contractId = await this.resolveContractId(order.symbol);

    // ProjectX bracket order body
    const body = {
      accountId: this.accountId,
      contractId,
      action: order.direction === 'LONG' ? 0 : 1, // 0=Buy 1=Sell
      orderType: 2, // Limit
      quantity: order.quantity,
      limitPrice: order.entryPrice,
      timeInForce: 1, // Day
      brackets: [
        {
          // Stop loss (opposite side)
          action: order.direction === 'LONG' ? 1 : 0,
          orderType: 3, // StopMarket
          quantity: order.quantity,
          stopPrice: order.stopPrice,
        },
        {
          // Take profit (opposite side)
          action: order.direction === 'LONG' ? 1 : 0,
          orderType: 2, // Limit
          quantity: order.quantity,
          limitPrice: order.targetPrice,
        },
      ],
    };

    const resp = await this.post<{
      success: boolean;
      orderId?: number;
      stopOrderId?: number;
      targetOrderId?: number;
      errorMessage?: string;
    }>('/api/Order/place', body);

    if (!resp.success) {
      throw new Error(`Topstep order placement failed: ${resp.errorMessage ?? 'unknown error'}`);
    }

    const orderId = String(resp.orderId ?? 'unknown');
    this.logger.info(`Topstep order placed: ${orderId} ${order.direction} ${order.quantity}x ${order.symbol} @ ${order.entryPrice}`);

    return {
      orderId,
      parentOrderId: orderId,
      stopOrderId: String(resp.stopOrderId ?? ''),
      targetOrderId: String(resp.targetOrderId ?? ''),
      status: 'SUBMITTED',
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.accountId) throw new Error('Topstep: not connected');
    await this.post(`/api/Order/cancel`, { orderId: Number(orderId), accountId: this.accountId });
  }

  async getOpenOrders(): Promise<Order[]> {
    if (!this.accountId) return [];
    const resp = await this.get<{
      success: boolean;
      orders?: Array<{ id: number; symbol: string; action: number; quantity: number; orderType: string; status: string }>;
    }>(`/api/Order/search?accountId=${this.accountId}&status=0`);

    return (resp.orders ?? []).map((o) => ({
      orderId: String(o.id),
      symbol: o.symbol,
      action: o.action === 0 ? 'BUY' : 'SELL',
      quantity: o.quantity,
      orderType: o.orderType,
      status: o.status,
    }));
  }

  async getPositions(): Promise<Position[]> {
    if (!this.accountId) return [];
    const resp = await this.get<{
      success: boolean;
      positions?: Array<{ symbol: string; quantity: number; avgPrice: number; marketValue: number; unrealizedPnl: number }>;
    }>(`/api/Position/search?accountId=${this.accountId}`);

    return (resp.positions ?? []).map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      avgCost: p.avgPrice,
      marketValue: p.marketValue,
      unrealizedPnl: p.unrealizedPnl,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private async resolveContractId(symbol: string): Promise<number> {
    const cached = this.contractCache.get(symbol);
    if (cached) return cached;

    const resp = await this.get<{
      success: boolean;
      contracts?: TopstepContract[];
    }>(`/api/Contract/search?searchText=${encodeURIComponent(symbol)}&live=true`);

    const contract = resp.contracts?.find(
      (c) => c.name.toUpperCase().startsWith(symbol.toUpperCase()),
    );
    if (!contract) throw new Error(`Topstep: contract not found for symbol "${symbol}"`);

    this.contractCache.set(symbol, contract.id);
    return contract.id;
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`Topstep GET ${path} → ${resp.status}`);
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown, withAuth = true): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (withAuth && this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Topstep POST ${path} → ${resp.status}`);
    return resp.json() as Promise<T>;
  }
}
