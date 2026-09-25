import { neon } from "@neondatabase/serverless";
import { FatalError } from "workflow";

// Neon's serverless driver sends SQL over HTTP, so each step can query
// without holding a connection pool open between function invocations.
export function getSql() {
  const url = process.env.DATABASE_URL;
  // A missing env var won't fix itself on retry, so stop the step immediately.
  if (!url) throw new FatalError("DATABASE_URL is not set (run `vercel env pull`).");
  return neon(url);
}
