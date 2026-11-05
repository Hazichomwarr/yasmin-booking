"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { adminServiceEditPath, type AdminServiceEditNavigation } from "@/lib/admin/service-list";
import { serviceEditorStateHasChanges, type ServiceEditorDraftState } from "@/lib/admin/service-editor-state";

import { AdminServicePhotoGallery, type ServicePhoto } from "./AdminServicePhotoGallery";
import styles from "./Admin.module.css";

export type ServiceEditorCategory = { id: string; name: string };

export type ServiceEditorVariant = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  isActive: boolean;
  sortOrder: number;
  media?: ServicePhoto[];
};

export type ServiceEditorValue = {
  id: string;
  name: string;
  categoryId: string;
  description: string | null;
  priceCents: number | null;
  requiresVariant: boolean;
  isActive: boolean;
  sortOrder: number;
  variants: ServiceEditorVariant[];
  media: ServicePhoto[];
};

type DraftVariant = {
  key: string;
  id?: string;
  name: string;
  description: string;
  price: string;
  isActive: boolean;
  sortOrder: string;
};

type Props = {
  categories: ServiceEditorCategory[];
  service?: ServiceEditorValue;
  returnTo?: string;
  navigation?: AdminServiceEditNavigation;
};
type ApiError = { error?: { message?: string } };
type FieldErrors = Record<string, string>;
type DeactivationTarget = { type: "service" } | { type: "variant"; key: string; remove: boolean };
type NavigationTarget = { href: string; label: string };

function priceString(priceCents: number | null | undefined) {
  return priceCents === null || priceCents === undefined ? "" : (priceCents / 100).toFixed(2);
}

function isPrice(value: string) { return /^\d+(?:\.\d{1,2})?$/.test(value.trim()); }
function variantFrom(value: ServiceEditorVariant): DraftVariant {
  return { key: value.id, id: value.id, name: value.name, description: value.description ?? "", price: priceString(value.priceCents), isActive: value.isActive, sortOrder: String(value.sortOrder) };
}
function emptyVariant(order: number): DraftVariant {
  return { key: crypto.randomUUID(), name: "", description: "", price: "", isActive: false, sortOrder: String(order) };
}
async function readError(response: Response) {
  const json = (await response.json().catch(() => null)) as ApiError | null;
  return json?.error?.message ?? "We could not save this service. Please try again.";
}

function DeactivationDialog({ target, onCancel, onConfirm }: { target: DeactivationTarget; onCancel: () => void; onConfirm: () => void }) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [onCancel]);
  const isService = target.type === "service";
  return <div className={styles.dialogBackdrop} role="presentation">
    <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="deactivation-title">
      <div className={styles.dialogHeading}><div><p className={styles.eyebrow}>Confirm change</p><h2 id="deactivation-title">{isService ? "Make this service a draft?" : "Deactivate this variant?"}</h2></div><button className={styles.close} type="button" onClick={onCancel} aria-label="Close confirmation">×</button></div>
      <p className={styles.notice}>{isService ? "This service will no longer be available for new bookings. Historical appointments remain unchanged." : "This variant will no longer be available for new bookings. Historical appointments remain unchanged."}</p>
      <div className={styles.dialogActions}><button className={styles.secondary} type="button" onClick={onCancel}>Keep active</button><button ref={confirmButton} className={styles.danger} type="button" onClick={onConfirm}>{isService ? "Save as draft" : target.remove ? "Deactivate variant" : "Mark inactive"}</button></div>
    </section>
  </div>;
}

