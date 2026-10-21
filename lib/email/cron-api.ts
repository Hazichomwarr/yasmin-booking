import { timingSafeEqual } from "node:crypto";

import {
  deliverPendingConfirmationEmails,
  resendConfirmationEmailAdapter,
  type ConfirmationEmailAdapter,
  type DeliveryRunSummary,
} from "./confirmation";

/**
 * Confirmation-email worker triggers (YASMIN-1G).
 *
 * 1. GET /api/cron/confirmation-emails — Vercel Cron. Vercel sends
 *    `Authorization: Bearer <CRON_SECRET>` when the CRON_SECRET environment
 *    variable is set; anything else is 401 and runs nothing.
 * 2. After every acknowledged Stripe webhook (`after()` in the webhook
 *    route) — prompt delivery that does not depend on the plan's cron
 *    frequency. It runs after the response, outside every payment
 *    transaction, and never affects the webhook's answer.
 *
 * Both only call `deliverPendingConfirmationEmails`, whose claims, lease
 * fencing, retries and Resend idempotency keys make overlapping runs safe.
 */

/** Rows per run: at most 5 × PROVIDER_TIMEOUT_MS (10 s) of provider time, inside CRON_MAX_DURATION_SECONDS. */
export const CRON_BATCH_LIMIT = 5;
export const CRON_MAX_DURATION_SECONDS = 60;
const MIN_CRON_SECRET_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;
export type CronLogEntry = { trigger: "cron" | "webhook"; status?: number; outcome: string; summary?: DeliveryRunSummary };

export type ConfirmationEmailCronDeps = {
  env: () => Env;
  adapter: () => ConfirmationEmailAdapter;
  deliver: typeof deliverPendingConfirmationEmails;
  log: (entry: CronLogEntry) => void;
};

export const defaultConfirmationEmailCronDeps: ConfirmationEmailCronDeps = {
  env: () => process.env,
  adapter: resendConfirmationEmailAdapter,
  deliver: deliverPendingConfirmationEmails,
  // Counts and outcome codes only: never addresses, ids or provider responses.
  log: (entry) => console.info(JSON.stringify({ event: "confirmation-email-worker", ...entry })),
};

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export function createConfirmationEmailCronApi(deps: ConfirmationEmailCronDeps = defaultConfirmationEmailCronDeps) {
  return async function GET(request: Request): Promise<Response> {
    const secret = deps.env().CRON_SECRET ?? "";
    if (secret.length < MIN_CRON_SECRET_LENGTH || !sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
      deps.log({ trigger: "cron", status: 401, outcome: "unauthorized" });
      return json(401, { error: "unauthorized" });
    }

    let adapter: ConfirmationEmailAdapter;
    try {
      adapter = deps.adapter();
    } catch {
      // Nothing is claimed without a usable provider, so no attempt is spent.
      deps.log({ trigger: "cron", status: 503, outcome: "email-not-configured" });
      return json(503, { error: "email-not-configured" });
    }

    try {
      const summary = await deps.deliver(adapter, { limit: CRON_BATCH_LIMIT, env: deps.env });
      deps.log({ trigger: "cron", status: 200, outcome: "ran", summary });
      return json(200, summary);
    } catch (error) {
      deps.log({ trigger: "cron", status: 500, outcome: error instanceof Error ? error.name : "failed" });
      return json(500, { error: "worker-failed" });
    }
  };
}

/** Best-effort prompt delivery after a webhook. Never throws. */
export async function deliverConfirmationEmailsAfterWebhook(deps: ConfirmationEmailCronDeps = defaultConfirmationEmailCronDeps): Promise<void> {
  let adapter: ConfirmationEmailAdapter;
  try {
    adapter = deps.adapter();
  } catch {
    return deps.log({ trigger: "webhook", outcome: "email-not-configured" });
  }
  try {
    const summary = await deps.deliver(adapter, { limit: CRON_BATCH_LIMIT, env: deps.env });
    deps.log({ trigger: "webhook", outcome: "ran", summary });
  } catch (error) {
    deps.log({ trigger: "webhook", outcome: error instanceof Error ? error.name : "failed" });
  }
}

function sameSecret(presented: string | null, expected: string): boolean {
  const a = Buffer.from(presented ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
