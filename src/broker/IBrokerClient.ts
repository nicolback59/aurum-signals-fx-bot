/**
 * Broker client interface — the contract every broker adapter must satisfy.
 * The bot core depends only on this interface, never on a concrete broker.
 */

import type { OHLCV } from '../engine/signalEngine';
import type {
  Timeframe,
  OrderRequest,
  OrderResult,
  Order,
  Position,
} from '../types';

export interface IBrokerClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getBars(symbol: string, timeframe: Timeframe, count: number): Promise<OHLCV[]>;

  placeOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getOpenOrders(): Promise<Order[]>;
  getPositions(): Promise<Position[]>;

  subscribeRealtime(symbol: string, callback: (bar: OHLCV) => void): void;
  unsubscribeRealtime(symbol: string): void;
}
