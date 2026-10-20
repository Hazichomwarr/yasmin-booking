"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./Admin.module.css";
import { requestAdminLogin } from "./login-request";

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
    let shouldFocusError = false;
    try {
      const result = await requestAdminLogin({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      if (result.ok) {
        router.replace("/admin");
        router.refresh();
        return;
      }
      setError(result.message);
      shouldFocusError = true;
    } catch {
      // Covers a client-side router failure after a successful response.
      setError("We signed you in, but could not open the admin workspace. Please try again.");
      shouldFocusError = true;
    } finally {
      // Next navigation is asynchronous. A failed or interrupted transition
      // must never strand this form in its disabled loading state.
      setBusy(false);
      if (shouldFocusError) requestAnimationFrame(() => alertRef.current?.focus());
    }
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
