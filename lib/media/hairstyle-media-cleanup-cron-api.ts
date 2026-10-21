import { timingSafeEqual } from "node:crypto";

import { runHairstyleMediaCleanup, type MediaCleanupSummary } from "./hairstyle-media-cleanup";

const MIN_SECRET_LENGTH = 32;
export const MEDIA_CLEANUP_CRON_MAX_DURATION_SECONDS = 60;

export function createHairstyleMediaCleanupCronApi(
  deps: {
    env?: () => Readonly<Record<string, string | undefined>>;
    run?: typeof runHairstyleMediaCleanup;
    log?: (entry: MediaCleanupCronLogEntry) => void;
  } = {},
) {
  const env = deps.env ?? (() => process.env);
  const run = deps.run ?? runHairstyleMediaCleanup;
  const log = deps.log ?? ((entry: MediaCleanupCronLogEntry) => console.info(JSON.stringify({ event: "hairstyle-media-cleanup", ...entry })));
  return async function GET(request: Request): Promise<Response> {
    const secret = env().CRON_SECRET ?? "";
    if (secret.length < MIN_SECRET_LENGTH || !sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
      log({ outcome: "unauthorized" });
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    try {
      const result: MediaCleanupSummary = await run();
      log({ outcome: "ran", summary: result });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      log({ outcome: "cleanup-unavailable" });
      return Response.json({ error: "cleanup-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export type MediaCleanupCronLogEntry = {
  outcome: "unauthorized" | "ran" | "cleanup-unavailable";
  summary?: MediaCleanupSummary;
};

function sameSecret(actual: string | null, expected: string) {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
