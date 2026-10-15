import { createHmac } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { RateLimitRule } from "./config";

/**
 * Shared fixed-window rate limiting in PostgreSQL (YASMIN-1F.4).
 *
 * One atomic statement per consumption: every applicable counter is
 * incremented with INSERT … ON CONFLICT DO UPDATE … RETURNING, so concurrent
 * requests on any number of Vercel instances (and connections) share exact
 * counts — no process-local state. Every attempt counts, allowed or not.
 *
 * Identities are never stored: keyHash = HMAC-SHA256(RATE_LIMIT_SECRET,
 * scope ␀ identity). Windows come from the database clock, so instance clock
 * skew cannot move them. A fixed window admits at most 2×limit across a
 * window boundary; that is accepted for these limits.
 *
 * Retention: a row expires at its window's end (≤ 24 h). Each consumption
 * deterministically purges up to PURGE_BATCH expired rows in the same
 * statement — rows only appear through traffic, and every request removes
 * far more than it can add — and `purgeExpiredRateLimitCounters` is the
 * entry point for a scheduled job that empties the backlog after traffic
 * stops.
 *
 * Any store failure throws RateLimitStoreError; callers fail closed (503).
 */

const PURGE_BATCH = 100;

export type RateLimitCheck = { rule: RateLimitRule; identity: string };

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: string };

export class RateLimitStoreError extends Error {
  constructor() {
    super("Rate-limit store unavailable.");
    this.name = "RateLimitStoreError";
  }
}

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

export function rateLimitKey(secret: string, scope: string, identity: string): string {
  return createHmac("sha256", secret).update(`${scope}\u0000${identity}`, "utf8").digest("hex");
}

export function windowStartMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export async function consumeRateLimits(
  checks: readonly RateLimitCheck[],
  options: { secret: string; db?: Db; nowMs?: number },
): Promise<RateLimitDecision> {
  if (checks.length === 0) return { allowed: true };
  const db = options.db ?? prisma;

  try {
    const nowMs = options.nowMs ?? Number((await db.$queryRaw<{ ms: bigint }[]>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms
    `)[0].ms);

    const rows = checks
      .map(({ rule, identity }) => {
        const start = windowStartMs(nowMs, rule.windowMs);
        return { rule, start, end: start + rule.windowMs, key: rateLimitKey(options.secret, rule.scope, identity) };
      })
      // One row per scope (ON CONFLICT cannot touch a row twice), in a fixed
      // order so concurrent statements lock counters consistently (no deadlock).
      .sort((a, b) => (a.rule.scope < b.rule.scope ? -1 : a.rule.scope > b.rule.scope ? 1 : 0));
    if (new Set(rows.map((r) => r.rule.scope)).size !== rows.length) throw new Error("Duplicate rate-limit scope in one consumption.");
    const utc = (ms: number) => Prisma.sql`(to_timestamp(${ms}::double precision / 1000) AT TIME ZONE 'UTC')`;

    const counted = await db.$queryRaw<{ scope: string; keyHash: string; count: number }[]>`
      WITH purged AS (
        DELETE FROM "RateLimitCounter"
        WHERE ctid IN (
          SELECT ctid FROM "RateLimitCounter"
          WHERE "expiresAt" <= ${utc(nowMs)}
          LIMIT ${PURGE_BATCH}
          FOR UPDATE SKIP LOCKED
        )
      )
      INSERT INTO "RateLimitCounter" ("scope", "keyHash", "windowStart", "count", "expiresAt")
      VALUES ${Prisma.join(rows.map((r) => Prisma.sql`(${r.rule.scope}, ${r.key}, ${utc(r.start)}, 1, ${utc(r.end)})`))}
      ON CONFLICT ("scope", "keyHash", "windowStart")
      DO UPDATE SET "count" = "RateLimitCounter"."count" + 1
      RETURNING "scope", "keyHash", "count"
    `;

    let retryAfterMs = 0;
    let exceededScope: string | null = null;
    for (const row of rows) {
      const count = counted.find((c) => c.scope === row.rule.scope && c.keyHash === row.key)?.count;
      if (count === undefined) throw new Error("Rate-limit counter missing from RETURNING.");
      if (count > row.rule.limit && row.end - nowMs > retryAfterMs) {
        retryAfterMs = row.end - nowMs;
        exceededScope = row.rule.scope;
      }
    }
    if (exceededScope === null) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)), scope: exceededScope };
  } catch {
    throw new RateLimitStoreError();
  }
}

/** Deletes every expired counter. For a scheduled job; safe to run at any time. */
export async function purgeExpiredRateLimitCounters(db: Db = prisma): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "RateLimitCounter" WHERE "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
  `;
}
