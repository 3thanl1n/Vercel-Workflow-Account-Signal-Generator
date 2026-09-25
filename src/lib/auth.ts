import { timingSafeEqual } from "node:crypto";

// Constant-time check of an `Authorization: Bearer <secret>` header.
// Returns false when the secret isn't configured, so a missing env var never opens a route.
export function hasBearerSecret(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
