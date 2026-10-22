"use client";

import { useState } from "react";

import { PublicHairstyleCover } from "@/components/catalog/PublicHairstyleCover";
import type { AdminHomepageFeatureState } from "@/lib/catalog";

import styles from "./Admin.module.css";

type ApiPayload = {
  state?: AdminHomepageFeatureState;
  error?: { message?: string };
};

export function AdminHomepageFeatures({ initialState }: { initialState: AdminHomepageFeatureState }) {
  const [revision, setRevision] = useState(initialState.revision);
  const [features, setFeatures] = useState(initialState.features);
  const [options] = useState(initialState.options);
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addFeature() {
    const option = options.find((candidate) => candidate.key === choice);
    if (!option || features.some((feature) => feature.key === option.key) || features.length >= 4) return;
    setFeatures((current) => [...current, option]);
    setChoice("");
    setMessage(null);
  }

  function move(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= features.length) return;
    setFeatures((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    setMessage(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/homepage-features", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision,
          features: features.map(({ hairstyleId, hairstyleVariantId }) => ({ hairstyleId, hairstyleVariantId })),
        }),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok || !payload.state) throw new Error(payload.error?.message || "The featured list could not be saved.");
      setRevision(payload.state.revision);
      setFeatures(payload.state.features);
      setMessage("Homepage featured styles saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The featured list could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${styles.panel} ${styles.featureManager}`} aria-labelledby="homepage-features-heading">
      <div className={styles.featureManagerHeading}>
        <div>
          <p className={styles.catalogCategory}>Homepage</p>
          <h2 id="homepage-features-heading">Featured styles</h2>
          <p className={styles.muted}>Choose and order up to four services or variants. Names, photos, and prices always come from the live catalog.</p>
        </div>
        <span className={styles.featureCount}>{features.length} / 4</span>
      </div>

      {features.length === 0 ? (
        <p className={styles.featureEmpty}>No homepage features are configured. The public homepage will show a simple link to browse all styles.</p>
      ) : (
        <ol className={styles.featureList} aria-label="Current homepage feature order">
          {features.map((feature, index) => (
            <li className={styles.featureItem} key={feature.key}>
              <div className={styles.featureThumb}>
                <PublicHairstyleCover image={feature.coverImage} hairstyleName={feature.label} sizes="72px" className={styles.featureImage} fallbackClassName={styles.featureFallback} />
              </div>
              <div className={styles.featureIdentity}>
                <strong>{feature.label}</strong>
                <span>{feature.categoryName} · {feature.variantName ? "Variant" : "Service"}</span>
                <small data-feature-status={feature.publicStatus}>{feature.statusMessage}</small>
              </div>
              <div className={styles.featureActions}>
                <button type="button" className={styles.secondary} onClick={() => move(index, -1)} disabled={saving || index === 0} aria-label={`Move ${feature.label} up`}>↑</button>
                <button type="button" className={styles.secondary} onClick={() => move(index, 1)} disabled={saving || index === features.length - 1} aria-label={`Move ${feature.label} down`}>↓</button>
                <button type="button" className={styles.dangerText} onClick={() => { setFeatures((current) => current.filter((item) => item.key !== feature.key)); setMessage(null); }} disabled={saving}>Remove</button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.featureAddRow}>
        <label htmlFor="homepage-feature-choice">Add a service or variant</label>
        <select id="homepage-feature-choice" value={choice} onChange={(event) => setChoice(event.target.value)} disabled={saving || features.length >= 4}>
          <option value="">Choose from the catalog</option>
          {options.map((option) => <option key={option.key} value={option.key} disabled={features.some((feature) => feature.key === option.key)}>{option.label}{option.publicStatus === "unavailable" ? " — currently hidden" : option.publicStatus === "portfolio-only" ? " — portfolio only" : ""}</option>)}
        </select>
        <button type="button" className={styles.secondary} onClick={addFeature} disabled={!choice || saving || features.length >= 4}>Add</button>
      </div>

      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      {message ? <p className={styles.formSuccess} role="status">{message}</p> : null}
      <div className={styles.featureSaveRow}>
        <p className={styles.fieldHint}>Inactive items stay configured but are automatically hidden from customers.</p>
        <button type="button" className={styles.primary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save homepage features"}</button>
      </div>
    </section>
  );
}
