import { randomUUID } from "node:crypto";

import { Prisma, type StripeWebhookEventState } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  STRIPE_CHECKOUT_EVENT_TYPES,
  evidenceFromRetrievedCheckoutSession,
  type StripeWebhookGateway,
} from "@/lib/stripe/webhook";

import { processVerifiedCheckoutEvidence } from "./payment-exceptions";

const PROCESSING_LEASE_MS = 5 * 60_000;

export type StripeWebhookProcessingResult =
  | { kind: "ignored" }
  | { kind: "duplicate" }
  | { kind: "busy" }
  | { kind: "processed" }
  | { kind: "reconciliation-recorded" };

type ProcessingDependencies = {
  /** Internal test synchronization only; no HTTP request can supply it. */
  afterClaimed?: () => Promise<void>;
};

type SignedStripeEvent = { id: string; type: string; data: { object: { id?: unknown } } };

/**
 * Processes one already-signature-verified Stripe Event. Event receipt state
 * is database-backed; no process-local deduplication is trusted.
 */
export async function processSignedStripeWebhookEvent(
  event: SignedStripeEvent,
  gateway: StripeWebhookGateway,
  dependencies: ProcessingDependencies = {},
): Promise<StripeWebhookProcessingResult> {
  if (!STRIPE_CHECKOUT_EVENT_TYPES.has(event.type)) return { kind: "ignored" };
  const sessionId = event.data.object?.id;
  if (typeof sessionId !== "string" || !/^cs_\S+$/.test(sessionId)) return { kind: "ignored" };

  const claim = await claimWebhookEvent(event.id, event.type, sessionId);
  if (claim === "duplicate") return { kind: "duplicate" };
  if (claim === "busy") return { kind: "busy" };
  await dependencies.afterClaimed?.();

  try {
    const session = await gateway.retrieveCheckoutSession(sessionId);
    if (session.id !== sessionId) throw new Error("Stripe returned a different Checkout Session.");
    const evidence = evidenceFromRetrievedCheckoutSession(session, event.id);
    const disposition = await processVerifiedCheckoutEvidence(evidence);
    const needsReconciliation = disposition.kind === "exception-recorded"
      || (disposition.kind === "applied" && disposition.outcome.kind === "reconciled");
    const finalized = await markWebhookEvent(claim.leaseToken, event.id, needsReconciliation ? "RECONCILIATION_REQUIRED" : "PROCESSED");
    if (!finalized) return currentReceiptOutcome(event.id);
    return needsReconciliation ? { kind: "reconciliation-recorded" } : { kind: "processed" };
  } catch (error) {
    // A failing best-effort reset never acknowledges the delivery. The lease
    // lets a later Stripe retry reclaim a row after a process crash.
    await prisma.stripeWebhookEvent.updateMany({
      where: { id: event.id, state: "PROCESSING", leaseToken: claim.leaseToken },
      data: { state: "PENDING", leaseToken: null },
    }).catch(() => {});
    throw error;
  }
}

async function claimWebhookEvent(eventId: string, type: string, checkoutSessionId: string): Promise<{ kind: "claimed"; leaseToken: string } | "duplicate" | "busy"> {
  const leaseToken = randomUUID();
  try {
    await prisma.stripeWebhookEvent.create({
      data: { id: eventId, type, checkoutSessionId, state: "PROCESSING", leaseToken, processingStartedAt: new Date() },
    });
    return { kind: "claimed", leaseToken };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }

  return prisma.$transaction(async (tx) => {
    const event = await tx.stripeWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (event.state === "PROCESSED" || event.state === "RECONCILIATION_REQUIRED") return "duplicate";
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const reclaimable = event.state === "PENDING" || event.processingStartedAt.getTime() <= now.getTime() - PROCESSING_LEASE_MS;
    if (!reclaimable) return "busy";
    const claimed = await tx.stripeWebhookEvent.updateMany({
      where: { id: eventId, state: event.state, processingStartedAt: event.processingStartedAt },
      data: { state: "PROCESSING", leaseToken, processingStartedAt: now, attemptCount: { increment: 1 } },
    });
    return claimed.count === 1 ? { kind: "claimed", leaseToken } : "busy";
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function markWebhookEvent(leaseToken: string, eventId: string, state: Extract<StripeWebhookEventState, "PROCESSED" | "RECONCILIATION_REQUIRED">): Promise<boolean> {
  const updated = await prisma.stripeWebhookEvent.updateMany({
    where: { id: eventId, state: "PROCESSING", leaseToken },
    data: { state, processedAt: new Date(), leaseToken: null },
  });
  return updated.count === 1;
}

async function currentReceiptOutcome(eventId: string): Promise<StripeWebhookProcessingResult> {
  const receipt = await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: eventId }, select: { state: true } });
  if (receipt.state === "PROCESSED" || receipt.state === "RECONCILIATION_REQUIRED") return { kind: "duplicate" };
  return { kind: "busy" };
}
