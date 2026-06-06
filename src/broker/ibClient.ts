/**
 * Interactive Brokers TWS / IB Gateway client built on @stoqey/ib.
 *
 * Responsibilities:
 *   - Connect / reconnect (exponential backoff) to TWS on localhost:7497
 *   - Historical bars via reqHistoricalData
 *   - Real-time 5-second bars (reqRealTimeBars) aggregated to 1-minute bars
 *   - Bracket order placement (entry + stop + target) via placeOrder
 *   - Open order and position queries
 *
 * Symbol mapping: MNQ / ES / NQ resolve to their front-month CME futures.
 * The @stoqey/ib API surface can vary by version; calls below follow the
 * documented event/request model and degrade gracefully when an event is
 * not received within a timeout.
 */

import {
  IBApi,
  EventName,
  Contract,
  Order as IBOrder,
  OrderAction,
  OrderType,
  SecType,
  BarSizeSetting,
} from '@stoqey/ib';

import type { OHLCV } from '../engine/signalEngine';
import type {
  Timeframe,
  OrderRequest,
  OrderResult,
  Order,
  Position,
} from '../types';
import type { IBrokerClient } from './IBrokerClient';
import type { SystemLogger } from '../logging/systemLogger';

interface RealtimeSub {
  symbol: string;
  reqId: number;
  callback: (bar: OHLCV) => void;
  fiveSecBuffer: OHLCV[];
  currentMinute: number;
}

const TIMEFRAME_TO_BARSIZE: Record<Timeframe, BarSizeSetting> = {
  '1m': BarSizeSetting.MINUTES_ONE,
  '5m': BarSizeSetting.MINUTES_FIVE,
  '15m': BarSizeSetting.MINUTES_FIFTEEN,
  '30m': BarSizeSetting.MINUTES_THIRTY,
  '1h': BarSizeSetting.HOURS_ONE,
};

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
};

export interface IBClientOptions {
  host: string;
  port: number;
  clientId: number;
  account: string;
  logger: SystemLogger;
}

export class IBClient implements IBrokerClient {
  private api: IBApi;
  private readonly opts: IBClientOptions;
  private readonly logger: SystemLogger;

  private connected = false;
  private nextReqId = 1;
  private nextOrderId = 1;
  private orderIdReady = false;

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionalDisconnect = false;

  private readonly realtimeSubs = new Map<string, RealtimeSub>();

  constructor(opts: IBClientOptions) {
    this.opts = opts;
    this.logger = opts.logger;
    this.api = new IBApi({ host: opts.host, port: opts.port });
    this.wireBaseEvents();
  }

