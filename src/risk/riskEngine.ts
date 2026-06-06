/**
 * Risk engine — FIXED model, never to be changed by learning or config.
 *
 *   Risk per trade:   $600
 *   Target per trade: $2,000  (≈ 3.33R)
 *   MNQ point value:  $2.00 / point  ($0.50 / tick, 0.25 tick size)
 *
 * Contract sizing: floor($600 / (stopPoints × $2)). Minimum 1 contract.
 */

import type { Direction } from '../engine/signalEngine';
import type { RiskModel } from '../types';

export const MNQ_POINT_VALUE = 2.0;
export const MNQ_TICK_VALUE = 0.5;
export const MNQ_TICK_SIZE = 0.25;
export const RISK_DOLLARS = 600;
export const TARGET_DOLLARS = 2000;
export const MIN_CONTRACTS = 1;

/**
 * Builds the fixed-risk model for a candidate trade.
 *
 * stopPoints   = |entry − stop|
 * contracts    = floor(RISK_DOLLARS / (stopPoints × MNQ_POINT_VALUE))
 * actualRisk   = contracts × stopPoints × MNQ_POINT_VALUE
 * targetPoints = TARGET_DOLLARS / (contracts × MNQ_POINT_VALUE)
 * target       = LONG ? entry + targetPoints : entry − targetPoints
 * rr           = targetPoints / stopPoints
 * valid        = contracts >= MIN_CONTRACTS
 */
export function calcRiskModel(
  entry: number,
  stop: number,
  direction: Direction,
): RiskModel {
  const stopPoints = Math.abs(entry - stop);

  if (!Number.isFinite(stopPoints) || stopPoints <= 0) {
    return {
      entry,
      stop,
      target: entry,
      contracts: 0,
      riskDollars: 0,
      targetDollars: 0,
      stopPoints,
      targetPoints: 0,
      rr: 0,
      valid: false,
      reason: 'INVALID_STOP_DISTANCE',
    };
  }

  const riskPerContract = stopPoints * MNQ_POINT_VALUE;
  const contracts = Math.floor(RISK_DOLLARS / riskPerContract);

  if (contracts < MIN_CONTRACTS) {
    return {
      entry,
      stop,
      target: entry,
      contracts,
      riskDollars: 0,
      targetDollars: 0,
      stopPoints,
      targetPoints: 0,
      rr: 0,
      valid: false,
      reason: `STOP_TOO_WIDE: ${stopPoints.toFixed(2)}pts needs >$${RISK_DOLLARS} for 1 contract`,
    };
  }

  const actualRisk = contracts * stopPoints * MNQ_POINT_VALUE;
  const targetPoints = TARGET_DOLLARS / (contracts * MNQ_POINT_VALUE);
  const target =
    direction === 'LONG' ? entry + targetPoints : entry - targetPoints;
  const rr = targetPoints / stopPoints;

  return {
    entry,
    stop,
    target,
    contracts,
    riskDollars: actualRisk,
    targetDollars: TARGET_DOLLARS,
    stopPoints,
    targetPoints,
    rr,
    valid: true,
    reason: 'OK',
  };
}

/**
 * Dollar P&L for a closed trade given the exit price.
 * Positive when the move went in the trade's favor.
 */
export function calcPnl(
  entry: number,
  exit: number,
  contracts: number,
  direction: Direction,
): number {
  const points = direction === 'LONG' ? exit - entry : entry - exit;
  return points * MNQ_POINT_VALUE * contracts;
}

/**
 * Realized R multiple for a closed trade.
 */
export function calcPnlR(pnl: number, riskDollars: number): number {
  if (riskDollars <= 0) return 0;
  return pnl / riskDollars;
}
