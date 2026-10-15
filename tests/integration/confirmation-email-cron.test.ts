import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import * as cronRoute from "@/app/api/cron/confirmation-emails/route";
import { ConfirmationEmailDeliveryError, MAX_ATTEMPTS, deliverPendingConfirmationEmails } from "@/lib/email/confirmation";
import {
  CRON_BATCH_LIMIT,
  CRON_MAX_DURATION_SECONDS,
  createConfirmationEmailCronApi,
  deliverConfirmationEmailsAfterWebhook,
  type ConfirmationEmailCronDeps,
  type CronLogEntry,
} from "@/lib/email/cron-api";
import { prisma } from "@/lib/prisma";

import { ageLease, confirmedBooking, deliverWebhook, outbox, pendingPublicBooking, provider } from "../support/confirmation-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const SECRET = "c".repeat(48);
const URL = "https://book.yasmin.example/api/cron/confirmation-emails";

function cron(adapter: ReturnType<typeof provider> | (() => never), env: Record<string, string | undefined> = { CRON_SECRET: SECRET }) {
  const logs: CronLogEntry[] = [];
  const deps: ConfirmationEmailCronDeps = {
    env: () => env,
    adapter: typeof adapter === "function" ? adapter : () => adapter,
    deliver: deliverPendingConfirmationEmails,
    log: (entry) => logs.push(entry),
  };
  const get = createConfirmationEmailCronApi(deps);
  const call = async (authorization: string | null = `Bearer ${SECRET}`) => {
    const response = await get(new Request(URL, { headers: authorization === null ? {} : { authorization } }));
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  };
  return { call, logs, deps };
}

