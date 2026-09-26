// Fills the last 30 days of usage (default ending today, UTC). Safe to rerun:
// rows are deterministic and existing ones are skipped.
//   npm run db:backfill            -> 30 days ending today
//   npm run db:backfill 2026-09-26 -> 30 days ending that day
import { addDays, isIsoDay, todayUtc } from "@/lib/dates";
import { generateUsage } from "@/lib/usage-generator";
import { insertUsage } from "@/lib/usage-store";

const BACKFILL_DAYS = 30;
const toDay = process.argv[2] ?? todayUtc();
if (!isIsoDay(toDay)) throw new Error(`Expected YYYY-MM-DD, got ${toDay}`);

const fromDay = addDays(toDay, -(BACKFILL_DAYS - 1));
const rows = generateUsage(fromDay, toDay);
const inserted = await insertUsage(rows);
console.log(`${fromDay} to ${toDay}: generated ${rows.length} rows, inserted ${inserted} new.`);
