import type { MediaType, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { CatalogError } from "./errors";
import {
  assertVideoMayBeAttached,
  type VerifiedVideoMetadata,
} from "./media-verification";
import { isRecordNotFound, isUniqueViolationOn } from "./prisma-errors";
import { adminMediaSelect, mediaOrder, type AdminMedia } from "./read-shapes";
import {
  assertCompleteOrdering,
  normalizeDeliveryUrl,
  normalizeOptionalText,
  normalizeStorageKey,
} from "./validation";

/**
 * Hairstyle media METADATA (admin operations).
 *
 * A HairstyleMedia row describes an asset that has already been accepted and
 * stored elsewhere. This module never uploads, reads, or deletes binaries:
 * - attach = record metadata for an existing stored asset
 * - remove = delete the metadata row only; the stored binary is NOT deleted
 *   (no storage provider exists yet — a future storage adapter owns cleanup)
 *
 * Attachment has two explicit entry points:
 * - attachHairstyleImage — the ordinary path; can only create IMAGE records.
 * - attachVerifiedHairstyleVideo — the ONLY path that creates VIDEO records.
 *   It is the trusted boundary for the future server-side media-ingestion
 *   adapter and requires measured metadata (see media-verification.ts).
 *
 * Limits apply independently to each gallery: at most 8 IMAGE and 3 VIDEO
 * records for the service gallery or for each individual variant gallery.
 * VIDEO also requires a verified duration ≤ 30s.
 *
 * Concurrency: attach and reorder lock the parent Hairstyle row
 * (SELECT ... FOR UPDATE) before counting/reading its media, so concurrent
 * attaches to the same hairstyle are serialized and cannot both slip under
 * the limit. This holds for every writer that goes through this module; raw
 * SQL or other code inserting HairstyleMedia directly bypasses it.
 */

export const MEDIA_LIMITS: Readonly<Record<MediaType, number>> = {
  IMAGE: 8,
  VIDEO: 3,
};

type MediaMetadataFields = {
  hairstyleId: string;
  /** Null or omitted means the hairstyle's service-level gallery. */
  hairstyleVariantId?: string | null;
  storageKey: string;
  deliveryUrl?: string | null;
  altText?: string | null;
  caption?: string | null;
};

export type AttachHairstyleImageInput = MediaMetadataFields;

export type IdempotentImageAttachment = {
  media: AdminMedia;
  /** False only when a Blob completion callback is being retried. */
  created: boolean;
};

export type ReplaceHairstyleImageInput = AttachHairstyleImageInput & {
  targetMediaId: string;
  expectedTargetStorageKey: string;
  expectedTargetUpdatedAt: Date;
};

export type AttachVerifiedHairstyleVideoInput = MediaMetadataFields & {
  /**
   * Measurement of the stored asset obtained server-side by media ingestion.
   * Never populate from a request body or browser-reported duration.
   */
  verifiedVideo: VerifiedVideoMetadata;
};

export type RemovedMediaMetadata = {
  mediaId: string;
  hairstyleId: string;
  /** Key of the stored binary that is now unreferenced and still exists. */
  storageKey: string;
  /** Always false: removing metadata never deletes the stored binary. */
  externalAssetDeleted: false;
};

export type UpdateHairstyleMediaMetadataInput = {
  altText?: string | null;
  caption?: string | null;
};

export async function listHairstyleMedia(
  hairstyleId: string,
  hairstyleVariantId?: string | null,
): Promise<AdminMedia[]> {
  const normalizedVariantId = normalizeGalleryVariantId(hairstyleVariantId);
  const hairstyle = await prisma.hairstyle.findUnique({
    where: { id: hairstyleId },
    select: {
      media: {
        where: { hairstyleVariantId: normalizedVariantId },
        select: adminMediaSelect,
        orderBy: mediaOrder,
      },
    },
  });
  if (!hairstyle) throw hairstyleNotFound(hairstyleId);
  await assertVariantBelongsToHairstyle(prisma, hairstyleId, normalizedVariantId);
  return hairstyle.media;
}

/**
 * Records IMAGE metadata for an already-stored asset, appended to the end of
 * the gallery. This path never creates a VIDEO.
 */
export async function attachHairstyleImage(
  input: AttachHairstyleImageInput,
): Promise<AdminMedia> {
  // Guard untyped callers that try to smuggle a VIDEO through the image path.
  const smuggledType: unknown = (input as { type?: unknown }).type;
  if (smuggledType !== undefined && smuggledType !== "IMAGE") {
    throw new CatalogError(
      "INVALID_MEDIA",
      "attachHairstyleImage only attaches images; videos require attachVerifiedHairstyleVideo.",
    );
  }

  return insertMediaWithinLimit("IMAGE", input);
}

/**
 * Completion callbacks are retried by the provider. A repeated callback for
 * the same stored object is safe, while reuse of that object by another
 * hairstyle remains a catalog error.
 */
export async function attachHairstyleImageIdempotently(
  input: AttachHairstyleImageInput,
): Promise<IdempotentImageAttachment> {
  const storageKey = normalizeStorageKey(input.storageKey);
  const deliveryUrl = normalizeDeliveryUrl(input.deliveryUrl);
  const hairstyleVariantId = normalizeGalleryVariantId(input.hairstyleVariantId);

  const existing = await prisma.hairstyleMedia.findUnique({
    where: { storageKey },
    select: adminMediaSelect,
  });
  if (existing) {
    await reconcileExistingImageCleanup(existing, input.hairstyleId, hairstyleVariantId, deliveryUrl);
    return existingImageAttachment(existing, input.hairstyleId, hairstyleVariantId, deliveryUrl);
  }

  try {
    return { media: await attachHairstyleImage({ ...input, hairstyleVariantId, storageKey, deliveryUrl }), created: true };
  } catch (error) {
    if (!isUniqueViolationOn(error, "storageKey")) throw error;
    const afterRace = await prisma.hairstyleMedia.findUnique({
      where: { storageKey },
      select: adminMediaSelect,
    });
    if (afterRace) {
      await reconcileExistingImageCleanup(afterRace, input.hairstyleId, hairstyleVariantId, deliveryUrl);
      return existingImageAttachment(afterRace, input.hairstyleId, hairstyleVariantId, deliveryUrl);
    }
    throw error;
  }
}

/**
 * Atomically replaces one gallery image after its immutable Blob has already
 * been verified. The old public row remains intact unless the new row and its
 * durable deletion task both commit.
 */
export async function replaceHairstyleImageIdempotently(
  input: ReplaceHairstyleImageInput,
): Promise<IdempotentImageAttachment> {
  const hairstyleVariantId = normalizeGalleryVariantId(input.hairstyleVariantId);
  const storageKey = normalizeStorageKey(input.storageKey);
  const deliveryUrl = normalizeDeliveryUrl(input.deliveryUrl);
  const expectedStorageKey = normalizeStorageKey(input.expectedTargetStorageKey);

  return prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, input.hairstyleId);
    await assertVariantBelongsToHairstyle(tx, input.hairstyleId, hairstyleVariantId);

    const alreadyAttached = await tx.hairstyleMedia.findUnique({
      where: { storageKey },
      select: adminMediaSelect,
    });
    if (alreadyAttached) {
      const priorCleanup = await tx.hairstyleMediaCleanupTask.findUnique({
        where: { storageKey_operation: { storageKey: expectedStorageKey, operation: "DELETE_BLOB" } },
        select: { sourceMediaId: true },
      });
      if (
        priorCleanup?.sourceMediaId === input.targetMediaId &&
        alreadyAttached.hairstyleId === input.hairstyleId &&
        alreadyAttached.hairstyleVariantId === hairstyleVariantId &&
        alreadyAttached.type === "IMAGE" &&
        alreadyAttached.deliveryUrl === deliveryUrl
      ) {
        return { media: alreadyAttached, created: false };
      }
      throw new CatalogError("STORAGE_KEY_ALREADY_EXISTS", "The replacement image is already attached elsewhere.");
    }

    const authorizedCleanup = await lockCleanupTask(tx, storageKey);
    assertCleanupAllowsAttachment(authorizedCleanup);
    if (!authorizedCleanup) {
      throw new CatalogError("STORAGE_KEY_TOMBSTONED", "The replacement upload authorization is no longer active.");
    }

    const target = await tx.hairstyleMedia.findFirst({
      where: {
        id: input.targetMediaId,
        hairstyleId: input.hairstyleId,
        hairstyleVariantId,
        type: "IMAGE",
      },
      select: adminMediaSelect,
    });
    if (
      !target ||
      target.storageKey !== expectedStorageKey ||
      target.updatedAt.getTime() !== input.expectedTargetUpdatedAt.getTime()
    ) {
      throw new CatalogError("STALE_MEDIA_REPLACEMENT", "This photo changed after replacement began.");
    }

    const replacement = await tx.hairstyleMedia.create({
      data: {
        hairstyleId: target.hairstyleId,
        hairstyleVariantId: target.hairstyleVariantId,
        type: "IMAGE",
        storageKey,
        deliveryUrl,
        altText: target.altText,
        caption: target.caption,
        sortOrder: target.sortOrder,
      },
      select: adminMediaSelect,
    });
    await tx.hairstyleMedia.delete({ where: { id: target.id } });
    await rearmCleanupTask(tx, target.hairstyleId, target.id, target.storageKey);
    await tx.hairstyleMediaCleanupTask.delete({ where: { id: authorizedCleanup.id } });
    return { media: replacement, created: true };
  });
}

