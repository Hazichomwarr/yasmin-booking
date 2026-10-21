import { createHairstyleMediaCleanupCronApi } from "@/lib/media/hairstyle-media-cleanup-cron-api";

export const runtime = "nodejs";
// Next requires a statically analyzable segment-config value.
export const maxDuration = 60;

export const GET = createHairstyleMediaCleanupCronApi();
