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
 * V1 limits per hairstyle: at most 8 IMAGE and 3 VIDEO records.
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
  storageKey: string;
  deliveryUrl?: string | null;
  altText?: string | null;
  caption?: string | null;
};

export type AttachHairstyleImageInput = MediaMetadataFields;

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

export async function listHairstyleMedia(hairstyleId: string): Promise<AdminMedia[]> {
  const hairstyle = await prisma.hairstyle.findUnique({
    where: { id: hairstyleId },
    select: { media: { select: adminMediaSelect, orderBy: mediaOrder } },
  });
  if (!hairstyle) throw hairstyleNotFound(hairstyleId);
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
    type,
    storageKey: normalizeStorageKey(input.storageKey),
    deliveryUrl: normalizeDeliveryUrl(input.deliveryUrl),
    altText: normalizeOptionalText(input.altText) ?? null,
    caption: normalizeOptionalText(input.caption) ?? null,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      await lockHairstyle(tx, data.hairstyleId);

      const existingOfType = await tx.hairstyleMedia.count({
        where: { hairstyleId: data.hairstyleId, type },
      });
      const limit = MEDIA_LIMITS[type];
      if (existingOfType >= limit) {
        throw new CatalogError(
          "MEDIA_LIMIT_REACHED",
          `A hairstyle can have at most ${limit} ${type === "IMAGE" ? "images" : "videos"}.`,
        );
      }

      const last = await tx.hairstyleMedia.aggregate({
        where: { hairstyleId: data.hairstyleId },
        _max: { sortOrder: true },
      });

      return tx.hairstyleMedia.create({
        data: { ...data, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        select: adminMediaSelect,
      });
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

/**
 * Sets the complete media order of one hairstyle. `orderedMediaIds` must list
 * every media record of that hairstyle exactly once; media belonging to
 * another hairstyle is rejected and never modified.
 */
export async function reorderHairstyleMedia(
  hairstyleId: string,
  orderedMediaIds: string[],
): Promise<AdminMedia[]> {
  await prisma.$transaction(async (tx) => {
    await lockHairstyle(tx, hairstyleId);

    const existing = await tx.hairstyleMedia.findMany({
      where: { hairstyleId },
      select: { id: true, sortOrder: true },
    });
    assertCompleteOrdering(
      orderedMediaIds,
      existing.map((media) => media.id),
      `hairstyle ${hairstyleId}`,
    );

    const currentOrder = new Map(existing.map((m) => [m.id, m.sortOrder]));
    for (const [index, id] of orderedMediaIds.entries()) {
      if (currentOrder.get(id) === index) continue;
      await tx.hairstyleMedia.update({ where: { id }, data: { sortOrder: index } });
    }
  });

  return listHairstyleMedia(hairstyleId);
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

function hairstyleNotFound(hairstyleId: string) {
  return new CatalogError("HAIRSTYLE_NOT_FOUND", `Hairstyle ${hairstyleId} does not exist.`);
}