function existingImageAttachment(
  existing: AdminMedia,
  hairstyleId: string,
  hairstyleVariantId: string | null,
  deliveryUrl: string | null,
): IdempotentImageAttachment {
  if (
    existing.hairstyleId === hairstyleId &&
    existing.hairstyleVariantId === hairstyleVariantId &&
    existing.type === "IMAGE" &&
    existing.deliveryUrl === deliveryUrl
  ) {
    return { media: existing, created: false };
  }
  throw new CatalogError(
    "STORAGE_KEY_ALREADY_EXISTS",
    `Stored asset "${existing.storageKey}" is already attached to a hairstyle.`,
  );
}

/**
 * TRUSTED BOUNDARY — for the server-side media-ingestion adapter only.
 *
 * Records VIDEO metadata for an already-stored asset whose duration the caller
 * has measured from the asset itself or from trusted provider metadata.
 * Rejects metadata for a different storageKey (VIDEO_NOT_VERIFIED) and videos
 * over 30 seconds (VIDEO_TOO_LONG). The duration is not persisted.
 */
export async function attachVerifiedHairstyleVideo(
  input: AttachVerifiedHairstyleVideoInput,
): Promise<AdminMedia> {
  assertVideoMayBeAttached(normalizeStorageKey(input.storageKey), input.verifiedVideo);
  return insertMediaWithinLimit("VIDEO", input);
}

