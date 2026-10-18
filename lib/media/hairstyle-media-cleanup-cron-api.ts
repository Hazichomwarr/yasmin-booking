import { timingSafeEqual } from "node:crypto";

import { runHairstyleMediaCleanup, type MediaCleanupSummary } from "./hairstyle-media-cleanup";

const MIN_SECRET_LENGTH = 32;
export const MEDIA_CLEANUP_CRON_MAX_DURATION_SECONDS = 60;

export function createHairstyleMediaCleanupCronApi(
  deps: { env?: () => Readonly<Record<string, string | undefined>>; run?: typeof runHairstyleMediaCleanup } = {},
) {
  const env = deps.env ?? (() => process.env);
  const run = deps.run ?? runHairstyleMediaCleanup;
  return async function GET(request: Request): Promise<Response> {
    const secret = env().CRON_SECRET ?? "";
    if (secret.length < MIN_SECRET_LENGTH || !sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    try {
      const result: MediaCleanupSummary = await run();
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "cleanup-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

function sameSecret(actual: string | null, expected: string) {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
