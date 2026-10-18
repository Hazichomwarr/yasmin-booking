import { randomUUID } from "node:crypto";

import { Prisma, type HairstyleMediaCleanupTask } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { loadBlobStorageConfig } from "./hairstyle-image-upload";
import { vercelBlobClientGateway, type BlobClientUploadGateway } from "./vercel-blob-client";

/** Callback attachment failures wait briefly for a provider retry before cleanup. */
export const UNATTACHED_UPLOAD_GRACE_MS = 15 * 60_000;
export const CLEANUP_LEASE_MS = 10 * 60_000;
export const CLEANUP_MAX_ATTEMPTS = 5;
export const CLEANUP_BATCH_LIMIT = 10;

export type MediaCleanupSummary = { completed: number; failed: number; exhausted: number; skipped: number };

type RemoveResult = { mediaId: string; hairstyleId: string; storageKey: string; alreadyRemoved: boolean };

/**
 * Removes public metadata and enqueues Blob deletion atomically. The binary is
 * never deleted until after this transaction has committed.
 */
export async function removeHairstyleImageAndQueueCleanup(
  hairstyleId: string,
  mediaId: string,
): Promise<RemoveResult> {
  return prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, hairstyleId);
    const media = await tx.hairstyleMedia.findUnique({
      where: { id: mediaId },
      select: { id: true, hairstyleId: true, storageKey: true, type: true },
    });
    if (!media) {
      const prior = await tx.hairstyleMediaCleanupTask.findUnique({
        where: { sourceMediaId: mediaId },
        select: { hairstyleId: true, storageKey: true },
      });
      if (prior?.hairstyleId === hairstyleId) {
        return { mediaId, hairstyleId, storageKey: prior.storageKey, alreadyRemoved: true };
      }
      throw new MediaCleanupError("MEDIA_NOT_FOUND");
    }
    if (media.hairstyleId !== hairstyleId || media.type !== "IMAGE") throw new MediaCleanupError("MEDIA_NOT_FOUND");

    await tx.hairstyleMedia.delete({ where: { id: media.id } });
    await tx.hairstyleMediaCleanupTask.upsert({
      where: { storageKey_operation: { storageKey: media.storageKey, operation: "DELETE_BLOB" } },
      create: { hairstyleId, sourceMediaId: media.id, storageKey: media.storageKey },
      update: {},
    });
    return { mediaId: media.id, hairstyleId, storageKey: media.storageKey, alreadyRemoved: false };
  });
}

/** Records an uploaded object whose metadata transaction failed. Safe for callback retries. */
export async function queueUnattachedHairstyleImageCleanup(hairstyleId: string, storageKey: string): Promise<void> {
  const now = await databaseNow();
  await prisma.hairstyleMediaCleanupTask.upsert({
    where: { storageKey_operation: { storageKey, operation: "DELETE_BLOB" } },
    create: {
      hairstyleId,
      storageKey,
      nextAttemptAt: new Date(now.getTime() + UNATTACHED_UPLOAD_GRACE_MS),
    },
    // Do not move an existing scheduled cleanup earlier or overwrite a task
    // created by an administrator removing metadata.
    update: {},
  });
}

/**
 * A bounded, lease-fenced worker. It can be invoked by a protected cron route
 * or another internal scheduler; no request input selects an object path.
 */
