/**
 * Weekly report — aggregates the current (or a given) trading week in ET,
 * with the week starting Monday.
 */

import { DateTime } from 'luxon';
import type { BotDatabase } from '../storage/database';
import type { WeeklyStats } from '../types';

const ZONE = 'America/New_York';

export function weeklyReport(db: BotDatabase, ref: Date = new Date()): WeeklyStats {
  const dt = DateTime.fromJSDate(ref, { zone: ZONE });
  const start = dt.startOf('week'); // luxon week starts Monday
  const end = start.plus({ weeks: 1 });
  const label = `${start.toFormat('kkkk')}-W${start.toFormat('WW')}`;
  return db.weeklyStats(start.toUTC().toISO()!, end.toUTC().toISO()!, label);
}

/** ISO start of the current ET week — used for the weekly trade-count limit. */
export function currentWeekStartIso(ref: Date = new Date()): string {
  return DateTime.fromJSDate(ref, { zone: ZONE }).startOf('week').toUTC().toISO()!;
}
