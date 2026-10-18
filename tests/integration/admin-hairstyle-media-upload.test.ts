import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hashAdminSessionToken, signInAdmin } from "@/lib/admin/auth";
import { provisionAdminPassword } from "@/lib/admin/provision";
import {
  attachHairstyleImage,
  createCategory,
  createHairstyle,
} from "@/lib/catalog";
import {
  createHairstyleImageUploadIntentApi,
  handleHairstyleImageUploadApi,
  type AdminHairstyleMediaUploadApiDeps,
} from "@/lib/http/admin-hairstyle-media-upload-api";
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

type Intent = { pathname: string; clientPayload: string; validUntil: number; uploadUrl: string };

function jsonRequest(url: string, body: unknown, token?: string, origin = ORIGIN) {
  return new Request(url, {
    method: "POST",
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

function fakeBlob(options: { size?: number } = {}) {
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

async function hairstyle(name = "Knotless") {
  const category = await createCategory({ name: "Braids", slug: `braids-${name.toLowerCase()}` });
  return createHairstyle({ categoryId: category.id, name, slug: name.toLowerCase() });
}

async function issue(styleId: string, token: string, contentType = "image/jpeg", blob = fakeBlob().gateway) {
  const response = await createHairstyleImageUploadIntentApi(
    jsonRequest(`${ORIGIN}/api/admin/hairstyles/${styleId}/media/upload-intent`, { contentType }, token),
    styleId,
    deps(blob),
  );
  return { response, json: await response.json() as Intent };
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
