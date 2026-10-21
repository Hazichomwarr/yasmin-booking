import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { hashAdminSessionToken, signInAdmin } from "@/lib/admin/auth";
import { provisionAdminPassword } from "@/lib/admin/provision";
import {
  attachHairstyleImage,
  createCategory,
  createHairstyle,
  createHairstyleVariant,
  listHairstyleMedia,
  listPublicHairstyles,
} from "@/lib/catalog";
import { patchHairstyleMediaApi } from "@/lib/http/admin-hairstyle-media-api";
import {
  confirmHairstyleImageUploadApi,
  createHairstyleImageUploadIntentApi,
  handleHairstyleImageUploadApi,
  type AdminHairstyleMediaUploadApiDeps,
} from "@/lib/http/admin-hairstyle-media-upload-api";
import { isApprovedBlobDeliveryUrl } from "@/lib/media/blob-public-origin";
import type { BlobClientUploadGateway } from "@/lib/media/vercel-blob-client";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { prisma } from "@/lib/prisma";

import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const ORIGIN = "https://media-admin.example.test";
const PASSWORD = "Media-Admin-2026!";
const FAST = { hashParams: { N: 2 ** 14, r: 8, p: 1 } };
const previousEnvironment = new Map<string, string | undefined>();
const environmentKeys = [
  "APP_BASE_URL",
  "RATE_LIMIT_SECRET",
  "TRUSTED_CLIENT_IP_SOURCE",
  "NODE_ENV",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_PUBLIC_BASE_URL",
] as const;

type Intent = { pathname: string; clientPayload: string; validUntil: number; uploadUrl: string; confirmUrl: string };

