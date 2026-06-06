import type {
  Direction,
  SignalType,
  Grade,
  Signal,
  OHLCV,
} from '../engine/signalEngine';

// ── Bot lifecycle state ───────────────────────────────────────────────────────

export type BotRunState = 'running' | 'stopped' | 'error' | 'connecting';

export type TradeStatus = 'OPEN' | 'WIN' | 'LOSS' | 'BE' | 'CANCELLED' | 'REJECTED';

// ── Config (sourced from env vars) ────────────────────────────────────────────

export interface BotConfig {
  ibHost: string;
  ibPort: number;
  ibClientId: number;
  ibAccount: string;
  paperTrading: boolean;
  minScore: number;
  maxTradesPerWeek: number;
  riskDollars: number;
  targetDollars: number;
  disableAutoExecute: boolean;
}

// ── Risk model ────────────────────────────────────────────────────────────────

export interface RiskModel {
  entry: number;
  stop: number;
  target: number;
  contracts: number;
  riskDollars: number;
  targetDollars: number;
  stopPoints: number;
  targetPoints: number;
  rr: number;
  valid: boolean;
  reason: string;
}

// ── Trade record ──────────────────────────────────────────────────────────────

export interface BotTrade {
  id: string;
  direction: Direction;
  signalType: SignalType;
  grade: Grade;
  score: number;
  entry: number;
  stop: number;
  target: number;
  contracts: number;
  riskDollars: number;
  targetDollars: number;
  actualRR: number;
  status: TradeStatus;
  openTime: string | null;
  closeTime: string | null;
  closePrice: number | null;
  pnl: number | null;
  pnlR: number | null;
  esConfirmed: boolean;
  rejectReason: string | null;
  orderId: string | null;
  signal: Signal;
}

// ── Safety ────────────────────────────────────────────────────────────────────

export interface SafetyCheck {
  name: string;
  passed: boolean;
  reason: string;
}

export interface SafetyResult {
  allPassed: boolean;
  checks: SafetyCheck[];
  blockedBy?: string;
}

export interface SafetyContext {
  botEnabled: boolean;
  apiConnected: boolean;
  now: Date;
  weeklyTradeCount: number;
  maxTradesPerWeek: number;
  score: number;
  minScore: number;
  esConfirmed: boolean;
  riskModel: RiskModel | null;
  marketDataAgeMs: number;
  hasOpenTrade: boolean;
  atr: number;
  adx: number;
  fingerprint: string;
  recentFingerprints: Array<{ fingerprint: string; ts: number }>;
}

// ── Market data ───────────────────────────────────────────────────────────────

export interface MarketDataState {
  mnqBars: OHLCV[];
  esBars: OHLCV[];
  nqBars: OHLCV[];
  mnq5mBars: OHLCV[];
  es5mBars: OHLCV[];
  lastUpdate: number;
  isStale: boolean;
}

// ── Bias display ──────────────────────────────────────────────────────────────

export type BiasLabel = 'BULL' | 'BEAR' | 'NEUTRAL';

export interface BiasState {
  esBias: BiasLabel;
  mnqBias: BiasLabel;
}

// ── Signal evaluation snapshot for UI ─────────────────────────────────────────

export interface SignalSnapshot {
  hasSignal: boolean;
  score: number;
  grade: Grade | null;
  signalType: SignalType | null;
  direction: Direction | null;
  esConfirmed: boolean;
  esChecks: {
    aboveVwap: boolean;
    emaAligned: boolean;
    htfAligned: boolean;
    structure: boolean;
    momentum: boolean;
  } | null;
  rejectReasons: string[];
  evaluatedAt: string;
}

// ── Aggregate bot state pushed to renderer ────────────────────────────────────

export interface BotState {
  runState: BotRunState;
  apiConnected: boolean;
  marketOpen: boolean;
  inTradingWindow: boolean;
  nextWindowMs: number | null;
  weeklyTradeCount: number;
  maxTradesPerWeek: number;
  bias: BiasState;
  signal: SignalSnapshot | null;
  openTrade: BotTrade | null;
  lastError: string | null;
  lastUpdate: string;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

export interface WeeklyStats {
  week: string;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  avgR: number;
  bestSetup: string;
  worstSetup: string;
}

export interface DailyStats {
  date: string;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  avgR: number;
}

// ── Backtest ──────────────────────────────────────────────────────────────────

export type BacktestPeriod = 90 | 180 | 365;

export interface BacktestSetupStats {
  setup: SignalType;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  avgR: number;
}

export interface BacktestResult {
  period: BacktestPeriod;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  avgR: number;
  totalPnl: number;
  bySetup: BacktestSetupStats[];
}

// ── Broker primitives ─────────────────────────────────────────────────────────

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h';

export interface OrderRequest {
  symbol: string;
  direction: Direction;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  bracket: boolean;
}

export interface OrderResult {
  orderId: string;
  parentOrderId: string;
  stopOrderId: string;
  targetOrderId: string;
  status: string;
}

export interface Order {
  orderId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  orderType: string;
  status: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgCost: number;
  marketValue: number;
  unrealizedPnl: number;
}

// ── Execution result ──────────────────────────────────────────────────────────

export interface ExecutionResult {
  executed: boolean;
  trade?: BotTrade;
  orderId?: string;
  reason?: string;
  safety?: SafetyResult;
}

// ── System log entry ──────────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE';

export interface SystemLogEntry {
  id?: number;
  ts: string;
  level: LogLevel;
  message: string;
  data?: string;
}
