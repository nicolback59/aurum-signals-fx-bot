/**
 * Safety controller — the hard pre-trade checklist.
 *
 * Every check is a structured SafetyCheck. A trade may only be placed when
 * EVERY check passes. The first failing check populates blockedBy.
 *
 * These rules are non-negotiable and are not adjustable by the learning layer.
 */

import type { SafetyCheck, SafetyContext, SafetyResult } from '../types';
import { isInBotTradingWindow } from '../engine/signalEngine';

const MARKET_DATA_MAX_AGE_MS = 30_000;
const DUPLICATE_COOLDOWN_MS = 15 * 60 * 1000;
const ATR_MIN = 18;
const ADX_MIN = 16;

function check(name: string, passed: boolean, reason: string): SafetyCheck {
  return { name, passed, reason };
}

/**
 * Runs the full pre-trade safety checklist in fixed order.
 */
export function runChecklist(ctx: SafetyContext): SafetyResult {
  const checks: SafetyCheck[] = [];

  // 1. Bot enabled
  checks.push(
    check(
      'BOT_ENABLED',
      ctx.botEnabled,
      ctx.botEnabled ? 'Bot is enabled' : 'Bot is disabled',
    ),
  );

  // 2. API connected
  checks.push(
    check(
      'API_CONNECTED',
      ctx.apiConnected,
      ctx.apiConnected ? 'Broker API connected' : 'Broker API disconnected',
    ),
  );

  // 3. Within NY Open window (6:30–7:30 AM PT)
  const inWindow = isInBotTradingWindow(ctx.now);
  checks.push(
    check(
      'TRADING_WINDOW',
      inWindow,
      inWindow ? 'Inside NY Open window' : 'Outside NY Open window (6:30-7:30 AM PT)',
    ),
  );

  // 4. Under weekly trade limit
  const underLimit = ctx.weeklyTradeCount < ctx.maxTradesPerWeek;
  checks.push(
    check(
      'WEEKLY_LIMIT',
      underLimit,
      underLimit
        ? `Weekly trades ${ctx.weeklyTradeCount}/${ctx.maxTradesPerWeek}`
        : `Weekly limit reached ${ctx.weeklyTradeCount}/${ctx.maxTradesPerWeek}`,
    ),
  );

  // 5. Score >= minScore (80)
  const scoreOk = ctx.score >= ctx.minScore;
  checks.push(
    check(
      'SCORE_MINIMUM',
      scoreOk,
      scoreOk
        ? `Score ${ctx.score} >= ${ctx.minScore}`
        : `Score ${ctx.score} < ${ctx.minScore}`,
    ),
  );

  // 6. ES confirms
  checks.push(
    check(
      'ES_CONFIRMED',
      ctx.esConfirmed,
      ctx.esConfirmed ? 'ES confirms direction' : 'ES does not confirm',
    ),
  );

  // 7. Risk model valid (>= 1 contract at $600 risk)
  const riskValid = ctx.riskModel != null && ctx.riskModel.valid && ctx.riskModel.contracts >= 1;
  checks.push(
    check(
      'RISK_MODEL',
      riskValid,
      riskValid
        ? `Risk model valid: ${ctx.riskModel!.contracts} contract(s)`
        : `Risk model invalid: ${ctx.riskModel?.reason ?? 'NO_RISK_MODEL'}`,
    ),
  );

  // 8. Market data fresh (< 30s old)
  const dataFresh = ctx.marketDataAgeMs >= 0 && ctx.marketDataAgeMs < MARKET_DATA_MAX_AGE_MS;
  checks.push(
    check(
      'DATA_FRESH',
      dataFresh,
      dataFresh
        ? `Market data ${(ctx.marketDataAgeMs / 1000).toFixed(1)}s old`
        : `Market data stale ${(ctx.marketDataAgeMs / 1000).toFixed(1)}s (max 30s)`,
    ),
  );

  // 9. No active open trade (one at a time)
  checks.push(
    check(
      'NO_OPEN_TRADE',
      !ctx.hasOpenTrade,
      ctx.hasOpenTrade ? 'An open trade already exists' : 'No open trade',
    ),
  );

  // 10. ATR > 18
  const atrOk = ctx.atr > ATR_MIN;
  checks.push(
    check(
      'ATR_FLOOR',
      atrOk,
      atrOk ? `ATR ${ctx.atr.toFixed(2)} > ${ATR_MIN}` : `ATR ${ctx.atr.toFixed(2)} <= ${ATR_MIN}`,
    ),
  );

  // 11. ADX > 16
  const adxOk = ctx.adx > ADX_MIN;
  checks.push(
    check(
      'ADX_FLOOR',
      adxOk,
      adxOk ? `ADX ${ctx.adx.toFixed(2)} > ${ADX_MIN}` : `ADX ${ctx.adx.toFixed(2)} <= ${ADX_MIN}`,
    ),
  );

  // 12. No duplicate signal (fingerprint check, 15-min cooldown)
  const nowMs = ctx.now.getTime();
  const duplicate = ctx.recentFingerprints.some(
    (f) => f.fingerprint === ctx.fingerprint && nowMs - f.ts < DUPLICATE_COOLDOWN_MS,
  );
  checks.push(
    check(
      'NO_DUPLICATE',
      !duplicate,
      duplicate
        ? `Duplicate signal within 15-min cooldown: ${ctx.fingerprint}`
        : 'No duplicate signal',
    ),
  );

  const blockedBy = checks.find((c) => !c.passed)?.name;

  return {
    allPassed: blockedBy === undefined,
    checks,
    ...(blockedBy !== undefined ? { blockedBy } : {}),
  };
}

export const SAFETY_CONSTANTS = {
  MARKET_DATA_MAX_AGE_MS,
  DUPLICATE_COOLDOWN_MS,
  ATR_MIN,
  ADX_MIN,
} as const;
