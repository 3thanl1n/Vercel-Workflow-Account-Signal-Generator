import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {};

// withWorkflow compiles "use workflow" / "use step" functions into queued,
// individually retried function invocations backed by an event log.
export default withWorkflow(nextConfig);