async function insertMediaWithinLimit(
  type: MediaType,
  input: MediaMetadataFields,
): Promise<AdminMedia> {
  const data = {
    hairstyleId: input.hairstyleId,
    hairstyleVariantId: normalizeGalleryVariantId(input.hairstyleVariantId),
    type,
    storageKey: normalizeStorageKey(input.storageKey),
    deliveryUrl: normalizeDeliveryUrl(input.deliveryUrl),
    altText: normalizeOptionalText(input.altText) ?? null,
    caption: normalizeOptionalText(input.caption) ?? null,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      await lockHairstyle(tx, data.hairstyleId);
      await assertVariantBelongsToHairstyle(tx, data.hairstyleId, data.hairstyleVariantId);

      const cleanupTask = await lockCleanupTask(tx, data.storageKey);
      assertCleanupAllowsAttachment(cleanupTask);

      const existingOfType = await tx.hairstyleMedia.count({
        where: { hairstyleId: data.hairstyleId, hairstyleVariantId: data.hairstyleVariantId, type },
      });
      const limit = MEDIA_LIMITS[type];
      if (existingOfType >= limit) {
        throw new CatalogError(
          "MEDIA_LIMIT_REACHED",
          `A hairstyle can have at most ${limit} ${type === "IMAGE" ? "images" : "videos"}.`,
        );
      }

      const last = await tx.hairstyleMedia.aggregate({
        where: { hairstyleId: data.hairstyleId, hairstyleVariantId: data.hairstyleVariantId },
        _max: { sortOrder: true },
      });

      const created = await tx.hairstyleMedia.create({
        data: { ...data, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        select: adminMediaSelect,
      });
      if (cleanupTask) await tx.hairstyleMediaCleanupTask.delete({ where: { id: cleanupTask.id } });
      return created;
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "storageKey")) {
      throw new CatalogError(
        "STORAGE_KEY_ALREADY_EXISTS",
        `Stored asset "${data.storageKey}" is already attached to a hairstyle.`,
      );
    }
    throw error;
  }
}

