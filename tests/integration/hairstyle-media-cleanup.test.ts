import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { signInAdmin } from "@/lib/admin/auth";
import { ADMIN_COOKIE_NAME } from "@/lib/admin/session-cookie";
import { provisionAdminPassword } from "@/lib/admin/provision";
import {
  attachHairstyleImage,
  createCategory,
  createHairstyle,
  createHairstyleVariant,
} from "@/lib/catalog";
import { removeHairstyleImageApi } from "@/lib/http/admin-hairstyle-media-removal-api";
import {
  CLEANUP_LEASE_MS,
  UNATTACHED_UPLOAD_GRACE_MS,
  removeHairstyleImageAndQueueCleanup,
  queueUnattachedHairstyleImageCleanup,
  runHairstyleMediaCleanup,
} from "@/lib/media/hairstyle-media-cleanup";
import type { BlobClientUploadGateway } from "@/lib/media/vercel-blob-client";
import { prisma } from "@/lib/prisma";

import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const ORIGIN = "https://media-cleanup.example.test";
const PASSWORD = "Media-Cleanup-2026!";
const FAST = { hashParams: { N: 2 ** 14, r: 8, p: 1 } };
const environmentKeys = ["APP_BASE_URL", "RATE_LIMIT_SECRET", "TRUSTED_CLIENT_IP_SOURCE", "NODE_ENV", "BLOB_READ_WRITE_TOKEN", "BLOB_PUBLIC_BASE_URL"] as const;
const previous = new Map<string, string | undefined>();

function fakeBlob(behaviour: "ok" | "missing" | "fails" = "ok") {
  let calls = 0;
  const gateway: BlobClientUploadGateway = {
    async handle() { throw new Error("not used"); },
    async head() { throw new Error("not used"); },
    async delete() {
      calls += 1;
      if (behaviour === "missing") throw Object.assign(new Error("missing"), { statusCode: 404 });
      if (behaviour === "fails") throw new Error("provider unavailable");
    },
  };
  return { gateway, calls: () => calls };
}

