"use client";

/* eslint-disable @next/next/no-img-element -- Blob hosts are deployment-configured and local previews use object URLs. */

import { upload } from "@vercel/blob/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./Admin.module.css";

export type ServicePhoto = {
  id: string;
  type: "IMAGE" | "VIDEO";
  deliveryUrl: string | null;
  altText: string | null;
  caption: string | null;
  sortOrder: number;
};

type UploadRow = { key: string; file: File; previewUrl: string; status: "ready" | "uploading" | "complete" | "failed"; progress: number; message?: string };
type Intent = { pathname: string; clientPayload: string; uploadUrl: string };

const MAX_IMAGES = 8;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorMessage(response: Response) {
  return response.json().catch(() => null).then((body: { error?: { message?: string } } | null) => body?.error?.message ?? "The photo change could not be saved.");
}

function RemoveDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); previous.current?.focus(); };
  }, [onCancel]);
  return <div className={styles.dialogBackdrop} role="presentation">
    <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="remove-photo-title">
      <div className={styles.dialogHeading}><div><p className={styles.eyebrow}>Remove photo</p><h2 id="remove-photo-title">Remove this portfolio photo?</h2></div><button type="button" className={styles.close} onClick={onCancel} aria-label="Close removal confirmation">×</button></div>
      <p className={styles.notice}>This hides the image from the salon portfolio and schedules secure storage cleanup. Historical appointments are not changed.</p>
      <div className={styles.dialogActions}><button type="button" className={styles.secondary} onClick={onCancel}>Keep photo</button><button ref={button} type="button" className={styles.danger} onClick={onConfirm}>Remove photo</button></div>
    </section>
  </div>;
}