export async function runHairstyleMediaCleanup(
  options: {
    limit?: number;
    blob?: BlobClientUploadGateway;
    now?: () => Promise<Date>;
    afterClaim?: (task: Pick<HairstyleMediaCleanupTask, "id" | "storageKey" | "leaseToken">) => Promise<void>;
  } = {},
): Promise<MediaCleanupSummary> {
  const summary: MediaCleanupSummary = { completed: 0, failed: 0, exhausted: 0, skipped: 0 };
  const blob = options.blob ?? vercelBlobClientGateway;
  const now = options.now ?? databaseNow;
  const config = loadBlobStorageConfig(process.env);
  if (!config) throw new MediaCleanupError("STORAGE_NOT_CONFIGURED");

  for (let count = 0; count < (options.limit ?? CLEANUP_BATCH_LIMIT); count += 1) {
    const claimed = await claimNextTask(await now());
    if (!claimed) break;
    await options.afterClaim?.(claimed);

    // A callback may have attached this Blob during its grace window. This
    // check happens after the lease claim, immediately before any provider call.
    const attached = await prisma.hairstyleMedia.findUnique({
      where: { storageKey: claimed.storageKey },
      select: { id: true },
    });
    if (attached) {
      if (await completeClaim(claimed.id, claimed.leaseToken!, await now())) summary.skipped += 1;
      continue;
    }

    try {
      await blob.delete(blobUrl(config.publicBaseUrl, claimed.storageKey), config.token);
      if (await completeClaim(claimed.id, claimed.leaseToken!, await now())) summary.completed += 1;
    } catch (error) {
      // Vercel Blob deletion is idempotent; a 404 means the desired end state.
      if (isMissingBlob(error)) {
        if (await completeClaim(claimed.id, claimed.leaseToken!, await now())) summary.completed += 1;
        continue;
      }
      const terminal = claimed.attemptCount >= CLEANUP_MAX_ATTEMPTS;
      const nextAttemptAt = new Date((await now()).getTime() + retryDelayMs(claimed.attemptCount));
      const finalised = await prisma.hairstyleMediaCleanupTask.updateMany({
        where: { id: claimed.id, state: "PROCESSING", leaseToken: claimed.leaseToken },
        data: {
          state: terminal ? "FAILED" : "PENDING",
          leaseToken: null,
          leasedAt: null,
          nextAttemptAt,
          lastFailure: terminal ? "deletion-attempts-exhausted" : "provider-deletion-failed",
        },
      });
      if (finalised.count === 1) summary[terminal ? "exhausted" : "failed"] += 1;
    }
  }
  return summary;
}

export class MediaCleanupError extends Error {
  constructor(readonly code: "MEDIA_NOT_FOUND" | "STORAGE_NOT_CONFIGURED") {
    super(code === "MEDIA_NOT_FOUND" ? "The image was not found." : "Blob storage is not configured.");
    this.name = "MediaCleanupError";
  }
}

async function claimNextTask(now: Date) {
  const staleBefore = new Date(now.getTime() - CLEANUP_LEASE_MS);
  const candidate = await prisma.hairstyleMediaCleanupTask.findFirst({
    where: {
      OR: [
        { state: "PENDING", nextAttemptAt: { lte: now }, attemptCount: { lt: CLEANUP_MAX_ATTEMPTS } },
        { state: "PROCESSING", leasedAt: { lte: staleBefore }, attemptCount: { lt: CLEANUP_MAX_ATTEMPTS } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, storageKey: true, state: true, attemptCount: true, leasedAt: true },
  });
  if (!candidate) return null;
  const leaseToken = randomUUID();
  const claim = await prisma.hairstyleMediaCleanupTask.updateMany({
    where: { id: candidate.id, state: candidate.state, attemptCount: candidate.attemptCount, leasedAt: candidate.leasedAt },
    data: { state: "PROCESSING", attemptCount: candidate.attemptCount + 1, leaseToken, leasedAt: now, lastFailure: null },
  });
  return claim.count === 1
    ? { id: candidate.id, storageKey: candidate.storageKey, leaseToken, attemptCount: candidate.attemptCount + 1 }
    : null;
}

async function completeClaim(id: string, leaseToken: string, now: Date): Promise<boolean> {
  const complete = await prisma.hairstyleMediaCleanupTask.updateMany({
    where: { id, state: "PROCESSING", leaseToken },
    data: { state: "COMPLETED", leaseToken: null, leasedAt: null, completedAt: now, lastFailure: null },
  });
  return complete.count === 1;
}

async function lockHairstyle(tx: Prisma.TransactionClient, hairstyleId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Hairstyle" WHERE "id" = ${hairstyleId} FOR UPDATE
  `;
  if (rows.length === 0) throw new MediaCleanupError("MEDIA_NOT_FOUND");
}

async function databaseNow(): Promise<Date> {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}

function blobUrl(baseUrl: string, storageKey: string): string {
  return new URL(storageKey, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function retryDelayMs(attempt: number) {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

function isMissingBlob(error: unknown) {
  const value = error as { statusCode?: unknown; status?: unknown; code?: unknown } | null;
  return value?.statusCode === 404 || value?.status === 404 || value?.code === "BlobNotFound" || value?.code === "not_found";
}
