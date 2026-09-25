import { Sandbox } from "@vercel/sandbox";

// Step results are stored in the workflow event log, so keep them small.
const MAX_OUTPUT_CHARS = 8_000;

export type SandboxFile = { path: string; content: string };

export type PythonResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Runs Python in a throwaway Vercel Sandbox (a Firecracker microVM).
 * No network, nothing persists after stop, and a short timeout: the code can
 * only see the files passed in, never our secrets or the internet.
 *
 * A non-zero exit is returned, not thrown, so the caller decides what bad code
 * means (the hello step fails fast; the agent tool will show stderr to the model).
 */
export async function runPython(code: string, files: SandboxFile[] = []): Promise<PythonResult> {
  const sandbox = await Sandbox.create({
    image: "vercel/sandbox/python:3.14",
    persistent: false,
    networkPolicy: "deny-all",
    timeout: 60_000,
    resources: { vcpus: 1 },
  });

  try {
    await sandbox.writeFiles([
      ...files.map((f) => ({ path: f.path, content: Buffer.from(f.content) })),
      { path: "main.py", content: Buffer.from(code) },
    ]);
    const result = await sandbox.runCommand("python3", ["main.py"]);
    return {
      exitCode: result.exitCode,
      stdout: truncate((await result.stdout()).trim()),
      stderr: truncate((await result.stderr()).trim()),
    };
  } finally {
    // The timeout above is the backstop, so a failed stop shouldn't fail the step.
    await sandbox.stop().catch((err) => console.warn("sandbox.stop failed", err));
  }
}

function truncate(text: string) {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text;
}
