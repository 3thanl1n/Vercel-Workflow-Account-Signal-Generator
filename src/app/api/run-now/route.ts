import { start } from "workflow/api";
import { hasBearerSecret } from "@/lib/auth";
import { helloWorkflow } from "@/workflows/hello";

// Manual trigger for extra runs. start() queues the run and returns its ID
// right away; the work happens in the background.
export async function POST(request: Request) {
  if (!hasBearerSecret(request, process.env.RUN_NOW_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const run = await start(helloWorkflow, ["Signal Gen"]);
  return Response.json({ runId: run.runId });
}