function jsonRequest(url: string, body: unknown, token?: string, origin = ORIGIN, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(token ? { cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function uploadBody(pathname: string, clientPayload: string) {
  return { type: "blob.generate-client-token", payload: { pathname, clientPayload, multipart: false } };
}

function absoluteUploadUrl(intent: Intent) {
  return new URL(intent.uploadUrl, ORIGIN).toString();
}

function completionBody(intent: Intent, contentType = "image/jpeg") {
  return {
    type: "blob.upload-completed",
    payload: {
      blob: {
        pathname: intent.pathname,
        url: `https://store.public.blob.vercel-storage.com/${intent.pathname}`,
        contentType,
      },
      tokenPayload: intent.clientPayload,
    },
  };
}

function blobUrl(intent: Intent) {
  return `https://store.public.blob.vercel-storage.com/${intent.pathname}`;
}

function confirm(styleId: string, intent: Intent, token: string | undefined, blob: BlobClientUploadGateway, overrides: Partial<AdminHairstyleMediaUploadApiDeps> = {}, body: unknown = { clientPayload: intent.clientPayload, url: blobUrl(intent) }, origin = ORIGIN) {
  return confirmHairstyleImageUploadApi(
    jsonRequest(new URL(intent.confirmUrl, ORIGIN).toString(), body, token, origin),
    styleId,
    deps(blob, overrides),
  );
}

function fakeBlob(options: { size?: number; missing?: boolean } = {}) {
  const issued: {
    pathname: string;
    validUntil: number;
    allowedContentTypes: string[];
    maximumSizeInBytes: number;
  }[] = [];
  const gateway: BlobClientUploadGateway = {
    async handle({ body, callbacks }) {
      if (body.type === "blob.generate-client-token") {
        const payload = body.payload;
        const constraints = await callbacks.onBeforeGenerateToken(payload.pathname, payload.clientPayload, payload.multipart);
        issued.push({
          pathname: payload.pathname,
          validUntil: constraints.validUntil,
          allowedContentTypes: constraints.allowedContentTypes,
          maximumSizeInBytes: constraints.maximumSizeInBytes,
        });
        return { type: "blob.generate-client-token", clientToken: `client-${issued.length}` };
      }
      await callbacks.onUploadCompleted(body.payload);
      return { type: "blob.upload-completed", response: "ok" };
    },
    async head(url) {
      if (options.missing) throw new Error("BlobNotFoundError");
      const pathname = new URL(url).pathname.slice(1);
      const extension = pathname.endsWith(".png") ? "image/png" : pathname.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return { url, pathname, contentType: extension, size: options.size ?? 200_000 };
    },
    async delete() {},
  };
  return { gateway, issued };
}

function deps(
  blob: BlobClientUploadGateway,
  overrides: Partial<AdminHairstyleMediaUploadApiDeps> = {},
): AdminHairstyleMediaUploadApiDeps {
  return {
    env: () => process.env,
    resolveSession: (token) => import("@/lib/admin/auth").then(({ resolveAdminSession }) => resolveAdminSession(token)),
    getHairstyle: (id) => import("@/lib/catalog").then(({ getHairstyleDetailForAdmin }) => getHairstyleDetailForAdmin(id)),
    listMedia: (hairstyleId, hairstyleVariantId) => import("@/lib/catalog").then(({ listHairstyleMedia }) => listHairstyleMedia(hairstyleId, hairstyleVariantId)),
    attachImage: (input) => import("@/lib/catalog").then(({ attachHairstyleImageIdempotently }) => attachHairstyleImageIdempotently(input)),
    queueUnattachedCleanup: (hairstyleId, storageKey) => import("@/lib/media/hairstyle-media-cleanup").then(({ queueUnattachedHairstyleImageCleanup }) => queueUnattachedHairstyleImageCleanup(hairstyleId, storageKey)),
    blob,
    log: () => {},
    ...overrides,
  };
}

async function signedIn() {
  await provisionAdminPassword({ email: "media-owner@example.test", password: PASSWORD }, FAST);
  const signedIn = await signInAdmin("media-owner@example.test", PASSWORD);
  assert.equal(signedIn.ok, true);
  return (signedIn as { token: string }).token;
}

async function hairstyle(name = "Knotless", requiresVariant = false) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const category = await createCategory({ name: "Braids", slug: `braids-${slug}` });
  return createHairstyle({ categoryId: category.id, name, slug, requiresVariant });
}

async function issue(
  styleId: string,
  token: string,
  contentType = "image/jpeg",
  blob = fakeBlob().gateway,
  hairstyleVariantId?: string,
) {
  const response = await createHairstyleImageUploadIntentApi(
    jsonRequest(
      `${ORIGIN}/api/admin/hairstyles/${styleId}/media/upload-intent`,
      hairstyleVariantId ? { contentType, hairstyleVariantId } : { contentType },
      token,
    ),
    styleId,
    deps(blob),
  );
  return { response, json: await response.json() as Intent };
}

function patchGallery(styleId: string, token: string, body: unknown) {
  return patchHairstyleMediaApi(
    jsonRequest(`${ORIGIN}/api/admin/hairstyles/${styleId}/media`, body, token, ORIGIN, "PATCH"),
    styleId,
  );
}

describe("admin hairstyle image upload", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  before(() => {
    for (const key of environmentKeys) previousEnvironment.set(key, process.env[key]);
    Object.assign(process.env, {
      APP_BASE_URL: ORIGIN,
      RATE_LIMIT_SECRET: "m".repeat(40),
      TRUSTED_CLIENT_IP_SOURCE: "none",
      NODE_ENV: "test",
      BLOB_READ_WRITE_TOKEN: "blob-test-token-for-guarded-integration-only",
      BLOB_PUBLIC_BASE_URL: "https://store.public.blob.vercel-storage.com",
    });
  });

  after(() => {
    const target = process.env as Record<string, string | undefined>;
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
  });

  it("rejects unauthenticated, cross-origin, invalid-hairstyle, and unsupported-type authorization", async () => {
    const token = await signedIn();
    const style = await hairstyle();
    const blob = fakeBlob();
    assert.equal((await createHairstyleImageUploadIntentApi(jsonRequest(`${ORIGIN}/intent`, { contentType: "image/jpeg" }), style.id, deps(blob.gateway))).status, 401);
    assert.equal((await createHairstyleImageUploadIntentApi(jsonRequest(`${ORIGIN}/intent`, { contentType: "image/jpeg" }, token, "https://attacker.example"), style.id, deps(blob.gateway))).status, 403);
    assert.equal((await createHairstyleImageUploadIntentApi(jsonRequest(`${ORIGIN}/intent`, { contentType: "image/jpeg" }, token), "missing", deps(blob.gateway))).status, 404);
    assert.equal((await createHairstyleImageUploadIntentApi(jsonRequest(`${ORIGIN}/intent`, { contentType: "image/gif" }, token), style.id, deps(blob.gateway))).status, 400);
    assert.equal(await prisma.hairstyleMedia.count(), 0);
  });

  it("authorizes only its issued pathname, rejects oversized objects, and attaches duplicate completions once", async () => {
    const token = await signedIn();
    const style = await hairstyle();
    const normal = fakeBlob();
    const created = await issue(style.id, token, "image/jpeg", normal.gateway);
    assert.equal(created.response.status, 201);
    const intent = created.json;

    const validToken = await handleHairstyleImageUploadApi(
      jsonRequest(absoluteUploadUrl(intent), uploadBody(intent.pathname, intent.clientPayload), token),
      style.id,
      deps(normal.gateway),
    );
    assert.equal(validToken.status, 200);
    assert.deepEqual(normal.issued[0]?.allowedContentTypes, ["image/jpeg", "image/png", "image/webp"]);
    assert.equal(normal.issued[0]?.maximumSizeInBytes, 10 * 1024 * 1024);

    const foreignPath = await handleHairstyleImageUploadApi(
      jsonRequest(absoluteUploadUrl(intent), uploadBody(`hairstyles/${style.id}/attacker.jpg`, intent.clientPayload), token),
      style.id,
      deps(normal.gateway),
    );
    assert.equal(foreignPath.status, 400);

    const oversized = fakeBlob({ size: 10 * 1024 * 1024 + 1 });
    const tooBig = await handleHairstyleImageUploadApi(
      jsonRequest(absoluteUploadUrl(intent), completionBody(intent), undefined),
      style.id,
      deps(oversized.gateway),
    );
    assert.equal(tooBig.status, 400);
    assert.equal(await prisma.hairstyleMedia.count(), 0);

    const completed = await handleHairstyleImageUploadApi(jsonRequest(absoluteUploadUrl(intent), completionBody(intent)), style.id, deps(normal.gateway));
    const retried = await handleHairstyleImageUploadApi(jsonRequest(absoluteUploadUrl(intent), completionBody(intent)), style.id, deps(normal.gateway));
    assert.equal(completed.status, 200);
    assert.equal(retried.status, 200);
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: style.id } }), 1);
  });

  it("rejects cross-hairstyle completion and preserves the eight-image limit under concurrent authorizations", async () => {
    const token = await signedIn();
    const first = await hairstyle("First");
    const second = await hairstyle("Second");
    const firstBlob = fakeBlob();
    const firstIntent = await issue(first.id, token, "image/png", firstBlob.gateway);
    assert.equal(firstIntent.response.status, 201);
    const cross = await handleHairstyleImageUploadApi(jsonRequest(`${ORIGIN}/upload`, completionBody(firstIntent.json, "image/png")), second.id, deps(firstBlob.gateway));
    assert.equal(cross.status, 400);
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: second.id } }), 0);

    for (let index = 0; index < 7; index += 1) {
      await attachHairstyleImage({ hairstyleId: first.id, storageKey: `seed/${index}.jpg`, deliveryUrl: `https://store.public.blob.vercel-storage.com/seed/${index}.jpg` });
    }
    const left = fakeBlob();
    const right = fakeBlob();
    const leftIntent = await issue(first.id, token, "image/jpeg", left.gateway);
    const rightIntent = await issue(first.id, token, "image/webp", right.gateway);
    assert.equal(leftIntent.response.status, 201);
    assert.equal(rightIntent.response.status, 201);
    const results = await Promise.all([
      handleHairstyleImageUploadApi(jsonRequest(absoluteUploadUrl(leftIntent.json), completionBody(leftIntent.json)), first.id, deps(left.gateway)),
      handleHairstyleImageUploadApi(jsonRequest(absoluteUploadUrl(rightIntent.json), completionBody(rightIntent.json, "image/webp")), first.id, deps(right.gateway)),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: first.id, type: "IMAGE" } }), 8);
    const rejectedIntent = results[0]?.status === 409 ? leftIntent.json : rightIntent.json;
    const cleanup = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({
      where: { storageKey_operation: { storageKey: rejectedIntent.pathname, operation: "DELETE_BLOB" } },
    });
    assert.equal(cleanup.state, "PENDING");
  });

  it("returns an explicit reconciliation failure with the storage key when metadata attachment fails", async () => {
    const token = await signedIn();
    const style = await hairstyle();
    const blob = fakeBlob();
    const created = await issue(style.id, token, "image/jpeg", blob.gateway);
    assert.equal(created.response.status, 201);
    const entries: { outcome: string; hairstyleId: string; pathname?: string }[] = [];
    const response = await handleHairstyleImageUploadApi(
      jsonRequest(absoluteUploadUrl(created.json), completionBody(created.json)),
      style.id,
      deps(blob.gateway, {
        attachImage: async () => { throw new Error("database write unavailable"); },
        log: (entry) => entries.push(entry),
      }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(entries, [{
      outcome: "UPLOAD_COMPLETION_PENDING_RECONCILIATION",
      hairstyleId: style.id,
      pathname: created.json.pathname,
    }]);
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: style.id } }), 0);
    const cleanup = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({
      where: { storageKey_operation: { storageKey: created.json.pathname, operation: "DELETE_BLOB" } },
    });
    assert.equal(cleanup.hairstyleId, style.id);
    assert.equal(cleanup.state, "PENDING");
  });

  it("attaches two confirmed uploads in order, makes the first the public cover, and stays idempotent", async () => {
    const token = await signedIn();
    const style = await hairstyle("Gypsy");
    const blob = fakeBlob();
    const first = await issue(style.id, token, "image/jpeg", blob.gateway);
    const second = await issue(style.id, token, "image/png", blob.gateway);
    assert.equal(first.json.confirmUrl, `/api/admin/hairstyles/${style.id}/media/upload/confirm`);

    const firstConfirmed = await confirm(style.id, first.json, token, blob.gateway);
    const secondConfirmed = await confirm(style.id, second.json, token, blob.gateway);
    assert.equal(firstConfirmed.status, 200);
    assert.equal(secondConfirmed.status, 200);
    const firstMedia = (await firstConfirmed.json() as { media: { id: string; hairstyleId: string; deliveryUrl: string; sortOrder: number } }).media;
    assert.equal(firstMedia.hairstyleId, style.id);
    assert.equal(firstMedia.deliveryUrl, blobUrl(first.json));

    // A retried confirmation and a late provider callback converge on one record.
    const retried = await confirm(style.id, first.json, token, blob.gateway);
    assert.equal(retried.status, 200);
    assert.equal((await retried.json() as { media: { id: string } }).media.id, firstMedia.id);
    const callback = await handleHairstyleImageUploadApi(jsonRequest(absoluteUploadUrl(first.json), completionBody(first.json)), style.id, deps(blob.gateway));
    assert.equal(callback.status, 200);

    const stored = await prisma.hairstyleMedia.findMany({ where: { hairstyleId: style.id }, orderBy: { sortOrder: "asc" } });
    assert.deepEqual(stored.map((media) => media.storageKey), [first.json.pathname, second.json.pathname]);
    const [publicStyle] = await listPublicHairstyles({}, {
      isDeliveryUrlAllowed: (url) => isApprovedBlobDeliveryUrl(url, process.env.BLOB_PUBLIC_BASE_URL),
    });
    assert.equal(publicStyle?.coverImage?.deliveryUrl, blobUrl(first.json));
  });

  it("binds variant uploads to the signed variant gallery and keeps late callbacks idempotent", async () => {
    const token = await signedIn();
    const style = await hairstyle("Variant Gallery", true);
    const variant = await createHairstyleVariant({
      hairstyleId: style.id,
      name: "Small",
      priceCents: 24_000,
    });
    const blob = fakeBlob();
    const issued = await issue(style.id, token, "image/webp", blob.gateway, variant.id);
    assert.equal(issued.response.status, 201);

    const confirmed = await confirm(style.id, issued.json, token, blob.gateway);
    assert.equal(confirmed.status, 200);
    const media = (await confirmed.json() as { media: { hairstyleVariantId: string | null } }).media;
    assert.equal(media.hairstyleVariantId, variant.id);
    assert.equal((await listHairstyleMedia(style.id)).length, 0);
    assert.equal((await listHairstyleMedia(style.id, variant.id)).length, 1);

    const callback = await handleHairstyleImageUploadApi(
      jsonRequest(absoluteUploadUrl(issued.json), completionBody(issued.json, "image/webp")),
      style.id,
      deps(blob.gateway),
    );
    assert.equal(callback.status, 200);
    assert.equal((await listHairstyleMedia(style.id, variant.id)).length, 1);

    const other = await hairstyle("Other Variant", true);
    assert.equal((await issue(other.id, token, "image/jpeg", blob.gateway, variant.id)).response.status, 400);
    assert.equal(await prisma.hairstyleMedia.count({ where: { hairstyleId: other.id } }), 0);
  });

  it("enforces gallery-local limits and scopes metadata and ordering to the signed variant gallery", async () => {
    const token = await signedIn();
    const style = await hairstyle("Variant Ordering", true);
    const variant = await createHairstyleVariant({ hairstyleId: style.id, name: "Medium", priceCents: 25_000 });
    const service = await attachHairstyleImage({ hairstyleId: style.id, storageKey: "service/order.jpg" });
    const first = await attachHairstyleImage({ hairstyleId: style.id, hairstyleVariantId: variant.id, storageKey: "variant/order-1.jpg" });
    const second = await attachHairstyleImage({ hairstyleId: style.id, hairstyleVariantId: variant.id, storageKey: "variant/order-2.jpg" });

    const metadata = await patchGallery(style.id, token, {
      kind: "metadata",
      hairstyleVariantId: variant.id,
      mediaId: first.id,
      altText: "Variant detail",
    });
    assert.equal(metadata.status, 200);
    const ordered = await patchGallery(style.id, token, {
      kind: "order",
      hairstyleVariantId: variant.id,
      orderedMediaIds: [second.id, first.id],
    });
    assert.equal(ordered.status, 200);
    assert.deepEqual((await listHairstyleMedia(style.id, variant.id)).map((item) => item.id), [second.id, first.id]);
    assert.deepEqual((await listHairstyleMedia(style.id)).map((item) => item.id), [service.id]);
    assert.equal((await patchGallery(style.id, token, {
      kind: "order",
      hairstyleVariantId: variant.id,
      orderedMediaIds: [service.id],
    })).status, 400);

    for (let index = 0; index < 6; index += 1) {
      await attachHairstyleImage({ hairstyleId: style.id, hairstyleVariantId: variant.id, storageKey: `variant/limit-${index}.jpg` });
    }
    const blocked = await issue(style.id, token, "image/jpeg", fakeBlob().gateway, variant.id);
    assert.equal(blocked.response.status, 409);
    const allowedService = await issue(style.id, token, "image/jpeg", fakeBlob().gateway);
    assert.equal(allowedService.response.status, 201);
  });

  it("accepts a valid legacy version 1 callback only as a service-gallery attachment", async () => {
    const style = await hairstyle("Legacy Callback");
    const signed = {
      v: 1,
      hairstyleId: style.id,
      pathname: `hairstyles/${style.id}/legacy.jpg`,
      contentType: "image/jpeg",
      validUntil: Date.now() + 60_000,
    };
    const encoded = Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
    const clientPayload = `${encoded}.${createHmac("sha256", "blob-test-token-for-guarded-integration-only").update(encoded, "utf8").digest("base64url")}`;
    const legacyIntent = {
      pathname: signed.pathname,
      clientPayload,
      validUntil: signed.validUntil,
      uploadUrl: `/api/admin/hairstyles/${style.id}/media/upload`,
      confirmUrl: `/api/admin/hairstyles/${style.id}/media/upload/confirm`,
    };
    const result = await handleHairstyleImageUploadApi(
      jsonRequest(absoluteUploadUrl(legacyIntent), completionBody(legacyIntent)),
      style.id,
      deps(fakeBlob().gateway),
    );
    assert.equal(result.status, 200);
    const [media] = await listHairstyleMedia(style.id);
    assert.equal(media?.hairstyleVariantId, null);
  });

  it("rejects unauthenticated, cross-origin, foreign-object, tampered, and cross-hairstyle confirmations", async () => {
    const token = await signedIn();
    const style = await hairstyle();
    const other = await hairstyle("Other");
    const blob = fakeBlob();
    const { json: intent } = await issue(style.id, token, "image/jpeg", blob.gateway);

    assert.equal((await confirm(style.id, intent, undefined, blob.gateway)).status, 401);
    assert.equal((await confirm(style.id, intent, token, blob.gateway, {}, undefined, "https://attacker.example")).status, 403);
    assert.equal((await confirm(style.id, intent, token, blob.gateway, {}, { clientPayload: intent.clientPayload })).status, 400);
    const lookalike = await confirm(style.id, intent, token, blob.gateway, {}, {
      clientPayload: intent.clientPayload,
      url: `https://store.public.blob.vercel-storage.com.attacker.example/${intent.pathname}`,
    });
    assert.equal(lookalike.status, 400);
    const otherPath = await confirm(style.id, intent, token, blob.gateway, {}, {
      clientPayload: intent.clientPayload,
      url: `https://store.public.blob.vercel-storage.com/hairstyles/${style.id}/other.jpg`,
    });
    assert.equal(otherPath.status, 400);
    const tampered = await confirm(style.id, intent, token, blob.gateway, {}, { clientPayload: `${intent.clientPayload}x`, url: blobUrl(intent) });
    assert.equal(tampered.status, 400);
    assert.equal((await confirm(other.id, intent, token, blob.gateway)).status, 400);
    assert.equal((await confirm(style.id, intent, token, fakeBlob({ size: 10 * 1024 * 1024 + 1 }).gateway)).status, 400);
    assert.equal(await prisma.hairstyleMedia.count(), 0);
  });

  it("reports a missing storage object and a failed database write without attaching", async () => {
    const token = await signedIn();
    const style = await hairstyle();
    const blob = fakeBlob();
    const { json: intent } = await issue(style.id, token, "image/jpeg", blob.gateway);

    const missing = await confirm(style.id, intent, token, fakeBlob({ missing: true }).gateway);
    assert.equal(missing.status, 502);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, "MEDIA_STORAGE_UNAVAILABLE");

    const entries: { outcome: string; hairstyleId: string; pathname?: string }[] = [];
    const failed = await confirm(style.id, intent, token, blob.gateway, {
      attachImage: async () => { throw new Error("database write unavailable"); },
      log: (entry) => entries.push(entry),
    });
    assert.equal(failed.status, 503);
    assert.match((await failed.json() as { error: { message: string } }).error.message, /Retry to attach it/);
    assert.deepEqual(entries, [{ outcome: "UPLOAD_CONFIRMATION_PENDING_RECONCILIATION", hairstyleId: style.id, pathname: intent.pathname }]);
    assert.equal(await prisma.hairstyleMedia.count(), 0);
    const cleanup = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({
      where: { storageKey_operation: { storageKey: intent.pathname, operation: "DELETE_BLOB" } },
    });
    assert.equal(cleanup.state, "PENDING");

    // Retrying within the grace period still attaches the same object.
    assert.equal((await confirm(style.id, intent, token, blob.gateway)).status, 200);
    assert.equal(await prisma.hairstyleMedia.count({ where: { storageKey: intent.pathname } }), 1);
  });

  it("does not accept an expired session for token issuance", async () => {
    const token = await signedIn();
    const style = await hairstyle();
    const session = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: hashAdminSessionToken(token) } });
    await prisma.adminSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1), createdAt: new Date(Date.now() - 10_000) } });
    const blob = fakeBlob();
    const denied = await createHairstyleImageUploadIntentApi(jsonRequest(`${ORIGIN}/intent`, { contentType: "image/jpeg" }, token), style.id, deps(blob.gateway));
    assert.equal(denied.status, 401);
  });
});
