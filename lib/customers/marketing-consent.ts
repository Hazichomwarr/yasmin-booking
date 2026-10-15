import { Prisma, type MarketingChannel } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Marketing-consent evidence (YASMIN-1F.4).
 *
 * Customer.emailMarketingAt / smsMarketingAt keep their meaning: when the
 * CURRENT consent for that channel was granted, or null when there is none.
 * MarketingConsentEvent is the append-only evidence behind them: every grant
 * records the wording version shown and its source; every withdrawal is a new
 * row, never an edit. The database rejects UPDATE/DELETE on the events.
 *
 * Consent is optional and separate per channel. Accepting the booking itself
 * is never marketing consent. Nothing here sends messages or manages
 * campaigns.
 *
 * Pre-existing consent (a timestamp with no matching GRANTED event) is
 * reported as evidence "unknown" — it is never back-filled or treated as
 * proven.
 */

export type MarketingConsentWording = { version: string; text: string };

/**
 * The wording the public booking form shows next to each (unticked) box. The
 * form must render exactly this text; a grant records `version`.
 *
 * DRAFT: requires product/legal approval before PUBLIC_BOOKING_ENABLED is
 * turned on. Changing the text requires a new version identifier.
 */
export const CURRENT_MARKETING_CONSENT_WORDING: Readonly<Record<MarketingChannel, MarketingConsentWording>> = {
  EMAIL: {
    version: "email-marketing-2026-10-draft1",
    text: "Email me offers and news from Yasmin's Beauty Salon. Optional; you can unsubscribe at any time.",
  },
  SMS: {
    version: "sms-marketing-2026-10-draft1",
    text: "Text me offers from Yasmin's Beauty Salon. Optional; message and data rates may apply; reply STOP to opt out.",
  },
};

export type MarketingConsentChoice = { email: boolean; sms: boolean };

/**
 * Records the public form's grants for a newly created Customer, inside the
 * caller's transaction, at the same instant written to the Customer's
 * timestamps. Unticked channels write nothing.
 */
export async function recordPublicFormConsent(
  tx: Prisma.TransactionClient,
  customerId: string,
  choice: MarketingConsentChoice,
  occurredAt: Date,
): Promise<void> {
  const channels: MarketingChannel[] = [];
  if (choice.email) channels.push("EMAIL");
  if (choice.sms) channels.push("SMS");
  if (channels.length === 0) return;

  await tx.marketingConsentEvent.createMany({
    data: channels.map((channel) => ({
      customerId,
      channel,
      action: "GRANTED" as const,
      occurredAt,
      wordingVersion: CURRENT_MARKETING_CONSENT_WORDING[channel].version,
      source: "PUBLIC_BOOKING_FORM" as const,
    })),
  });
}

export type MarketingConsentWithdrawal =
  | { outcome: "withdrawn"; withdrawnAt: Date }
  /** The channel had no current consent: nothing written. */
  | { outcome: "not-consented" };

/**
 * Internal operation: records a customer's withdrawal for one channel, as
 * requested through staff (`actorId`). Locks the Customer, clears the
 * channel's timestamp and appends WITHDRAWN atomically. Repeating it is a
 * no-op. Also applies to consent whose original evidence is unknown.
 */
export async function withdrawMarketingConsent(input: {
  customerId: string;
  channel: MarketingChannel;
  actorId: string;
}): Promise<MarketingConsentWithdrawal> {
  if (!input.actorId || input.actorId !== input.actorId.trim() || /\s/.test(input.actorId)) {
    throw new Error("withdrawMarketingConsent: actorId must be a non-empty identifier.");
  }
  const field = input.channel === "EMAIL" ? "emailMarketingAt" : "smsMarketingAt";

  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Customer" WHERE "id" = ${input.customerId} FOR UPDATE
      `;
      if (locked.length === 0) throw new Error(`Customer ${input.customerId} does not exist.`);
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: input.customerId },
        select: { emailMarketingAt: true, smsMarketingAt: true },
      });
      if (customer[field] === null) return { outcome: "not-consented" };

      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      await tx.customer.update({ where: { id: input.customerId }, data: { [field]: null }, select: { id: true } });
      await tx.marketingConsentEvent.create({
        data: {
          customerId: input.customerId,
          channel: input.channel,
          action: "WITHDRAWN",
          occurredAt: now,
          source: "INTERNAL_OPERATOR",
          actorId: input.actorId,
        },
      });
      return { outcome: "withdrawn", withdrawnAt: now };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

export type ChannelConsentEvidence =
  /** Currently consented, backed by the GRANTED event at `since`. */
  | { consented: true; since: Date; evidence: "recorded"; wordingVersion: string }
  /** Currently consented, but the grant predates evidence capture. */
  | { consented: true; since: Date; evidence: "unknown" }
  /** Not consented; `withdrawnAt` when the latest event is a withdrawal. */
  | { consented: false; withdrawnAt: Date | null };

/** Internal read of what can be proven about each channel's current consent. */
export async function marketingConsentEvidence(
  customerId: string,
): Promise<Record<MarketingChannel, ChannelConsentEvidence>> {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: {
      emailMarketingAt: true,
      smsMarketingAt: true,
      marketingConsentEvents: {
        select: { channel: true, action: true, occurredAt: true, wordingVersion: true },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  const evidenceFor = (channel: MarketingChannel, since: Date | null): ChannelConsentEvidence => {
    const events = customer.marketingConsentEvents.filter((e) => e.channel === channel);
    const latest = events.at(-1);
    if (since === null) {
      return { consented: false, withdrawnAt: latest?.action === "WITHDRAWN" ? latest.occurredAt : null };
    }
    const grant = events.find(
      (e) => e.action === "GRANTED" && e.occurredAt.getTime() === since.getTime() && e.wordingVersion !== null,
    );
    return grant && latest === grant
      ? { consented: true, since, evidence: "recorded", wordingVersion: grant.wordingVersion! }
      : { consented: true, since, evidence: "unknown" };
  };

  return {
    EMAIL: evidenceFor("EMAIL", customer.emailMarketingAt),
    SMS: evidenceFor("SMS", customer.smsMarketingAt),
  };
}