function UnsavedChangesDialog({ target, saving, onStay, onDiscard, onSave }: {
  target: NavigationTarget;
  saving: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const stayButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stayButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onStay(); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [onStay, saving]);
  return <div className={styles.dialogBackdrop} role="presentation">
    <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-description">
      <div className={styles.dialogHeading}><div><p className={styles.eyebrow}>Unsaved changes</p><h2 id="unsaved-title">Leave this service?</h2></div><button className={styles.close} type="button" onClick={onStay} aria-label="Stay on this service" disabled={saving}>×</button></div>
      <p id="unsaved-description" className={styles.notice}>Save your changes before continuing to {target.label}, discard them, or stay on this service.</p>
      <div className={styles.dialogActions}>
        <button ref={stayButton} className={styles.secondary} type="button" onClick={onStay} disabled={saving}>Stay</button>
        <button className={styles.danger} type="button" onClick={onDiscard} disabled={saving}>Discard changes</button>
        <button className={styles.primary} type="button" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save and continue"}</button>
      </div>
    </section>
  </div>;
}

/** Current catalog configuration editor. It never reads or writes appointment snapshots. */
export function AdminServiceEditor({ categories: initialCategories, service, returnTo = "/admin/services", navigation }: Props) {
  const router = useRouter();
  const editing = Boolean(service);
  const [categories, setCategories] = useState(initialCategories);
  const [name, setName] = useState(service?.name ?? "");
  const [categoryId, setCategoryId] = useState(service?.categoryId ?? initialCategories[0]?.id ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [pricingMode, setPricingMode] = useState<"simple" | "variants">(service?.requiresVariant ? "variants" : "simple");
  const [price, setPrice] = useState(priceString(service?.priceCents));
  const [variants, setVariants] = useState<DraftVariant[]>(service?.variants.map(variantFrom) ?? []);
  const [removedVariantIds, setRemovedVariantIds] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(service?.isActive ?? false);
  const [displayOrder, setDisplayOrder] = useState(String(service?.sortOrder ?? 0));
  const [showCategory, setShowCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [saving, setSaving] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [partialCreationId, setPartialCreationId] = useState<string | null>(null);
  const [deactivationTarget, setDeactivationTarget] = useState<DeactivationTarget | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<NavigationTarget | null>(null);
  const originalPricingMode = service?.requiresVariant ? "variants" : "simple";
  const [initialDraft] = useState<ServiceEditorDraftState>(() => ({
    name: service?.name ?? "",
    categoryId: service?.categoryId ?? initialCategories[0]?.id ?? "",
    description: service?.description ?? "",
    pricingMode: service?.requiresVariant ? "variants" : "simple",
    price: priceString(service?.priceCents),
    variants: service?.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      description: variant.description ?? "",
      price: priceString(variant.priceCents),
      isActive: variant.isActive,
      sortOrder: String(variant.sortOrder),
    })) ?? [],
    removedVariantIds: [],
    isActive: service?.isActive ?? false,
    displayOrder: String(service?.sortOrder ?? 0),
    newCategoryName: "",
  }));

  const submitLabel = useMemo(() => saving ? "Saving…" : editing ? "Save service" : "Create service", [editing, saving]);
  const orderedVariants = [...variants].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  const currentDraft = useMemo<ServiceEditorDraftState>(() => ({
    name,
    categoryId,
    description,
    pricingMode,
    price,
    variants: variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      description: variant.description,
      price: variant.price,
      isActive: variant.isActive,
      sortOrder: variant.sortOrder,
    })),
    removedVariantIds,
    isActive,
    displayOrder,
    newCategoryName: categoryName,
  }), [categoryId, categoryName, description, displayOrder, isActive, name, price, pricingMode, removedVariantIds, variants]);
  const dirty = editing && serviceEditorStateHasChanges(currentDraft, initialDraft);

  function updateVariant(key: string, field: keyof Omit<DraftVariant, "key" | "id">, value: string | boolean) {
    setVariants((current) => current.map((variant) => variant.key === key ? { ...variant, [field]: value } : variant));
  }

  async function createCategory() {
    const trimmedName = categoryName.trim();
    if (!trimmedName) return setError("Enter a category name before creating it.");
    setCreatingCategory(true); setError(null);
    try {
      const response = await fetch("/api/admin/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "category", name: trimmedName }) });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await response.json() as { category: ServiceEditorCategory };
      setCategories((current) => [...current, payload.category]);
      setCategoryId(payload.category.id); setCategoryName(""); setShowCategory(false);
      setNotice(`Category “${payload.category.name}” is ready to use.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "We could not create that category."); }
    finally { setCreatingCategory(false); }
  }

  function validate() {
    const errors: FieldErrors = {};
    const fail = (key: string, message: string) => { errors[key] = message; return message; };
    if (!name.trim()) { setFieldErrors({ name: fail("name", "Enter a service name.") }); return errors.name; }
    if (!categoryId) { setFieldErrors({ category: fail("category", "Choose or create a category.") }); return errors.category; }
    if (!Number.isSafeInteger(Number(displayOrder)) || Number(displayOrder) < 0) { setFieldErrors({ displayOrder: fail("displayOrder", "Use a non-negative whole number.") }); return errors.displayOrder; }
    if (pricingMode === "simple") {
      if (price.trim() && !isPrice(price)) { setFieldErrors({ price: fail("price", "Use a USD amount with up to two decimals.") }); return errors.price; }
      if (isActive && !price.trim()) { setFieldErrors({ price: fail("price", "An active service needs a price.") }); return errors.price; }
      setFieldErrors({});
      return null;
    }
    const variantNames = new Set<string>();
    for (const variant of variants) {
      if (!variant.name.trim()) { setFieldErrors({ [`variant:${variant.key}:name`]: fail(`variant:${variant.key}:name`, "Enter a variant name.") }); return errors[`variant:${variant.key}:name`]; }
      if (variant.description.length > 500) { setFieldErrors({ [`variant:${variant.key}:description`]: fail(`variant:${variant.key}:description`, "Variant descriptions can be at most 500 characters.") }); return errors[`variant:${variant.key}:description`]; }
      const normalizedName = variant.name.trim().toLocaleLowerCase();
      if (variantNames.has(normalizedName)) { setFieldErrors({ [`variant:${variant.key}:name`]: fail(`variant:${variant.key}:name`, "This variant name is already in use.") }); return errors[`variant:${variant.key}:name`]; }
      variantNames.add(normalizedName);
      if (variant.price.trim() && !isPrice(variant.price)) { setFieldErrors({ [`variant:${variant.key}:price`]: fail(`variant:${variant.key}:price`, "Use a valid USD amount.") }); return errors[`variant:${variant.key}:price`]; }
      if (!Number.isSafeInteger(Number(variant.sortOrder)) || Number(variant.sortOrder) < 0) { setFieldErrors({ [`variant:${variant.key}:order`]: fail(`variant:${variant.key}:order`, "Use a non-negative whole number.") }); return errors[`variant:${variant.key}:order`]; }
      if (variant.isActive && (!variant.price.trim() || Number(variant.price) < 40)) { setFieldErrors({ [`variant:${variant.key}:price`]: fail(`variant:${variant.key}:price`, "Active variants need a price of at least $40.00.") }); return errors[`variant:${variant.key}:price`]; }
    }
    if (isActive && !variants.some((variant) => variant.isActive && variant.price.trim() && Number(variant.price) >= 40)) {
      setFieldErrors({ variants: fail("variants", "Add an active variant priced at $40.00 or more before publishing.") });
      return errors.variants;
    }
    setFieldErrors({});
    return null;
  }

  async function patchVariant(serviceId: string, variant: DraftVariant) {
    const response = await fetch(`/api/admin/services/${serviceId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "variant", variantId: variant.id, name: variant.name.trim(), description: variant.description.trim(), price: variant.price.trim(), isActive: variant.isActive }),
    });
    if (!response.ok) throw new Error(await readError(response));
  }

  async function saveVariants(serviceId: string) {
    for (const variantId of removedVariantIds) {
      const response = await fetch(`/api/admin/services/${serviceId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "variant", variantId, isActive: false }),
      });
      if (!response.ok) throw new Error(await readError(response));
    }
    const saved: DraftVariant[] = [];
    // Preserve a bookable row while an active parent is being edited. The
    // domain independently rejects removal of its last active priced variant.
    for (const variant of [...orderedVariants.filter((item) => item.isActive), ...orderedVariants.filter((item) => !item.isActive)]) {
      if (variant.id) {
        await patchVariant(serviceId, variant);
        saved.push(variant);
        continue;
      }
      const response = await fetch("/api/admin/services", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "variant", hairstyleId: serviceId, name: variant.name.trim(), description: variant.description.trim(), price: variant.price.trim(), isActive: variant.isActive }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await response.json() as { variant: { id: string } };
      const persisted = { ...variant, id: payload.variant.id };
      // A later row can still fail. Keep this identity in local state as soon
      // as it is durable so retrying a staged conversion updates it instead
      // of creating a duplicate variant.
      setVariants((current) => current.map((item) => item.key === variant.key ? persisted : item));
      saved.push(persisted);
    }
    const orderResponse = await fetch(`/api/admin/services/${serviceId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "variants-order", orderedVariantIds: saved.map((variant) => variant.id) }),
    });
    if (!orderResponse.ok) throw new Error(await readError(orderResponse));
  }

  async function deactivatePersistedVariants(serviceId: string) {
    const persisted = variants.filter((variant) => variant.id);
    for (const variant of persisted) {
      const response = await fetch(`/api/admin/services/${serviceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "variant",
          variantId: variant.id,
          name: variant.name.trim(),
          description: variant.description.trim(),
          price: variant.price.trim(),
          isActive: false,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
    }
  }

  async function saveService(destination: string): Promise<boolean> {
    if (saving) return false;
    if (partialCreationId) {
      setError("This draft has already been created. Continue editing that draft instead of creating another service.");
      return false;
    }
    const validation = validate();
    if (validation) {
      setError(validation);
      return false;
    }
    setSaving(true); setError(null); setNotice(null); setPartialCreationId(null);
    let createdDraftId: string | null = null;
    try {
      const endpoint = editing ? `/api/admin/services/${service!.id}` : "/api/admin/services";
      const body = (active: boolean) => JSON.stringify({ kind: "service", name: name.trim(), categoryId, description: description.trim(), pricingMode, price: pricingMode === "simple" ? price.trim() : "", isActive: active, displayOrder: Number(displayOrder) });
      const modeChanged = editing && originalPricingMode !== pricingMode;
      if (modeChanged && pricingMode === "variants") {
        // A simple-price service becomes a safe draft before any variants are
        // written. The original price is only a browser-side suggestion; it
        // is never invented as a named, bookable variant.
        const transition = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: body(false) });
        if (!transition.ok) throw new Error(await readError(transition));
        await saveVariants(service!.id);
        const response = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: body(isActive) });
        if (!response.ok) throw new Error(await readError(response));
      } else if (modeChanged && pricingMode === "simple") {
        // Retain old variant rows for history but make every one unavailable
        // before the parent leaves variant pricing.
        const unpublish = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "service", name: name.trim(), categoryId, description: description.trim(), pricingMode: "variants", price: "", isActive: false, displayOrder: Number(displayOrder) }) });
        if (!unpublish.ok) throw new Error(await readError(unpublish));
        await deactivatePersistedVariants(service!.id);
        const response = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: body(isActive) });
        if (!response.ok) throw new Error(await readError(response));
      } else if (pricingMode === "variants" && editing) {
        if (service!.isActive && !isActive) {
          const unpublish = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: body(false) });
          if (!unpublish.ok) throw new Error(await readError(unpublish));
        }
        await saveVariants(service!.id);
        const response = await fetch(endpoint, { method: "PATCH", headers: { "content-type": "application/json" }, body: body(isActive) });
        if (!response.ok) throw new Error(await readError(response));
      } else {
        const response = await fetch(endpoint, {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          // A variant parent starts as a draft so its rows can be persisted
          // before its publication guard is evaluated.
          body: body(pricingMode === "variants" ? false : isActive),
        });
        if (!response.ok) throw new Error(await readError(response));
        const payload = await response.json() as { service: { id: string } };
        if (pricingMode === "variants") {
          createdDraftId = payload.service.id;
          await saveVariants(payload.service.id);
          const publish = await fetch(`/api/admin/services/${payload.service.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: body(isActive) });
          if (!publish.ok) throw new Error(await readError(publish));
        }
      }
      setNotice(editing ? "Service saved. Continuing…" : "Service created. Returning to Services…");
      router.push(destination); router.refresh();
      return true;
    } catch (caught) {
      if (createdDraftId) {
        setPartialCreationId(createdDraftId);
        setError("The draft service was created, but some variants or publication could not be saved. Continue editing the draft to finish it; no data was deleted.");
      } else if (editing && originalPricingMode !== pricingMode) {
        setError("The pricing-mode change was saved as a draft but could not be completed. Continue editing this service; no variants or appointment history were deleted.");
      } else {
        setError(caught instanceof Error ? caught.message : "We could not save this service.");
      }
      setSaving(false);
      return false;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveService(returnTo);
  }

  function guardNavigation(event: { preventDefault: () => void }, target: NavigationTarget) {
    if (saving) {
      event.preventDefault();
      return;
    }
    if (dirty) {
      event.preventDefault();
      setNavigationTarget(target);
    }
  }

  async function saveAndContinue() {
    if (!navigationTarget) return;
    const saved = await saveService(navigationTarget.href);
    if (!saved) setNavigationTarget(null);
  }

  const form = <form className={styles.serviceForm} onSubmit={submit} noValidate>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {partialCreationId ? <p className={styles.recovery}><Link href={`/admin/services/${partialCreationId}/edit`}>Continue editing the saved draft</Link></p> : null}
    {notice ? <p className={styles.actionMessage} role="status">{notice}</p> : null}
    <div className={styles.serviceFormGrid}>
      <label className={styles.actionLabel}>Service name <span className={styles.required}>Required</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={saving} autoComplete="off" aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "service-name-error" : undefined} />{fieldErrors.name ? <span id="service-name-error" className={styles.fieldError}>{fieldErrors.name}</span> : null}</label>
      <label className={styles.actionLabel}>Category <span className={styles.required}>Required</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} disabled={saving || categories.length === 0} required aria-invalid={Boolean(fieldErrors.category)}><option value="">Choose a category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{fieldErrors.category ? <span className={styles.fieldError}>{fieldErrors.category}</span> : null}</label>
      <label className={styles.actionLabel}>Display order<input value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} inputMode="numeric" type="number" min="0" step="1" disabled={saving} aria-invalid={Boolean(fieldErrors.displayOrder)} />{fieldErrors.displayOrder ? <span className={styles.fieldError}>{fieldErrors.displayOrder}</span> : null}</label>
    </div>
    <label className={styles.actionLabel}>Description <span className={styles.fieldHint}>Optional</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} disabled={saving} /></label>

    <fieldset className={styles.pricingMode} disabled={saving}>
      <legend>Pricing</legend>
      <label><input type="radio" checked={pricingMode === "simple"} onChange={() => setPricingMode("simple")} /> Single price</label>
      <label><input type="radio" checked={pricingMode === "variants"} onChange={() => {
        setPricingMode("variants");
        if (variants.length === 0) setVariants([{
          ...emptyVariant(0),
          // This is deliberately unnamed and inactive until Yasmin chooses a
          // real option name. It preserves the previous amount as an editable
          // suggestion without silently creating a permanent variant.
          price,
        }]);
      }} /> Prices by variant</label>
      {editing ? <p className={styles.fieldHint}>Changing pricing mode saves the service as a draft while its new pricing is completed. Existing variants are retained; switching to one price deactivates them for future bookings.</p> : null}
    </fieldset>
    {pricingMode === "simple" ? <label className={styles.actionLabel}>Price (USD)<input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" placeholder="e.g. 200.00" maxLength={12} disabled={saving} aria-invalid={Boolean(fieldErrors.price)} />{fieldErrors.price ? <span className={styles.fieldError}>{fieldErrors.price}</span> : null}</label> : <section className={styles.variantEditor} aria-label="Service variants">
      <div className={styles.variantHeading}><div><h2>Variants</h2><p>Active variants need a price of at least $40.00.</p></div><button className={styles.secondary} type="button" onClick={() => setVariants((current) => [...current, emptyVariant(current.length)])} disabled={saving}>Add variant</button></div>
      {orderedVariants.length === 0 ? <p className={styles.empty}>Add one or more variants before publishing this service.</p> : <div className={styles.variantList}>{orderedVariants.map((variant) => <div className={styles.variantRow} key={variant.key}>
        <label className={styles.actionLabel}>Variant name <span className={styles.required}>Required</span><input value={variant.name} onChange={(event) => updateVariant(variant.key, "name", event.target.value)} maxLength={120} disabled={saving} aria-invalid={Boolean(fieldErrors[`variant:${variant.key}:name`])} />{fieldErrors[`variant:${variant.key}:name`] ? <span className={styles.fieldError}>{fieldErrors[`variant:${variant.key}:name`]}</span> : null}</label>
        <label className={styles.actionLabel}>Variant description <span className={styles.fieldHint}>Optional</span><textarea value={variant.description} onChange={(event) => updateVariant(variant.key, "description", event.target.value)} maxLength={500} disabled={saving} aria-invalid={Boolean(fieldErrors[`variant:${variant.key}:description`])} />{fieldErrors[`variant:${variant.key}:description`] ? <span className={styles.fieldError}>{fieldErrors[`variant:${variant.key}:description`]}</span> : null}</label>
        <label className={styles.actionLabel}>Price (USD)<input value={variant.price} onChange={(event) => updateVariant(variant.key, "price", event.target.value)} inputMode="decimal" maxLength={12} disabled={saving} aria-invalid={Boolean(fieldErrors[`variant:${variant.key}:price`])} />{fieldErrors[`variant:${variant.key}:price`] ? <span className={styles.fieldError}>{fieldErrors[`variant:${variant.key}:price`]}</span> : null}</label>
        <label className={styles.actionLabel}>Order<input value={variant.sortOrder} onChange={(event) => updateVariant(variant.key, "sortOrder", event.target.value)} type="number" min="0" step="1" disabled={saving} aria-invalid={Boolean(fieldErrors[`variant:${variant.key}:order`])} />{fieldErrors[`variant:${variant.key}:order`] ? <span className={styles.fieldError}>{fieldErrors[`variant:${variant.key}:order`]}</span> : null}</label>
        <label className={styles.variantActive}><input type="checkbox" checked={variant.isActive} onChange={(event) => { if (variant.isActive && !event.target.checked) setDeactivationTarget({ type: "variant", key: variant.key, remove: false }); else updateVariant(variant.key, "isActive", event.target.checked); }} disabled={saving} /> Active</label>
        <button className={styles.inlineButton} type="button" onClick={() => { if (variant.id) setDeactivationTarget({ type: "variant", key: variant.key, remove: true }); else setVariants((current) => current.filter((item) => item.key !== variant.key)); }} disabled={saving}>{variant.id ? "Deactivate" : "Remove"}</button>
        {editing && variant.id ? <details className={styles.variantGallery}><summary>Photos for {variant.name || "this variant"}</summary><AdminServicePhotoGallery key={`${variant.id}:${variant.name}`} serviceId={service!.id} hairstyleVariantId={variant.id} variantName={variant.name} media={service?.variants.find((item) => item.id === variant.id)?.media ?? []} /></details> : <p className={styles.fieldHint}>Save this variant before adding photos.</p>}
      </div>)}</div>}
    </section>}
    {fieldErrors.variants ? <p className={styles.fieldError} role="alert">{fieldErrors.variants}</p> : null}
    <fieldset className={styles.serviceState} disabled={saving}><legend>Publishing</legend><label><input type="radio" checked={!isActive} onChange={() => { if (service?.isActive) setDeactivationTarget({ type: "service" }); else setIsActive(false); }} /> Draft — save without making it bookable</label><label><input type="radio" checked={isActive} onChange={() => setIsActive(true)} /> Active — available for booking when its category is active</label></fieldset>
    <section className={styles.categoryInline} aria-label="Create category"><button className={styles.inlineButton} type="button" onClick={() => setShowCategory((visible) => !visible)} disabled={saving || creatingCategory}>{showCategory ? "Cancel new category" : "Create a category"}</button>{showCategory ? <div className={styles.categoryInlineFields}><label className={styles.actionLabel}>New category name<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} maxLength={120} disabled={creatingCategory} /></label><button className={styles.secondary} type="button" onClick={createCategory} disabled={creatingCategory}>{creatingCategory ? "Creating…" : "Add category"}</button></div> : null}</section>
    {editing ? <AdminServicePhotoGallery key={service!.media.map((media) => `${media.id}:${media.sortOrder}:${media.deliveryUrl}:${media.altText}:${media.caption}`).join("|")} serviceId={service!.id} media={service!.media} /> : null}
    <div className={styles.actionRow}><button className={styles.primary} type="submit" disabled={saving || Boolean(partialCreationId)}>{submitLabel}</button><Link className={styles.secondary} href={returnTo} aria-disabled={saving} onNavigate={(event) => guardNavigation(event, { href: returnTo, label: "Services" })}>Cancel</Link></div>
    {deactivationTarget ? <DeactivationDialog target={deactivationTarget} onCancel={() => setDeactivationTarget(null)} onConfirm={() => { if (deactivationTarget.type === "service") setIsActive(false); else if (deactivationTarget.remove) { const selected = variants.find((variant) => variant.key === deactivationTarget.key); if (selected?.id) setRemovedVariantIds((current) => [...current, selected.id!]); setVariants((current) => current.filter((variant) => variant.key !== deactivationTarget.key)); } else updateVariant(deactivationTarget.key, "isActive", false); setDeactivationTarget(null); }} /> : null}
  </form>;

  if (!navigation) return form;

  const previousHref = navigation.previousId ? adminServiceEditPath(navigation.previousId, returnTo) : null;
  const nextHref = navigation.nextId ? adminServiceEditPath(navigation.nextId, returnTo) : null;

  return <>
    <Link className={styles.backToServices} href={returnTo} onNavigate={(event) => guardNavigation(event, { href: returnTo, label: "Services" })}>
      <span aria-hidden="true">←</span> Back to Services
    </Link>
    <div className={styles.serviceEditHeading}>
      <div>
        <h1 className={styles.title}>Edit service</h1>
        <p className={styles.servicePosition}>{navigation.position} of {navigation.total}</p>
      </div>
      <nav className={styles.serviceStepNavigation} aria-label="Browse services">
        {previousHref ? <Link href={previousHref} aria-label="Previous service" onNavigate={(event) => guardNavigation(event, { href: previousHref, label: "the previous service" })}>← Previous</Link> : <span aria-disabled="true">← Previous</span>}
        {nextHref ? <Link href={nextHref} aria-label="Next service" onNavigate={(event) => guardNavigation(event, { href: nextHref, label: "the next service" })}>Next →</Link> : <span aria-disabled="true">Next →</span>}
      </nav>
    </div>
    <section className={styles.panel}>
      <p className={styles.formIntro}>Update the current catalog configuration. Existing bookings keep their historical service and price snapshots.</p>
      {form}
    </section>
    {navigationTarget ? <UnsavedChangesDialog
      target={navigationTarget}
      saving={saving}
      onStay={() => setNavigationTarget(null)}
      onDiscard={() => { router.push(navigationTarget.href); router.refresh(); }}
      onSave={() => { void saveAndContinue(); }}
    /> : null}
  </>;
}
