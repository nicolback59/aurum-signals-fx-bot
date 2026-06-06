/**
 * Bot signal engine wrapper.
 *
 * The parent ../../engine/signal_engine is the Single Source of Truth for all
 * signal logic. This module re-exports it and layers two bot-specific overrides:
 *   1. BOT_MIN_SCORE = 80 (engine default is 70)
 *   2. NY Open trading window restriction (6:30–7:30 AM PT = 9:30–10:30 AM ET)
 *
 * No signal math is implemented here. evaluateForBot() delegates to evaluate().
 */

import {
  evaluate,
  getEtHhmm,
  DEFAULT_LEARNING_WEIGHTS,
} from '../../../engine/signal_engine';

import type {
  EvaluationParams,
  EvaluationResult,
  Signal,
} from '../../../engine/signal_engine';

export * from '../../../engine/signal_engine';

// ── Bot overrides ─────────────────────────────────────────────────────────────

export const BOT_MIN_SCORE = 80;

/** 9:30 AM ET (= 6:30 AM PT) as hhmm integer. */
export const BOT_TRADING_WINDOW_START_ET_HHMM = 930;

/** 10:30 AM ET (= 7:30 AM PT) as hhmm integer. */
export const BOT_TRADING_WINDOW_END_ET_HHMM = 1030;

/**
 * Returns true when ts falls inside the NY Open trading window
 * (9:30:00 AM ET inclusive to 10:30:00 AM ET exclusive).
 */
export function isInBotTradingWindow(ts: Date): boolean {
  const hhmm = getEtHhmm(ts);
  return (
    hhmm >= BOT_TRADING_WINDOW_START_ET_HHMM &&
    hhmm < BOT_TRADING_WINDOW_END_ET_HHMM
  );
}

/**
 * Milliseconds until the next trading-window open. Returns 0 when the window
 * is currently open. Used by the UI countdown.
 */
export function msUntilNextWindow(ts: Date): number {
  if (isInBotTradingWindow(ts)) return 0;

  // Step forward minute-by-minute up to 8 days to find the next open minute.
  // Cheap and robust against DST without re-implementing tz math.
  const probe = new Date(ts.getTime());
  probe.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    probe.setMinutes(probe.getMinutes() + 1);
    if (isInBotTradingWindow(probe)) {
      return probe.getTime() - ts.getTime();
    }
  }
  return -1;
}

export interface BotEvaluationResult extends EvaluationResult {
  /** True when a signal exists, scores >= 80, and we are inside the window. */
  botTradable: boolean;
  /** Reasons the bot rejected an otherwise-valid engine signal. */
  botRejectReasons: string[];
}

/**
 * Evaluates a signal through the SSOT engine, then applies the bot's stricter
 * minimum-score gate and the NY-Open trading-window restriction.
 *
 * The engine's own minScore is forced to BOT_MIN_SCORE so the engine itself
 * rejects sub-80 signals; we additionally re-check here for defense in depth.
 */
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

  return {
    ...result,
    botTradable,
    botRejectReasons,
  };
}