describe("confirmation email cron endpoint (YASMIN-1G)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("is a GET-only route with a bounded duration, declared in vercel.json on a schedule every plan accepts", () => {
    assert.equal(typeof cronRoute.GET, "function");
    assert.equal("POST" in cronRoute, false);
    assert.equal(cronRoute.maxDuration, CRON_MAX_DURATION_SECONDS);
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    assert.deepEqual(config.crons.map((job) => job.path), ["/api/cron/confirmation-emails"]);
    // Hobby accepts at most one run per day: fixed minute and hour, every day.
    assert.match(config.crons[0].schedule, /^\d{1,2} \d{1,2} \* \* \*$/);
  });

  it("rejects missing, malformed and incorrect authorization without running the worker", async () => {
    const booking = await confirmedBooking();
    const sent = provider();
    const { call, logs } = cron(sent);
    for (const authorization of [null, "", `Bearer ${"x".repeat(48)}`, `bearer ${SECRET}`, SECRET, `Bearer ${SECRET.slice(1)}`, `Bearer ${SECRET}x`]) {
      const result = await call(authorization);
      assert.equal(result.status, 401, String(authorization));
      assert.equal(result.cache, "no-store");
    }
    for (const env of [{}, { CRON_SECRET: "" }, { CRON_SECRET: "short-secret" }] as Record<string, string | undefined>[]) {
      assert.equal((await cron(sent, env).call(`Bearer ${env.CRON_SECRET ?? ""}`)).status, 401);
    }
    assert.equal(sent.calls.length, 0);
    assert.equal((await outbox(booking.appointmentId)).state, "PENDING");
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(SECRET)));
  });

  it("delivers a pending message with valid cron authorization", async () => {
    const booking = await confirmedBooking();
    const sent = provider();
    const { call } = cron(sent);
    assert.deepEqual(await call(), { status: 200, body: { sent: 1, failed: 0, exhausted: 0 }, cache: "no-store" });
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.providerMessageId], ["SENT", 1, "email_1"]);
    assert.equal(sent.calls[0].message.to, booking.email);
  });

  it("answers an empty queue without calling the provider", async () => {
    const sent = provider();
    assert.deepEqual((await cron(sent).call()).body, { sent: 0, failed: 0, exhausted: 0 });
    assert.equal(sent.calls.length, 0);
  });

  it("claims nothing when the email provider is not configured", async () => {
    const booking = await confirmedBooking();
    const result = await cron(() => { throw new Error("Confirmation email requires RESEND_API_KEY and BOOKING_FROM_EMAIL."); }).call();
    assert.deepEqual([result.status, result.body], [503, { error: "email-not-configured" }]);
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount], ["PENDING", 0]);
  });

  it("sends each message once across concurrent cron invocations", async () => {
    const bookings = [await confirmedBooking(), await confirmedBooking(), await confirmedBooking()];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = provider(async (_call, n) => { await gate; return { id: `email_${n}` }; });
    const { call } = cron(slow);
    const runs = Promise.all([call(), call(), call()]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    const results = await runs;
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(results.reduce((sum, result) => sum + result.body.sent, 0), 3);
    assert.equal(slow.calls.length, 3);
    assert.equal(new Set(slow.calls.map((callMade) => callMade.idempotencyKey)).size, 3);
    for (const booking of bookings) assert.equal((await outbox(booking.appointmentId)).state, "SENT");
  });

  it("processes at most CRON_BATCH_LIMIT rows per run", async () => {
    for (let i = 0; i < CRON_BATCH_LIMIT + 1; i += 1) await confirmedBooking();
    const sent = provider();
    const { call } = cron(sent);
    assert.equal((await call()).body.sent, CRON_BATCH_LIMIT);
    assert.equal((await call()).body.sent, 1);
  });

  it("records a provider timeout as retryable and retries it on the next run with the same idempotency key", async () => {
    const booking = await confirmedBooking();
    const flaky = provider(async (_call, n) => { if (n === 1) throw new ConfirmationEmailDeliveryError("outcome-unknown"); return { id: "email_after_timeout" }; });
    const { call } = cron(flaky);
    assert.deepEqual((await call()).body, { sent: 0, failed: 1, exhausted: 0 });
    assert.deepEqual([(await outbox(booking.appointmentId)).state, (await outbox(booking.appointmentId)).lastError], ["FAILED", "outcome-unknown"]);
    assert.deepEqual((await call()).body, { sent: 1, failed: 0, exhausted: 0 });
    assert.equal(flaky.calls[0].idempotencyKey, flaky.calls[1].idempotencyKey);
    assert.equal((await outbox(booking.appointmentId)).providerMessageId, "email_after_timeout");
  });

  it("retries a provider rejection until it succeeds", async () => {
    const booking = await confirmedBooking();
    const rejecting = provider(async (_call, n) => { if (n < 3) throw new ConfirmationEmailDeliveryError("rejected"); return { id: "email_third" }; });
    const { call } = cron(rejecting);
    assert.equal((await call()).body.failed, 1);
    assert.equal((await call()).body.failed, 1);
    assert.equal((await call()).body.sent, 1);
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.lastError], ["SENT", 3, null]);
  });

  it("marks a message terminally FAILED after MAX_ATTEMPTS and stops calling the provider", async () => {
    const booking = await confirmedBooking();
    const broken = provider(async () => { throw new ConfirmationEmailDeliveryError("rejected"); });
    const { call } = cron(broken);
    const bodies = [];
    for (let run = 0; run < MAX_ATTEMPTS + 2; run += 1) bodies.push((await call()).body);
    assert.deepEqual(bodies.slice(0, MAX_ATTEMPTS - 1).map((body) => body.failed), Array(MAX_ATTEMPTS - 1).fill(1));
    assert.equal(bodies[MAX_ATTEMPTS - 1].exhausted, 1);
    assert.deepEqual(bodies.slice(MAX_ATTEMPTS), [{ sent: 0, failed: 0, exhausted: 0 }, { sent: 0, failed: 0, exhausted: 0 }]);
    assert.equal(broken.calls.length, MAX_ATTEMPTS);
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.lastError], ["FAILED", MAX_ATTEMPTS, "attempts-exhausted:rejected"]);
  });

  it("takes over a stale worker's lease and fences the stale worker's late result", async () => {
    const booking = await confirmedBooking();
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    let claimed!: () => void;
    const staleClaimed = new Promise<void>((resolve) => { claimed = resolve; });
    const stale = provider(async () => { claimed(); await staleGate; return { id: "email_stale" }; });
    const staleRun = cron(stale).call();
    await staleClaimed;

    const fresh = provider(async () => ({ id: "email_fresh" }));
    assert.deepEqual((await cron(fresh).call()).body, { sent: 0, failed: 0, exhausted: 0 });
    await ageLease(booking.appointmentId);
    assert.deepEqual((await cron(fresh).call()).body, { sent: 1, failed: 0, exhausted: 0 });

    releaseStale();
    assert.deepEqual((await staleRun).body, { sent: 0, failed: 0, exhausted: 0 });
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.providerMessageId], ["SENT", 2, "email_fresh"]);
  });

  it("never creates a second confirmation intent, whatever the webhook and cron interleaving", async () => {
    const booking = await pendingPublicBooking();
    const sent = provider();
    const { call } = cron(sent);
    await Promise.all([deliverWebhook(booking, "evt_cron_a"), deliverWebhook(booking, "evt_cron_a"), call(), deliverWebhook(booking, "evt_cron_b"), call()]);
    await deliverWebhook(booking, "evt_cron_c");
    await call();
    assert.equal(await prisma.bookingConfirmationEmail.count({ where: { appointmentId: booking.appointmentId } }), 1);
    assert.equal(sent.calls.length, 1);
    assert.equal((await outbox(booking.appointmentId)).state, "SENT");
  });

  it("delivers promptly after a webhook without cron, and never throws when email is unconfigured", async () => {
    const booking = await confirmedBooking();
    const sent = provider();
    const logs: CronLogEntry[] = [];
    await deliverConfirmationEmailsAfterWebhook({ env: () => ({}), adapter: () => sent, deliver: deliverPendingConfirmationEmails, log: (entry) => logs.push(entry) });
    assert.equal((await outbox(booking.appointmentId)).state, "SENT");
    assert.deepEqual(logs, [{ trigger: "webhook", outcome: "ran", summary: { sent: 1, failed: 0, exhausted: 0 } }]);

    const other = await confirmedBooking();
    await deliverConfirmationEmailsAfterWebhook({ env: () => ({}), adapter: () => { throw new Error("unconfigured"); }, deliver: deliverPendingConfirmationEmails, log: () => {} });
    await deliverConfirmationEmailsAfterWebhook({ env: () => ({}), adapter: () => sent, deliver: async () => { throw new Error("database down"); }, log: () => {} });
    assert.equal((await outbox(other.appointmentId)).state, "PENDING");
  });
});
