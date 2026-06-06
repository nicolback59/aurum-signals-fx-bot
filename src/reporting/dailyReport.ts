/**
 * Daily report — aggregates the current (or a given) trading day in ET.
 */

import { DateTime } from 'luxon';
import type { BotDatabase } from '../storage/database';
import type { DailyStats } from '../types';

const ZONE = 'America/New_York';

export function dailyReport(db: BotDatabase, ref: Date = new Date()): DailyStats {
  const dt = DateTime.fromJSDate(ref, { zone: ZONE });
  const start = dt.startOf('day');
  const end = start.plus({ days: 1 });
  return db.dailyStats(
    start.toUTC().toISO()!,
    end.toUTC().toISO()!,
    start.toFormat('yyyy-LL-dd'),
  );
}
