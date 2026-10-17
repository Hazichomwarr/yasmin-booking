"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./Admin.module.css";

export function AdminLoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") }),
      });
      if (response.ok) {
        router.replace("/admin");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "Sign-in failed. Please try again.");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
    requestAnimationFrame(() => alertRef.current?.focus());
  }

  return (
    <form method="post" onSubmit={submit} noValidate>
      {error && <p ref={alertRef} tabIndex={-1} className={styles.error} role="alert">{error}</p>}
      <label>Email<input name="email" type="email" autoComplete="username" inputMode="email" required maxLength={254} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <button className={styles.primary} disabled={busy} aria-busy={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
