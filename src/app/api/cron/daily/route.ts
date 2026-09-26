import { start } from "workflow/api";
import { hasBearerSecret } from "@/lib/auth";
import { todayUtc } from "@/lib/dates";
import { claimCronDay, releaseCronDay } from "@/lib/run-log";
import { dailySignals } from "@/workflows/daily-signals";

// Called by Vercel Cron (vercel.json), which sends `Authorization: Bearer $CRON_SECRET`.
// Cron can deliver the same schedule twice, so each day is claimed once before starting.
export async function GET(request: Request) {
  if (!hasBearerSecret(request, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const day = todayUtc();
  if (!(await claimCronDay(day))) {
    return Response.json({ skipped: true, reason: `cron already started a run for ${day}` });
  }

  try {
    const run = await start(dailySignals, [{ day, trigger: "cron" }]);
    return Response.json({ runId: run.runId, day });
  } catch (error) {
    await releaseCronDay(day);
    throw error;
  }
}