type LockedCleanupTask = {
  id: string;
  sourceMediaId: string | null;
  state: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
};

async function lockCleanupTask(tx: Prisma.TransactionClient, storageKey: string): Promise<LockedCleanupTask | null> {
  const rows = await tx.$queryRaw<LockedCleanupTask[]>`
    SELECT "id", "sourceMediaId", "state"
    FROM "HairstyleMediaCleanupTask"
    WHERE "storageKey" = ${storageKey}
      AND "operation" = 'DELETE_BLOB'::"HairstyleMediaCleanupOperation"
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function assertCleanupAllowsAttachment(task: LockedCleanupTask | null) {
  if (!task) return;
  if (task.sourceMediaId === null && task.state === "PENDING") return;
  throw new CatalogError("STORAGE_KEY_TOMBSTONED", "This stored object is already scheduled for deletion.");
}

async function reconcileExistingImageCleanup(
  existing: AdminMedia,
  hairstyleId: string,
  hairstyleVariantId: string | null,
  deliveryUrl: string | null,
) {
  existingImageAttachment(existing, hairstyleId, hairstyleVariantId, deliveryUrl);
  await prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, hairstyleId);
    const task = await lockCleanupTask(tx, existing.storageKey);
    if (!task) return;
    if (task.sourceMediaId !== null || task.state === "PROCESSING") {
      throw new CatalogError("STORAGE_KEY_TOMBSTONED", "This stored object is already scheduled for deletion.");
    }
    await tx.hairstyleMediaCleanupTask.delete({ where: { id: task.id } });
  });
}

async function rearmCleanupTask(
  tx: Prisma.TransactionClient,
  hairstyleId: string,
  sourceMediaId: string,
  storageKey: string,
) {
  await tx.hairstyleMediaCleanupTask.upsert({
    where: { storageKey_operation: { storageKey, operation: "DELETE_BLOB" } },
    create: { hairstyleId, sourceMediaId, storageKey },
    update: {
      hairstyleId,
      sourceMediaId,
      state: "PENDING",
      attemptCount: 0,
      lastFailure: null,
      nextAttemptAt: new Date(0),
      leaseToken: null,
      leasedAt: null,
      completedAt: null,
    },
  });
}

/**
 * Sets the complete media order of one service or variant gallery.
 * `orderedMediaIds` must list every record in that exact gallery once.
 */
export async function reorderHairstyleMedia(
  hairstyleId: string,
  orderedMediaIds: string[],
  hairstyleVariantId?: string | null,
): Promise<AdminMedia[]> {
  const normalizedVariantId = normalizeGalleryVariantId(hairstyleVariantId);
  await prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, hairstyleId);
    await assertVariantBelongsToHairstyle(tx, hairstyleId, normalizedVariantId);

    const existing = await tx.hairstyleMedia.findMany({
      where: { hairstyleId, hairstyleVariantId: normalizedVariantId },
      select: { id: true, sortOrder: true },
    });
    assertCompleteOrdering(
      orderedMediaIds,
      existing.map((media) => media.id),
      normalizedVariantId ? `variant ${normalizedVariantId}` : `hairstyle ${hairstyleId}`,
    );

    const currentOrder = new Map(existing.map((m) => [m.id, m.sortOrder]));
    for (const [index, id] of orderedMediaIds.entries()) {
      if (currentOrder.get(id) === index) continue;
      await tx.hairstyleMedia.update({ where: { id }, data: { sortOrder: index } });
    }
  });

  return listHairstyleMedia(hairstyleId, normalizedVariantId);
}

/**
 * Updates presentation metadata only. The parent lock proves media ownership
 * and preserves the immutable object key, URL, type, and gallery position.
 */
export async function updateHairstyleMediaMetadata(
  hairstyleId: string,
  mediaId: string,
  input: UpdateHairstyleMediaMetadataInput,
  hairstyleVariantId?: string | null,
): Promise<AdminMedia> {
  const normalizedVariantId = normalizeGalleryVariantId(hairstyleVariantId);
  const altText = normalizeOptionalText(input.altText);
  const caption = normalizeOptionalText(input.caption);
  if (altText === undefined && caption === undefined) {
    throw new CatalogError("INVALID_MEDIA", "Provide alt text or a caption to update.");
  }
  return prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, hairstyleId);
    await assertVariantBelongsToHairstyle(tx, hairstyleId, normalizedVariantId);
    const media = await tx.hairstyleMedia.findFirst({
      where: { id: mediaId, hairstyleId, hairstyleVariantId: normalizedVariantId },
      select: { id: true },
    });
    if (!media) throw new CatalogError("MEDIA_NOT_FOUND", `Media ${mediaId} does not belong to this hairstyle.`);
    return tx.hairstyleMedia.update({
      where: { id: media.id },
      data: {
        ...(altText === undefined ? {} : { altText }),
        ...(caption === undefined ? {} : { caption }),
      },
      select: adminMediaSelect,
    });
  });
}

/**
 * Deletes ONLY the HairstyleMedia database row. The stored binary identified
 * by the returned storageKey is NOT deleted — the caller (a future storage
 * adapter) is responsible for physical cleanup.
 */
export async function removeHairstyleMediaMetadata(
  mediaId: string,
): Promise<RemovedMediaMetadata> {
  try {
    const removed = await prisma.hairstyleMedia.delete({
      where: { id: mediaId },
      select: { id: true, hairstyleId: true, storageKey: true },
    });
    return {
      mediaId: removed.id,
      hairstyleId: removed.hairstyleId,
      storageKey: removed.storageKey,
      externalAssetDeleted: false,
    };
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new CatalogError("MEDIA_NOT_FOUND", `Media ${mediaId} does not exist.`);
    }
    throw error;
  }
}

/** Locks the hairstyle row for the rest of the transaction; throws if missing. */
async function lockHairstyle(tx: Prisma.TransactionClient, hairstyleId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Hairstyle" WHERE "id" = ${hairstyleId} FOR UPDATE
  `;
  if (locked.length === 0) throw hairstyleNotFound(hairstyleId);
}

/** A variant gallery is valid only for a variant owned by the locked hairstyle. */
async function assertVariantBelongsToHairstyle(
  client: Pick<Prisma.TransactionClient, "hairstyleVariant">,
  hairstyleId: string,
  hairstyleVariantId: string | null,
) {
  if (hairstyleVariantId === null) return;
  const variant = await client.hairstyleVariant.findFirst({
    where: { id: hairstyleVariantId, hairstyleId },
    select: { id: true },
  });
  if (!variant) {
    throw new CatalogError("VARIANT_NOT_FOUND", "The selected hairstyle variant does not belong to this hairstyle.");
  }
}

function normalizeGalleryVariantId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError("INVALID_MEDIA", "Variant gallery ownership must be a valid variant ID.");
  }
  return value.trim();
}

function hairstyleNotFound(hairstyleId: string) {
  return new CatalogError("HAIRSTYLE_NOT_FOUND", `Hairstyle ${hairstyleId} does not exist.`);
}
