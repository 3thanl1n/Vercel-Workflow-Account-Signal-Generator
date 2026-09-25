import { FatalError, sleep } from "workflow";
import { getSql } from "@/lib/db";
import { runPython } from "@/lib/sandbox";

// Day 1 smoke test: proves durable steps, a durable sleep, Postgres and
// Sandbox all work together, locally and on Vercel.
export async function helloWorkflow(name: string) {
  "use workflow";

  const greeting = await makeGreeting(name);
  await sleep("5s");
  const dbTime = await checkDatabase();
  const sandboxOut = await runInSandbox();

  return { greeting, dbTime, sandboxOut };
}

async function makeGreeting(name: string) {
  "use step";
  return `Hello, ${name}`;
}

async function checkDatabase() {
  "use step";
  const sql = getSql();
  const rows = await sql`select now()::text as now`;
  return rows[0].now as string;
}

async function runInSandbox() {
  "use step";
  const result = await runPython("print(sum(range(10)))");
  // Deterministic code that fails will fail again, so don't retry it.
  if (result.exitCode !== 0) throw new FatalError(`Sandbox script failed: ${result.stderr}`);
  return result.stdout;
}
