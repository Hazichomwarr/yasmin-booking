import { timingSafeEqual } from "node:crypto";

/**
 * TEMPORARY (YASMIN-HEALTH-1): proves the deployed app reaches its database
 * through Prisma. Remove once production connectivity is confirmed.
 *
 * GET /api/internal/db-health, `Authorization: Bearer <CRON_SECRET>`.
 * - Authorization is checked first; the Prisma client is not even imported
 *   for a rejected request, and a missing or short CRON_SECRET fails closed.
 * - Runs only `SELECT 1`. Responses carry a fixed status word and nothing
 *   else: no identifiers, connection details, errors or stack traces.
 */

/** Same rule as the confirmation-email cron (lib/email/cron-api.ts). */
const MIN_SECRET_LENGTH = 32;
export const DB_HEALTH_TIMEOUT_MS = 10_000;

type Env = Readonly<Record<string, string | undefined>>;
export type DbHealthLogEntry = { status: 200 | 401 | 503; outcome: "ok" | "unauthorized" | "unavailable" };

export type DbHealthDeps = {
  env: () => Env;
  /** Runs the read-only probe; throws when the database is unreachable. */
  ping: () => Promise<void>;
  timeoutMs?: number;
  log: (entry: DbHealthLogEntry) => void;
};

export const defaultDbHealthDeps: DbHealthDeps = {
  env: () => process.env,
  async ping() {
    // Imported only after authorization, so a rejected request never initializes Prisma.
    const { prisma } = await import("@/lib/prisma");
    await prisma.$queryRaw`SELECT 1`;
  },
  log: (entry) => console.info(JSON.stringify({ event: "db-health", ...entry })),
};

const respond = (status: DbHealthLogEntry["status"], body: { status: string }) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });

export function createDbHealthApi(deps: DbHealthDeps = defaultDbHealthDeps) {
  return async function GET(request: Request): Promise<Response> {
    const secret = deps.env().CRON_SECRET ?? "";
    if (secret.length < MIN_SECRET_LENGTH || !sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
      deps.log({ status: 401, outcome: "unauthorized" });
      return respond(401, { status: "unauthorized" });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.ping(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), deps.timeoutMs ?? DB_HEALTH_TIMEOUT_MS); }),
      ]);
    } catch {
      deps.log({ status: 503, outcome: "unavailable" });
      return respond(503, { status: "unavailable" });
    } finally {
      clearTimeout(timer);
    }
    deps.log({ status: 200, outcome: "ok" });
    return respond(200, { status: "ok" });
  };
}

function sameSecret(presented: string | null, expected: string): boolean {
  const a = Buffer.from(presented ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
