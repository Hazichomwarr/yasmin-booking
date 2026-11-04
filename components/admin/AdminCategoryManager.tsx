"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import styles from "./Admin.module.css";

export type CategoryManagerCategory = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  hairstyleCount: number;
};

type ApiPayload = {
  category?: CategoryManagerCategory;
  categories?: CategoryManagerCategory[];
  error?: { message?: string };
};

type DraftCategory = CategoryManagerCategory & { descriptionText: string };

function draft(category: CategoryManagerCategory): DraftCategory {
  return { ...category, descriptionText: category.description ?? "" };
}

async function payload(response: Response): Promise<ApiPayload> {
  return response.json().catch(() => ({})) as Promise<ApiPayload>;
}

function messageFor(response: Response, body: ApiPayload, fallback: string) {
  if (response.status === 401) return "Your admin session expired. Sign in again before continuing.";
  return body.error?.message || fallback;
}

export function AdminCategoryManager({ initialCategories }: { initialCategories: CategoryManagerCategory[] }) {
  const router = useRouter();
  const [categories, setCategories] = useState(() => initialCategories.map(draft));
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function updateDraft(id: string, field: "name" | "slug" | "descriptionText", value: string) {
    setCategories((current) => current.map((category) => category.id === id ? { ...category, [field]: value } : category));
  }

  async function createCategory() {
    if (!name.trim() || !slug.trim()) {
      setError("Enter both a category name and a unique slug.");
      return;
    }
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/services", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "category", name, slug, description, isActive }),
      });
      const body = await payload(response);
      if (!response.ok || !body.category) throw new Error(messageFor(response, body, "The category could not be created."));
      setCategories((current) => [...current, draft(body.category!)]);
      setName("");
      setSlug("");
      setDescription("");
      setIsActive(true);
      setNotice(`Category “${body.category.name}” created.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The category could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function saveCategory(
    category: DraftCategory,
    nextActive = category.isActive,
    stateOnly = false,
  ) {
    if (!category.name.trim() || !category.slug.trim()) {
      setError("Category names and slugs cannot be blank.");
      return;
    }
    setBusy(category.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/categories/${category.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stateOnly ? {
          kind: "category",
          isActive: nextActive,
        } : {
          kind: "category",
          name: category.name,
          slug: category.slug,
          description: category.descriptionText,
          isActive: nextActive,
        }),
      });
      const body = await payload(response);
      if (!response.ok || !body.category) throw new Error(messageFor(response, body, "The category could not be saved."));
      setCategories((current) => current.map((item) => item.id === category.id
        ? stateOnly ? { ...item, isActive: body.category!.isActive } : draft(body.category!)
        : item));
      setNotice(stateOnly
        ? `Category “${body.category.name}” ${body.category.isActive ? "activated" : "deactivated"}.`
        : `Category “${body.category.name}” saved.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The category could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function moveCategory(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= categories.length) return;
    const next = [...categories];
    [next[index], next[destination]] = [next[destination], next[index]];
    setBusy("order");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/categories", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "categories-order", orderedCategoryIds: next.map((category) => category.id) }),
      });
      const body = await payload(response);
      if (!response.ok || !body.categories) throw new Error(messageFor(response, body, "The category order could not be saved."));
      setCategories(body.categories.map(draft));
      setNotice("Category order saved.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The category order could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`${styles.panel} ${styles.categoryManager}`} aria-labelledby="category-manager-heading">
      <div className={styles.featureManagerHeading}>
        <div>
          <p className={styles.catalogCategory}>Catalog structure</p>
          <h2 id="category-manager-heading">Hairstyle categories</h2>
          <p className={styles.muted}>Manage customer-facing category names and order. Inactive categories hide their services from new public bookings without changing the services themselves.</p>
        </div>
        <span className={styles.featureCount}>{categories.length} categories</span>
      </div>

      <details className={styles.categoryCreate}>
        <summary>Add category</summary>
        <div className={styles.categoryCreateGrid}>
          <label className={styles.actionLabel}>Name <span className={styles.required}>Required</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} disabled={busy !== null} /></label>
          <label className={styles.actionLabel}>Slug <span className={styles.required}>Required</span><input value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={120} placeholder="knotless-braids" disabled={busy !== null} /><span className={styles.fieldHint}>Lowercase letters, numbers, and hyphens. Slugs must be unique.</span></label>
          <label className={`${styles.actionLabel} ${styles.categoryDescription}`}>Description <span className={styles.fieldHint}>Optional</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} disabled={busy !== null} /></label>
          <label className={styles.categoryActive}><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={busy !== null} /> Active in public navigation</label>
          <button type="button" className={styles.primary} onClick={createCategory} disabled={busy !== null}>{busy === "create" ? "Creating…" : "Create category"}</button>
        </div>
      </details>

      {categories.length === 0 ? <p className={styles.featureEmpty}>No categories exist yet. Create one before adding services.</p> : (
        <ol className={styles.categoryList} aria-label="Category display order">
          {categories.map((category, index) => (
            <li className={styles.categoryCard} key={category.id}>
              <div className={styles.categoryCardHeading}>
                <div><strong>{category.name || "Unnamed category"}</strong><span>{category.hairstyleCount} {category.hairstyleCount === 1 ? "hairstyle" : "hairstyles"}</span></div>
                <span className={styles.badge} data-catalog-state={category.isActive ? "active" : "inactive"}>{category.isActive ? "Active" : "Inactive"}</span>
              </div>
              <div className={styles.categoryFields}>
                <label className={styles.actionLabel}>Display name<input value={category.name} onChange={(event) => updateDraft(category.id, "name", event.target.value)} maxLength={120} disabled={busy !== null} /></label>
                <label className={styles.actionLabel}>Slug<input value={category.slug} onChange={(event) => updateDraft(category.id, "slug", event.target.value)} maxLength={120} disabled={busy !== null} /></label>
                <label className={`${styles.actionLabel} ${styles.categoryDescription}`}>Description<textarea value={category.descriptionText} onChange={(event) => updateDraft(category.id, "descriptionText", event.target.value)} maxLength={1000} disabled={busy !== null} /></label>
              </div>
              <div className={styles.categoryCardActions}>
                <div className={styles.categoryOrderActions} aria-label={`Reorder ${category.name}`}>
                  <button type="button" className={styles.secondary} onClick={() => moveCategory(index, -1)} disabled={busy !== null || index === 0} aria-label={`Move ${category.name} up`}>↑</button>
                  <button type="button" className={styles.secondary} onClick={() => moveCategory(index, 1)} disabled={busy !== null || index === categories.length - 1} aria-label={`Move ${category.name} down`}>↓</button>
                </div>
                <button type="button" className={styles.secondary} onClick={() => saveCategory(category)} disabled={busy !== null}>{busy === category.id ? "Saving…" : "Save changes"}</button>
                <button type="button" className={category.isActive ? styles.danger : styles.secondary} onClick={() => saveCategory(category, !category.isActive, true)} disabled={busy !== null}>{category.isActive ? "Deactivate" : "Activate"}</button>
              </div>
              {!category.isActive ? <p className={styles.fieldHint}>Its hairstyles retain their individual active states and historical relationships.</p> : null}
            </li>
          ))}
        </ol>
      )}

      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      {notice ? <p className={styles.formSuccess} role="status">{notice}</p> : null}
    </section>
  );
}