  /**
   * @stoqey/ib types `on`/`off` with per-event listener overloads that don't
   * unify well with reusable handler closures. The runtime is a plain
   * EventEmitter, so we register through this loosely-typed view.
   */
  private get bus(): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(event: string, listener: (...args: any[]) => void): unknown;
  } {
    return this.api as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on(event: string, listener: (...args: any[]) => void): unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      off(event: string, listener: (...args: any[]) => void): unknown;
    };
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  private wireBaseEvents(): void {
    this.api.on(EventName.nextValidId, (orderId: number) => {
      this.nextOrderId = orderId;
      this.orderIdReady = true;
    });

    this.api.on(EventName.connected, () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.info('IB connected');
    });

    this.api.on(EventName.disconnected, () => {
      this.connected = false;
      this.logger.warn('IB disconnected');
      if (!this.intentionalDisconnect) this.scheduleReconnect();
    });

    this.api.on(EventName.error, (err: Error, code: number, reqId: number) => {
      // Codes 2104/2106/2158 are informational "data farm connected" messages.
      if (code === 2104 || code === 2106 || code === 2158 || code === 2108) return;
      this.logger.error(`IB error code=${code} reqId=${reqId}: ${err?.message ?? err}`);
    });
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IB connect timeout (10s)'));
      }, 10_000);

      const onReady = (): void => {
        clearTimeout(timeout);
        this.api.off(EventName.nextValidId, onReady);
        resolve();
      };

      this.api.once(EventName.nextValidId, onReady);
      try {
        this.api.connect(this.opts.clientId);
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const sub of this.realtimeSubs.values()) {
      try {
        this.api.cancelRealTimeBars(sub.reqId);
      } catch {
        /* ignore */
      }
    }
    this.realtimeSubs.clear();
    try {
      this.api.disconnect();
    } catch {
      /* ignore */
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.logger.info(`IB reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.resubscribeAll();
      } catch (e) {
        this.logger.warn(`IB reconnect failed: ${(e as Error).message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private resubscribeAll(): void {
    const subs = Array.from(this.realtimeSubs.values());
    this.realtimeSubs.clear();
    for (const sub of subs) {
      this.subscribeRealtime(sub.symbol, sub.callback);
    }
  }

  // ── Contract resolution ──────────────────────────────────────────────────────

  private resolveContract(symbol: string): Contract {
    const sym = symbol.toUpperCase();
    return {
      symbol: sym,
      secType: SecType.FUT,
      exchange: 'CME',
      currency: 'USD',
      // Front-month resolved by TWS when localSymbol/expiry omitted and
      // includeExpired is false; IB returns the nearest non-expired contract.
      includeExpired: false,
    };
  }

  private newReqId(): number {
    return this.nextReqId++;
  }

  // ── Historical bars ──────────────────────────────────────────────────────────

  getBars(symbol: string, timeframe: Timeframe, count: number): Promise<OHLCV[]> {
    if (!this.connected) return Promise.reject(new Error('IB not connected'));

    const reqId = this.newReqId();
    const contract = this.resolveContract(symbol);
    const barSize = TIMEFRAME_TO_BARSIZE[timeframe];
    const seconds = TIMEFRAME_SECONDS[timeframe] * count;
    const duration = this.durationString(seconds);

    return new Promise<OHLCV[]>((resolve, reject) => {
      const bars: OHLCV[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`getBars timeout for ${symbol} ${timeframe}`));
      }, 20_000);

      // @stoqey/ib emits historicalData per bar, then a single terminator
      // emit whose date field starts with "finished" and OHLC are -1.
      const onBar = (
        id: number,
        time: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
      ): void => {
        if (id !== reqId) return;
        if (typeof time === 'string' && time.startsWith('finished')) {
          cleanup();
          resolve(bars.slice(-count));
          return;
        }
        bars.push({
          timestamp: this.parseIBTime(time),
          open,
          high,
          low,
          close,
          volume: volume < 0 ? 0 : volume,
        });
      };

      const onErr = (err: Error, code: number, id: number): void => {
        if (id !== reqId) return;
        if (code === 2104 || code === 2106 || code === 2158) return;
        cleanup();
        reject(err);
      };

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.bus.off(EventName.historicalData, onBar);
        this.bus.off(EventName.error, onErr);
      };

      this.bus.on(EventName.historicalData, onBar);
      this.bus.on(EventName.error, onErr);

      this.api.reqHistoricalData(
        reqId,
        contract,
        '', // end now
        duration,
        barSize,
        'TRADES',
        0, // useRTH = 0 to include extended hours
        2, // formatDate = 2 → epoch seconds
        false,
      );
    });
  }

  private durationString(seconds: number): string {
    const days = Math.ceil(seconds / 86_400);
    if (days <= 1) {
      const s = Math.max(60, Math.min(seconds, 86_400));
      return `${s} S`;
    }
    if (days <= 365) return `${days} D`;
    return `${Math.ceil(days / 365)} Y`;
  }

  private parseIBTime(time: string): number {
    // formatDate=2 yields epoch seconds as a string.
    const epoch = Number(time);
    if (Number.isFinite(epoch)) return epoch * 1000;
    return new Date(time).getTime();
  }

  // ── Real-time bars (5s aggregated to 1m) ────────────────────────────────────

  subscribeRealtime(symbol: string, callback: (bar: OHLCV) => void): void {
    if (this.realtimeSubs.has(symbol)) this.unsubscribeRealtime(symbol);
    if (!this.connected) {
      this.logger.warn(`subscribeRealtime queued; IB not connected: ${symbol}`);
    }

    const reqId = this.newReqId();
    const contract = this.resolveContract(symbol);
    const sub: RealtimeSub = {
      symbol,
      reqId,
      callback,
      fiveSecBuffer: [],
      currentMinute: -1,
    };
    this.realtimeSubs.set(symbol, sub);

    const onRtBar = (
      id: number,
      time: number,
      open: number,
      high: number,
      low: number,
      close: number,
      volume: number,
    ): void => {
      if (id !== reqId) return;
      this.aggregateFiveSec(sub, {
        timestamp: time * 1000,
        open,
        high,
        low,
        close,
        volume: volume < 0 ? 0 : volume,
      });
    };

    this.bus.on(EventName.realtimeBar, onRtBar);

    try {
      this.api.reqRealTimeBars(reqId, contract, 5, 'TRADES', false);
    } catch (e) {
      this.logger.error(`reqRealTimeBars failed for ${symbol}: ${(e as Error).message}`);
    }
  }

  private aggregateFiveSec(sub: RealtimeSub, bar: OHLCV): void {
    const ms = typeof bar.timestamp === 'number' ? bar.timestamp : new Date(bar.timestamp).getTime();
    const minute = Math.floor(ms / 60_000);

    if (sub.currentMinute === -1) {
      sub.currentMinute = minute;
    }

    if (minute !== sub.currentMinute && sub.fiveSecBuffer.length > 0) {
      sub.callback(this.collapse(sub.fiveSecBuffer, sub.currentMinute * 60_000));
      sub.fiveSecBuffer = [];
      sub.currentMinute = minute;
    }

    sub.fiveSecBuffer.push(bar);
  }

  private collapse(buf: OHLCV[], minuteStartMs: number): OHLCV {
    return {
      timestamp: minuteStartMs,
      open: buf[0].open,
      high: Math.max(...buf.map((b) => b.high)),
      low: Math.min(...buf.map((b) => b.low)),
      close: buf[buf.length - 1].close,
      volume: buf.reduce((s, b) => s + (b.volume ?? 0), 0),
    };
  }

  unsubscribeRealtime(symbol: string): void {
    const sub = this.realtimeSubs.get(symbol);
    if (!sub) return;
    try {
      this.api.cancelRealTimeBars(sub.reqId);
    } catch {
      /* ignore */
    }
    this.realtimeSubs.delete(symbol);
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.connected) throw new Error('IB not connected');
    if (!this.orderIdReady) throw new Error('IB order id not ready');

    const contract = this.resolveContract(req.symbol);
    const isLong = req.direction === 'LONG';
    const entryAction = isLong ? OrderAction.BUY : OrderAction.SELL;
    const exitAction = isLong ? OrderAction.SELL : OrderAction.BUY;

    const parentId = this.nextOrderId++;
    const targetId = this.nextOrderId++;
    const stopId = this.nextOrderId++;

    const parent: IBOrder = {
      action: entryAction,
      orderType: OrderType.LMT,
      totalQuantity: req.quantity,
      lmtPrice: req.entryPrice,
      transmit: false,
      ...(this.opts.account ? { account: this.opts.account } : {}),
    };

    const takeProfit: IBOrder = {
      action: exitAction,
      orderType: OrderType.LMT,
      totalQuantity: req.quantity,
      lmtPrice: req.targetPrice,
      parentId,
      transmit: false,
      ...(this.opts.account ? { account: this.opts.account } : {}),
    };

    const stopLoss: IBOrder = {
      action: exitAction,
      orderType: OrderType.STP,
      totalQuantity: req.quantity,
      auxPrice: req.stopPrice,
      parentId,
      transmit: true, // last child transmits the whole bracket
      ...(this.opts.account ? { account: this.opts.account } : {}),
    };

    this.api.placeOrder(parentId, contract, parent);
    this.api.placeOrder(targetId, contract, takeProfit);
    this.api.placeOrder(stopId, contract, stopLoss);

    this.logger.info(
      `Bracket placed ${req.symbol} ${req.direction} qty=${req.quantity} ` +
        `entry=${req.entryPrice} stop=${req.stopPrice} target=${req.targetPrice}`,
    );

    return {
      orderId: String(parentId),
      parentOrderId: String(parentId),
      stopOrderId: String(stopId),
      targetOrderId: String(targetId),
      status: 'SUBMITTED',
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.connected) throw new Error('IB not connected');
    this.api.cancelOrder(Number(orderId));
    this.logger.info(`Order cancelled ${orderId}`);
  }

  getOpenOrders(): Promise<Order[]> {
    if (!this.connected) return Promise.reject(new Error('IB not connected'));
    return new Promise<Order[]>((resolve) => {
      const orders: Order[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        resolve(orders);
      }, 8000);

      const onOpen = (orderId: number, contract: Contract, order: IBOrder): void => {
        orders.push({
          orderId: String(orderId),
          symbol: contract.symbol ?? '',
          action: (order.action as 'BUY' | 'SELL') ?? 'BUY',
          quantity: Number(order.totalQuantity ?? 0),
          orderType: String(order.orderType ?? ''),
          status: 'OPEN',
        });
      };

      const onEnd = (): void => {
        cleanup();
        resolve(orders);
      };

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.bus.off(EventName.openOrder, onOpen);
        this.bus.off(EventName.openOrderEnd, onEnd);
      };

      this.bus.on(EventName.openOrder, onOpen);
      this.bus.on(EventName.openOrderEnd, onEnd);
      this.api.reqOpenOrders();
    });
  }

  getPositions(): Promise<Position[]> {
    if (!this.connected) return Promise.reject(new Error('IB not connected'));
    return new Promise<Position[]>((resolve) => {
      const positions: Position[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        resolve(positions);
      }, 8000);

      const onPos = (
        _account: string,
        contract: Contract,
        pos: number,
        avgCost: number,
      ): void => {
        if (pos === 0) return;
        positions.push({
          symbol: contract.symbol ?? '',
          quantity: pos,
          avgCost,
          marketValue: 0,
          unrealizedPnl: 0,
        });
      };

      const onEnd = (): void => {
        cleanup();
        resolve(positions);
      };

      const cleanup = (): void => {
        clearTimeout(timeout);
        this.bus.off(EventName.position, onPos);
        this.bus.off(EventName.positionEnd, onEnd);
      };

      this.bus.on(EventName.position, onPos);
      this.bus.on(EventName.positionEnd, onEnd);
      this.api.reqPositions();
    });
  }
}