function request(styleId: string, mediaId: string, token?: string, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/admin/hairstyles/${styleId}/media/${mediaId}/remove`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(token ? { cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {}) },
    body: "{}",
  });
}

async function adminToken() {
  await provisionAdminPassword({ email: "cleanup-owner@example.test", password: PASSWORD }, FAST);
  const result = await signInAdmin("cleanup-owner@example.test", PASSWORD);
  assert.equal(result.ok, true);
  return (result as { token: string }).token;
}

async function style(name = "Cleanup") {
  const category = await createCategory({ name: `Braids ${name}`, slug: `braids-${name.toLowerCase()}` });
  return createHairstyle({ categoryId: category.id, name, slug: name.toLowerCase() });
}

describe("hairstyle media durable cleanup", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  before(() => {
    for (const key of environmentKeys) previous.set(key, process.env[key]);
    Object.assign(process.env as Record<string, string | undefined>, {
      APP_BASE_URL: ORIGIN,
      RATE_LIMIT_SECRET: "c".repeat(40),
      TRUSTED_CLIENT_IP_SOURCE: "none",
      NODE_ENV: "test",
      BLOB_READ_WRITE_TOKEN: "blob-test-token-for-guarded-integration-only",
      BLOB_PUBLIC_BASE_URL: "https://store.public.blob.vercel-storage.com",
    });
  });

  after(() => {
    for (const key of environmentKeys) {
      const value = previous.get(key);
      if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else (process.env as Record<string, string | undefined>)[key] = value;
    }
  });

  it("requires an admin, rejects cross-hairstyle removal, and atomically hides metadata with one cleanup task", async () => {
    const token = await adminToken();
    const first = await style("First");
    const second = await style("Second");
    const media = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/first/remove.jpg" });

    assert.equal((await removeHairstyleImageApi(request(first.id, media.id), first.id, media.id)).status, 401);
    assert.equal((await removeHairstyleImageApi(request(second.id, media.id, token), second.id, media.id)).status, 404);
    assert.equal(await prisma.hairstyleMedia.count({ where: { id: media.id } }), 1);

    const removed = await removeHairstyleImageApi(request(first.id, media.id, token), first.id, media.id);
    assert.equal(removed.status, 200);
    assert.equal(await prisma.hairstyleMedia.count({ where: { id: media.id } }), 0);
    assert.equal(await prisma.hairstyleMediaCleanupTask.count({ where: { sourceMediaId: media.id, storageKey: media.storageKey } }), 1);
    const repeated = await removeHairstyleImageApi(request(first.id, media.id, token), first.id, media.id);
    assert.equal(repeated.status, 200);
    assert.equal(await prisma.hairstyleMediaCleanupTask.count(), 1);
  });

  it("rolls metadata removal back when the cleanup outbox cannot be written", async () => {
    const first = await style("Atomic");
    const media = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/atomic/visible.jpg" });
    // This is a narrowly scoped database conflict: the task's source-media
    // uniqueness will reject the enqueue after metadata deletion has started.
    await prisma.hairstyleMediaCleanupTask.create({
      data: { hairstyleId: first.id, sourceMediaId: media.id, storageKey: "hairstyles/atomic/conflict.jpg" },
    });
    await assert.rejects(removeHairstyleImageAndQueueCleanup(first.id, media.id));
    assert.equal(await prisma.hairstyleMedia.count({ where: { id: media.id } }), 1);
    assert.equal(await prisma.hairstyleMediaCleanupTask.count({ where: { storageKey: media.storageKey } }), 0);
  });

  it("deletes exactly once, treats missing blobs as complete, and retries provider failures", async () => {
    const first = await style("Worker");
    const one = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/worker/one.jpg" });
    const two = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/worker/two.jpg" });
    await removeHairstyleImageApi(request(first.id, one.id, await adminToken()), first.id, one.id);
    await removeHairstyleImageApi(request(first.id, two.id, await adminToken()), first.id, two.id);
    const missing = fakeBlob("missing");
    assert.deepEqual(await runHairstyleMediaCleanup({ blob: missing.gateway }), { processed: 2, completed: 2, failed: 0, exhausted: 0, skipped: 0 });
    assert.equal(missing.calls(), 2);
    assert.equal(await prisma.hairstyleMediaCleanupTask.count({ where: { state: "COMPLETED" } }), 2);

    const third = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/worker/retry.jpg" });
    await removeHairstyleImageApi(request(first.id, third.id, await adminToken()), first.id, third.id);
    const failed = fakeBlob("fails");
    assert.deepEqual(await runHairstyleMediaCleanup({ blob: failed.gateway }), { processed: 1, completed: 0, failed: 1, exhausted: 0, skipped: 0 });
    const task = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({ where: { storageKey_operation: { storageKey: third.storageKey, operation: "DELETE_BLOB" } } });
    assert.equal(task.state, "PENDING");
    await prisma.hairstyleMediaCleanupTask.update({ where: { id: task.id }, data: { nextAttemptAt: new Date(0) } });
    const success = fakeBlob();
    assert.deepEqual(await runHairstyleMediaCleanup({ blob: success.gateway }), { processed: 1, completed: 1, failed: 0, exhausted: 0, skipped: 0 });
  });

  it("fences concurrent workers and never deletes a subsequently attached object", async () => {
    const first = await style("Fence");
    await queueUnattachedHairstyleImageCleanup(first.id, "hairstyles/fence/retry.jpg");
    await prisma.hairstyleMediaCleanupTask.updateMany({ data: { nextAttemptAt: new Date(0) } });
    const slow = fakeBlob();
    const [left, right] = await Promise.all([
      runHairstyleMediaCleanup({ blob: slow.gateway, limit: 1 }),
      runHairstyleMediaCleanup({ blob: slow.gateway, limit: 1 }),
    ]);
    assert.equal(slow.calls(), 1);
    assert.equal(left.completed + right.completed, 1);

    await queueUnattachedHairstyleImageCleanup(first.id, "hairstyles/fence/attached.jpg");
    await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/fence/attached.jpg" });
    await prisma.hairstyleMediaCleanupTask.updateMany({ where: { storageKey: "hairstyles/fence/attached.jpg" }, data: { nextAttemptAt: new Date(0) } });
    const protectedBlob = fakeBlob();
    const result = await runHairstyleMediaCleanup({ blob: protectedBlob.gateway });
    assert.equal(result.processed, 0);
    assert.equal(protectedBlob.calls(), 0);
    assert.equal(
      await prisma.hairstyleMediaCleanupTask.count({
        where: { storageKey: "hairstyles/fence/attached.jpg" },
      }),
      0,
    );
  });

  it("fences attachment after a worker claim and rejects reattachment of an explicitly removed key", async () => {
    const first = await style("AttachFence");
    const racingKey = "hairstyles/attach-fence/racing.jpg";
    await queueUnattachedHairstyleImageCleanup(first.id, racingKey);
    await prisma.hairstyleMediaCleanupTask.updateMany({ where: { storageKey: racingKey }, data: { nextAttemptAt: new Date(0) } });
    let release!: () => void;
    let claimed!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const claimReady = new Promise<void>((resolve) => { claimed = resolve; });
    const deleting = fakeBlob();
    const run = runHairstyleMediaCleanup({
      blob: deleting.gateway,
      limit: 1,
      afterClaim: async () => { claimed(); await paused; },
    });
    await claimReady;
    await assert.rejects(
      attachHairstyleImage({ hairstyleId: first.id, storageKey: racingKey }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "STORAGE_KEY_TOMBSTONED",
    );
    release();
    assert.equal((await run).completed, 1);
    assert.equal(deleting.calls(), 1);

    const removable = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/attach-fence/removed.jpg" });
    await removeHairstyleImageAndQueueCleanup(first.id, removable.id);
    await assert.rejects(
      attachHairstyleImage({ hairstyleId: first.id, storageKey: removable.storageKey }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "STORAGE_KEY_TOMBSTONED",
    );
  });

  it("cancels obsolete orphan tasks, allows later deletion, and protects shared canonical URLs", async () => {
    const first = await style("Requeue");
    const attached = await attachHairstyleImage({ hairstyleId: first.id, storageKey: "hairstyles/requeue/attached.jpg" });
    await queueUnattachedHairstyleImageCleanup(first.id, attached.storageKey);
    await prisma.hairstyleMediaCleanupTask.updateMany({ where: { storageKey: attached.storageKey }, data: { nextAttemptAt: new Date(0) } });
    const skippedBlob = fakeBlob();
    assert.equal((await runHairstyleMediaCleanup({ blob: skippedBlob.gateway })).skipped, 1);
    assert.equal(skippedBlob.calls(), 0);
    assert.equal(await prisma.hairstyleMediaCleanupTask.count({ where: { storageKey: attached.storageKey } }), 0);

    await removeHairstyleImageAndQueueCleanup(first.id, attached.id);
    const deletedBlob = fakeBlob();
    assert.equal((await runHairstyleMediaCleanup({ blob: deletedBlob.gateway })).completed, 1);
    assert.equal(deletedBlob.calls(), 1);

    const canonicalKey = "hairstyles/requeue/shared.jpg";
    await attachHairstyleImage({
      hairstyleId: first.id,
      storageKey: "legacy/alias-for-shared.jpg",
      deliveryUrl: `https://store.public.blob.vercel-storage.com/${canonicalKey}`,
    });
    await queueUnattachedHairstyleImageCleanup(first.id, canonicalKey);
    await prisma.hairstyleMediaCleanupTask.updateMany({ where: { storageKey: canonicalKey }, data: { nextAttemptAt: new Date(0) } });
    const protectedBlob = fakeBlob();
    assert.equal((await runHairstyleMediaCleanup({ blob: protectedBlob.gateway })).skipped, 1);
    assert.equal(protectedBlob.calls(), 0);
  });

  it("fences a stale lease before provider deletion and cleans variant-gallery media like service media", async () => {
    const first = await style("Stale");
    const variant = await createHairstyleVariant({ hairstyleId: first.id, name: "Variant", priceCents: 20_000 });
    const media = await attachHairstyleImage({
      hairstyleId: first.id,
      hairstyleVariantId: variant.id,
      storageKey: "hairstyles/stale/variant.jpg",
    });
    await removeHairstyleImageAndQueueCleanup(first.id, media.id);

    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let claimed!: () => void;
    const claimedReady = new Promise<void>((resolve) => { claimed = resolve; });
    const staleBlob = fakeBlob();
    const staleRun = runHairstyleMediaCleanup({
      blob: staleBlob.gateway,
      limit: 1,
      afterClaim: async () => {
        claimed();
        await paused;
      },
    });
    await claimedReady;

    const task = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({
      where: { storageKey_operation: { storageKey: media.storageKey, operation: "DELETE_BLOB" } },
    });
    await prisma.hairstyleMediaCleanupTask.update({
      where: { id: task.id },
      data: { leasedAt: new Date(Date.now() - CLEANUP_LEASE_MS - 1_000) },
    });

    const freshBlob = fakeBlob();
    assert.deepEqual(
      await runHairstyleMediaCleanup({ blob: freshBlob.gateway, limit: 1 }),
      { processed: 1, completed: 1, failed: 0, exhausted: 0, skipped: 0 },
    );
    release();
    assert.deepEqual(
      await staleRun,
      { processed: 1, completed: 0, failed: 0, exhausted: 0, skipped: 0 },
    );
    assert.equal(staleBlob.calls(), 0);
    assert.equal(freshBlob.calls(), 1);
    const completed = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.deepEqual([completed.state, completed.attemptCount, completed.leaseToken], ["COMPLETED", 2, null]);
  });

  it("persists failed-upload reconciliation with a grace period", async () => {
    const first = await style("Grace");
    const before = Date.now();
    await queueUnattachedHairstyleImageCleanup(first.id, "hairstyles/grace/unattached.jpg");
    await queueUnattachedHairstyleImageCleanup(first.id, "hairstyles/grace/unattached.jpg");
    const task = await prisma.hairstyleMediaCleanupTask.findUniqueOrThrow({ where: { storageKey_operation: { storageKey: "hairstyles/grace/unattached.jpg", operation: "DELETE_BLOB" } } });
    assert.equal(await prisma.hairstyleMediaCleanupTask.count({ where: { storageKey: task.storageKey } }), 1);
    assert.ok(task.nextAttemptAt.getTime() >= before + UNATTACHED_UPLOAD_GRACE_MS - 1000);
    assert.ok(CLEANUP_LEASE_MS > 0);
  });
});
