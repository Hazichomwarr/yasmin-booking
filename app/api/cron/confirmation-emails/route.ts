import { createConfirmationEmailCronApi } from "@/lib/email/cron-api";

export const runtime = "nodejs";
/** Keep in step with CRON_MAX_DURATION_SECONDS (lib/email/cron-api.ts); within every Vercel plan's limit. */
export const maxDuration = 60;

/** Vercel Cron (Authorization: Bearer CRON_SECRET). Never customer-addressable. */
export const GET = createConfirmationEmailCronApi();
