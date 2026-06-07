/**
 * Signal engine — evaluates MNQ futures market structure and emits tradable
 * signals. Single source of truth for all signal logic used by the bot and
 * backtest. Bot-specific overrides (min score 80, NY Open window) are applied
 * by evaluateForBot() at the bottom of this file.
 *
 * Scoring model (0–100):
 *   Trend alignment  (EMA 9/21 on 1m + 5m)  — up to 30 pts
 *   VWAP position                             — up to 20 pts
 *   Momentum (rate-of-change)                 — up to 20 pts
 *   ES breadth confirmation                   — up to 20 pts
 *   Structure (higher-lows / lower-highs)     — up to 10 pts
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type Direction = 'LONG' | 'SHORT';

export type SignalType =
  | 'BULL_FLAG'
  | 'BEAR_FLAG'
  | 'BREAKOUT_LONG'
  | 'BREAKOUT_SHORT'
  | 'VWAP_BOUNCE_LONG'
  | 'VWAP_BOUNCE_SHORT'
  | 'PULLBACK_LONG'
  | 'PULLBACK_SHORT'
  | 'MOMENTUM_LONG'
  | 'MOMENTUM_SHORT';

export type Grade = 'A+' | 'A' | 'B' | 'C';

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number | string | Date;
}

export interface EsConfirm {
  confirmed: boolean;
  aboveVwap: boolean;
  emaAligned: boolean;
  htfAligned: boolean;
  structure: boolean;
  momentum: boolean;
}

export interface Signal {
  direction: Direction;
  signalType: SignalType;
  grade: Grade;
  score: number;
  entry: number;
  sl: number;
  target: number;
  atr: number;
  adx: number;
  fingerprint: string;
  esConfirm: EsConfirm | null;
}

export interface LearningWeights {
  mnqMinScore: number;
  trendWeight: number;
  vwapWeight: number;
  momentumWeight: number;
  breadthWeight: number;
  structureWeight: number;
}

export const DEFAULT_LEARNING_WEIGHTS: LearningWeights = {
  mnqMinScore: 70,
  trendWeight: 1.0,
  vwapWeight: 1.0,
  momentumWeight: 1.0,
  breadthWeight: 1.0,
  structureWeight: 1.0,
};

export interface EvaluationParams {
  instrument: string;
  bars: OHLCV[];
  bars5m: OHLCV[];
  esBars: OHLCV[];
  es5mBars: OHLCV[];
  nqBars: OHLCV[];
  timestamp: Date;
  learningWeights?: Partial<LearningWeights>;
}

export interface EvaluationResult {
  signal: Signal | null;
  rejectReasons: string[];
  score: number;
  direction: Direction | null;
}

// ── Utility ───────────────────────────────────────────────────────────────────

export function getEtHhmm(ts: Date): number {
  const etStr = ts.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hh, mm] = etStr.split(':').map(Number);
  return (isNaN(hh) ? 0 : hh) * 100 + (isNaN(mm) ? 0 : mm);
}

function getEtDay(ts: Date): string {
  return ts.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
}

function isWeekday(ts: Date): boolean {
  const day = getEtDay(ts);
  return day !== 'Sat' && day !== 'Sun';
}

export function isMarketOpen(ts: Date): { open: boolean } {
  if (!isWeekday(ts)) return { open: false };
  const hhmm = getEtHhmm(ts);
  // Allow bot to start 10 minutes early (9:20 ET) so it can warm up data before the 9:30 window
  return { open: hhmm >= 920 && hhmm < 1600 };
}

// ── Technical indicators ──────────────────────────────────────────────────────

function ema(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  const k = 2 / (period + 1);
  let val = closes[0];
  for (let i = 1; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function atr(bars: OHLCV[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function vwap(bars: OHLCV[]): number {
  let cumPV = 0;
  let cumVol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 1;
    cumPV += tp * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumPV / cumVol : 0;
}

function adx(bars: OHLCV[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const slice = bars.slice(-(period + 1));
  let plusDm = 0;
  let minusDm = 0;
  let tr = 0;
  for (let i = 1; i < slice.length; i++) {
    const up = slice[i].high - slice[i - 1].high;
    const down = slice[i - 1].low - slice[i].low;
    if (up > down && up > 0) plusDm += up;
    if (down > up && down > 0) minusDm += down;
    tr += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
  }
  if (tr === 0) return 0;
  const di_plus = 100 * (plusDm / tr);
  const di_minus = 100 * (minusDm / tr);
  const sum = di_plus + di_minus;
  return sum === 0 ? 0 : Math.min(100, Math.abs(di_plus - di_minus) / sum * 100);
}

function makeFingerprint(ts: Date, direction: Direction, signalType: SignalType): string {
  return `${ts.getFullYear()}-${ts.getMonth()}-${ts.getDate()}-${ts.getHours()}-${ts.getMinutes()}-${direction}-${signalType}`;
}

function gradeFromScore(score: number): Grade {
  if (score >= 92) return 'A+';
  if (score >= 82) return 'A';
  if (score >= 72) return 'B';
  return 'C';
}

// ── ES breadth ────────────────────────────────────────────────────────────────

function evalEsBreadth(esBars: OHLCV[], es5m: OHLCV[], direction: Direction): EsConfirm {
  const closes1m = esBars.map((b) => b.close);
  const closes5m = es5m.map((b) => b.close);
  const esVwap = vwap(esBars.slice(-60));
  const lastEs = esBars[esBars.length - 1]?.close ?? 0;

  const aboveVwap = direction === 'LONG' ? lastEs > esVwap : lastEs < esVwap;
  const ema9_1m = ema(closes1m, 9);
  const ema21_1m = ema(closes1m, 21);
  const emaAligned = direction === 'LONG' ? ema9_1m > ema21_1m : ema9_1m < ema21_1m;
  const ema9_5m = ema(closes5m, 9);
  const ema21_5m = ema(closes5m, 21);
  const htfAligned = direction === 'LONG' ? ema9_5m > ema21_5m : ema9_5m < ema21_5m;

  const recent = esBars.slice(-5);
  const structure =
    direction === 'LONG'
      ? recent[recent.length - 1].close > recent[0].close
      : recent[recent.length - 1].close < recent[0].close;

  const roc =
    closes1m.length >= 10
      ? (closes1m[closes1m.length - 1] - closes1m[closes1m.length - 10]) /
        closes1m[closes1m.length - 10]
      : 0;
  const momentum = direction === 'LONG' ? roc > 0 : roc < 0;

  const confirmed = aboveVwap && emaAligned && (htfAligned || structure);
  return { confirmed, aboveVwap, emaAligned, htfAligned, structure, momentum };
}

// ── Core evaluate ─────────────────────────────────────────────────────────────

export function evaluate(params: EvaluationParams): EvaluationResult {
  const weights: LearningWeights = { ...DEFAULT_LEARNING_WEIGHTS, ...params.learningWeights };
  const rejectReasons: string[] = [];
  const { bars, bars5m, esBars, es5mBars, timestamp } = params;
  const MIN_BARS = 30;

  if (bars.length < MIN_BARS) {
    rejectReasons.push('INSUFFICIENT_BARS');
    return { signal: null, rejectReasons, score: 0, direction: null };
  }

  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];

  const ema9_1m = ema(closes, 9);
  const ema21_1m = ema(closes, 21);
  const closes5m = bars5m.map((b) => b.close);
  const ema9_5m = bars5m.length >= 9 ? ema(closes5m, 9) : ema9_1m;
  const ema21_5m = bars5m.length >= 21 ? ema(closes5m, 21) : ema21_1m;

  const trendLong = ema9_1m > ema21_1m && ema9_5m > ema21_5m;
  const trendShort = ema9_1m < ema21_1m && ema9_5m < ema21_5m;
  if (!trendLong && !trendShort) {
    rejectReasons.push('NO_TREND');
    return { signal: null, rejectReasons, score: 0, direction: null };
  }
  const direction: Direction = trendLong ? 'LONG' : 'SHORT';

  let score = 0;

  const trendStrength = Math.min(30, (Math.abs(ema9_1m - ema21_1m) / (ema21_1m || 1)) * 5000);
  score += trendStrength * weights.trendWeight;

  const dayBars = bars.slice(-390);
  const v = vwap(dayBars);
  const aboveVwap = last.close > v;
  if ((direction === 'LONG' && aboveVwap) || (direction === 'SHORT' && !aboveVwap)) {
    const dist = Math.abs(last.close - v) / (v || 1);
    score += Math.min(20, 10 + dist * 2000) * weights.vwapWeight;
  }

  if (closes.length >= 10) {
    const roc =
      (closes[closes.length - 1] - closes[closes.length - 10]) /
      (closes[closes.length - 10] || 1);
    const rocAligned = direction === 'LONG' ? roc > 0 : roc < 0;
    if (rocAligned) score += Math.min(20, Math.abs(roc) * 10000) * weights.momentumWeight;
  }

  const esConfirm = esBars.length >= 10 ? evalEsBreadth(esBars, es5mBars, direction) : null;
  if (esConfirm?.confirmed) score += 20 * weights.breadthWeight;
  else if (esConfirm) score += 5 * weights.breadthWeight;

  const recent = bars.slice(-5);
  const structOk =
    direction === 'LONG'
      ? recent[recent.length - 1].close > recent[0].close
      : recent[recent.length - 1].close < recent[0].close;
  if (structOk) score += 10 * weights.structureWeight;

  score = Math.min(100, Math.round(score));

  if (score < weights.mnqMinScore) {
    rejectReasons.push(`SCORE_BELOW_MIN: ${score} < ${weights.mnqMinScore}`);
    return { signal: null, rejectReasons, score, direction };
  }

  const atrVal = atr(bars);
  const adxVal = adx(bars);
  let signalType: SignalType;
  if (adxVal > 25) {
    signalType = direction === 'LONG' ? 'MOMENTUM_LONG' : 'MOMENTUM_SHORT';
  } else if (aboveVwap === direction === 'LONG') {
    signalType = direction === 'LONG' ? 'VWAP_BOUNCE_LONG' : 'VWAP_BOUNCE_SHORT';
  } else {
    signalType = direction === 'LONG' ? 'PULLBACK_LONG' : 'PULLBACK_SHORT';
  }

  const entry = last.close;
  const slDistance = Math.max(atrVal * 1.5, 4);
  const sl = direction === 'LONG' ? entry - slDistance : entry + slDistance;
  const target = direction === 'LONG' ? entry + slDistance * 2 : entry - slDistance * 2;

  const signal: Signal = {
    direction,
    signalType,
    grade: gradeFromScore(score),
    score,
    entry,
    sl,
    target,
    atr: atrVal,
    adx: adxVal,
    fingerprint: makeFingerprint(timestamp, direction, signalType),
    esConfirm,
  };

  return { signal, rejectReasons, score, direction };
}

// ── Bot overrides ─────────────────────────────────────────────────────────────

export const BOT_MIN_SCORE = 80;
export const BOT_TRADING_WINDOW_START_ET_HHMM = 930;
export const BOT_TRADING_WINDOW_END_ET_HHMM = 1030;

export function isInBotTradingWindow(ts: Date): boolean {
  if (!isWeekday(ts)) return false;
  const hhmm = getEtHhmm(ts);
  return hhmm >= BOT_TRADING_WINDOW_START_ET_HHMM && hhmm < BOT_TRADING_WINDOW_END_ET_HHMM;
}

export function msUntilNextWindow(ts: Date): number {
  if (isInBotTradingWindow(ts)) return 0;
  const probe = new Date(ts.getTime());
  probe.setSeconds(0, 0);
  // Search up to 5 days ahead (covers any weekend gap)
  for (let i = 0; i < 5 * 24 * 60; i++) {
    probe.setMinutes(probe.getMinutes() + 1);
    if (isInBotTradingWindow(probe)) return probe.getTime() - ts.getTime();
  }
  return -1;
}

export interface BotEvaluationResult extends EvaluationResult {
  botTradable: boolean;
  botRejectReasons: string[];
}

export function evaluateForBot(params: EvaluationParams): BotEvaluationResult {
  const learningWeights = {
    ...DEFAULT_LEARNING_WEIGHTS,
    ...params.learningWeights,
    mnqMinScore: BOT_MIN_SCORE,
  };

  const result = evaluate({ ...params, learningWeights });
  const botRejectReasons: string[] = [];

  if (!isInBotTradingWindow(params.timestamp)) {
    botRejectReasons.push('OUTSIDE_TRADING_WINDOW');
  }

  const signal: Signal | null = result.signal;
  if (signal && signal.score < BOT_MIN_SCORE) {
    botRejectReasons.push(`BELOW_BOT_MIN_SCORE: ${signal.score} < ${BOT_MIN_SCORE}`);
  }

  const botTradable =
    signal != null &&
    signal.score >= BOT_MIN_SCORE &&
    isInBotTradingWindow(params.timestamp) &&
    botRejectReasons.length === 0;

  return { ...result, botTradable, botRejectReasons };
}
