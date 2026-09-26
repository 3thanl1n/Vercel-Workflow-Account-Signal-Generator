import { start } from "workflow/api";
import { z } from "zod";
import { hasBearerSecret } from "@/lib/auth";
import { isIsoDay, todayUtc } from "@/lib/dates";
import { dailySignals } from "@/workflows/daily-signals";

const Body = z.object({
  day: z
    .string()
    .refine(isIsoDay, "day must be YYYY-MM-DD")
    .refine((day) => day <= todayUtc(), "day can't be in the future")
    .optional(),
});

// Manual trigger for extra runs. Optional JSON body: { "day": "YYYY-MM-DD" } (defaults to today, UTC).
// start() queues the run and returns its ID right away; the work happens in the background.
export async function POST(request: Request) {
  if (!hasBearerSecret(request, process.env.RUN_NOW_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const text = await request.text();
  const parsed = Body.safeParse(text ? safeJson(text) : {});
  if (!parsed.success) {
    return Response.json({ error: "invalid body", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }

  const day = parsed.data.day ?? todayUtc();
  const run = await start(dailySignals, [{ day, trigger: "manual" }]);
  return Response.json({ runId: run.runId, day });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
