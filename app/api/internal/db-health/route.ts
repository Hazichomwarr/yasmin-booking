import { createDbHealthApi } from "@/lib/http/db-health-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** TEMPORARY production connectivity check (Bearer CRON_SECRET). Remove after verification. */
export const GET = createDbHealthApi();