/** Client-only gallery. Server APIs remain the authority for media ownership and storage lifecycle. */
export function AdminServicePhotoGallery({ serviceId, media: initialMedia }: { serviceId: string; media: ServicePhoto[] }) {
  const router = useRouter();
  const [media, setMedia] = useState(initialMedia);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef<UploadRow[]>([]);

  useEffect(() => { uploadsRef.current = uploads; }, [uploads]);
  useEffect(() => () => uploadsRef.current.forEach((row) => URL.revokeObjectURL(row.previewUrl)), []);

  const photos = useMemo(() => media.filter((item) => item.type === "IMAGE").sort((a, b) => a.sortOrder - b.sortOrder), [media]);
  const usableCover = photos.find((item) => item.deliveryUrl !== null)?.id ?? null;
  const available = MAX_IMAGES - photos.length - uploads.filter((row) => row.status !== "failed").length;

  function selectFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const next: UploadRow[] = [];
    const failures: string[] = [];
    for (const file of Array.from(event.target.files ?? []).slice(0, Math.max(0, available))) {
      if (!IMAGE_TYPES.has(file.type)) { failures.push(`${file.name}: choose JPEG, PNG, or WebP.`); continue; }
      if (file.size > MAX_BYTES) { failures.push(`${file.name}: images must be 10 MB or smaller.`); continue; }
      next.push({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "ready", progress: 0 });
    }
    if ((event.target.files?.length ?? 0) > Math.max(0, available)) failures.push(`A hairstyle can have at most ${MAX_IMAGES} photos.`);
    setUploads((current) => [...current, ...next]);
    setError(failures.length ? failures.join(" ") : null);
    event.target.value = "";
  }

  function updateUpload(key: string, update: Partial<UploadRow>) {
    setUploads((current) => current.map((row) => row.key === key ? { ...row, ...update } : row));
  }

  async function uploadOne(row: UploadRow) {
    updateUpload(row.key, { status: "uploading", progress: 1, message: undefined });
    try {
      const intentResponse = await fetch(`/api/admin/hairstyles/${encodeURIComponent(serviceId)}/media/upload-intent`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contentType: row.file.type }),
      });
      if (!intentResponse.ok) throw new Error(await errorMessage(intentResponse));
      const intent = await intentResponse.json() as Intent;
      await upload(intent.pathname, row.file, {
        access: "public",
        contentType: row.file.type,
        handleUploadUrl: intent.uploadUrl,
        clientPayload: intent.clientPayload,
        onUploadProgress: ({ percentage }) => updateUpload(row.key, { progress: Math.max(1, Math.round(percentage)) }),
      });
      updateUpload(row.key, { status: "complete", progress: 100, message: "Attached" });
    } catch (caught) {
      updateUpload(row.key, { status: "failed", message: caught instanceof Error ? caught.message : "Upload failed." });
    }
  }

  async function uploadSelected() {
    const ready = uploads.filter((row) => row.status === "ready" || row.status === "failed");
    if (!ready.length || busy) return;
    setBusy(true); setError(null); setMessage(null);
    for (const row of ready) await uploadOne(row);
    setBusy(false);
    setMessage("Finished processing selected photos.");
    router.refresh();
  }

  async function saveMetadata(photo: ServicePhoto) {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/admin/hairstyles/${encodeURIComponent(serviceId)}/media`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "metadata", mediaId: photo.id, altText: photo.altText, caption: photo.caption }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const payload = await response.json() as { media: ServicePhoto };
      setMedia((current) => current.map((item) => item.id === photo.id ? payload.media : item));
      setMessage("Photo details saved.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The photo details could not be saved."); }
    finally { setBusy(false); }
  }

  async function order(next: ServicePhoto[]) {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      // The API intentionally requires every gallery record. Keep any future
      // non-image records in place while moving only the requested photos.
      const nextPhotos = [...next];
      let photoIndex = 0;
      const complete = [...media]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => item.type === "IMAGE" ? nextPhotos[photoIndex++]! : item);
      const response = await fetch(`/api/admin/hairstyles/${encodeURIComponent(serviceId)}/media`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "order", orderedMediaIds: complete.map((item) => item.id) }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const payload = await response.json() as { media: ServicePhoto[] };
      setMedia(payload.media); setMessage("Photo order saved.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The photo order could not be saved."); }
    finally { setBusy(false); }
  }

  async function removePhoto(photo: ServicePhoto) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/admin/hairstyles/${encodeURIComponent(serviceId)}/media/${encodeURIComponent(photo.id)}/remove`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setMedia((current) => current.filter((item) => item.id !== photo.id));
      setMessage("Photo removed from the portfolio. Secure storage cleanup was scheduled.");
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The photo could not be removed."); }
    finally { setBusy(false); setRemoving(null); }
  }

  return <section className={styles.photoGallery} aria-labelledby="photos-heading">
    <div className={styles.variantHeading}><div><p className={styles.eyebrow}>Portfolio</p><h2 id="photos-heading">Photos</h2><p>First ordered photo with a delivery URL is the cover image. Up to {MAX_IMAGES} JPEG, PNG, or WebP images.</p></div><button type="button" className={styles.secondary} onClick={() => input.current?.click()} disabled={busy || available <= 0}>Select photos</button></div>
    <input ref={input} className={styles.visuallyHidden} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectFiles} disabled={busy || available <= 0} />
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {message ? <p className={styles.actionMessage} role="status">{message}</p> : null}
    {uploads.length ? <div className={styles.pendingUploads}>{uploads.map((row) => <div className={styles.pendingUpload} key={row.key}><img src={row.previewUrl} alt="" /><div><strong>{row.file.name}</strong><span>{row.status === "uploading" ? `Uploading ${row.progress}%` : row.message ?? "Ready to upload"}</span></div>{row.status !== "uploading" && row.status !== "complete" ? <button type="button" className={styles.inlineButton} onClick={() => setUploads((current) => current.filter((item) => item.key !== row.key))}>Remove</button> : null}</div>)}</div> : null}
    {uploads.some((row) => row.status === "ready" || row.status === "failed") ? <button type="button" className={styles.primary} disabled={busy} onClick={uploadSelected}>{busy ? "Uploading…" : "Upload selected photos"}</button> : null}
    {photos.length === 0 ? <p className={styles.empty}>No portfolio photos yet. Select images to build this service’s gallery.</p> : <div className={styles.photoGrid}>{photos.map((photo, index) => <article className={styles.photoCard} key={photo.id}>
      <div className={styles.photoPreview}>{photo.deliveryUrl ? <img src={photo.deliveryUrl} alt={photo.altText ?? ""} /> : <p>Image unavailable</p>}{photo.id === usableCover ? <span className={styles.coverBadge}>Cover photo</span> : null}</div>
      <div className={styles.photoControls}>
        <label className={styles.actionLabel}>Alt text <span className={styles.fieldHint}>Optional</span><input value={photo.altText ?? ""} onChange={(event) => setMedia((current) => current.map((item) => item.id === photo.id ? { ...item, altText: event.target.value } : item))} maxLength={500} disabled={busy} /></label>
        <label className={styles.actionLabel}>Caption <span className={styles.fieldHint}>Optional</span><textarea value={photo.caption ?? ""} onChange={(event) => setMedia((current) => current.map((item) => item.id === photo.id ? { ...item, caption: event.target.value } : item))} maxLength={1000} disabled={busy} /></label>
        <div className={styles.photoActions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => saveMetadata(photo)}>Save details</button><button type="button" className={styles.inlineButton} disabled={busy || index === 0} onClick={() => order(photos.map((item, position) => position === index ? photos[index - 1]! : position === index - 1 ? photo : item))}>Move left</button><button type="button" className={styles.inlineButton} disabled={busy || index === photos.length - 1} onClick={() => order(photos.map((item, position) => position === index ? photos[index + 1]! : position === index + 1 ? photo : item))}>Move right</button><button type="button" className={styles.inlineButton} disabled={busy || photo.id === usableCover} onClick={() => order([photo, ...photos.filter((item) => item.id !== photo.id)])}>Make cover photo</button><button type="button" className={styles.danger} disabled={busy} onClick={() => setRemoving(photo.id)}>Remove</button></div>
      </div>
    </article>)}</div>}
    {removing ? <RemoveDialog onCancel={() => setRemoving(null)} onConfirm={() => { const photo = photos.find((item) => item.id === removing); if (photo) void removePhoto(photo); }} /> : null}
  </section>;
}
