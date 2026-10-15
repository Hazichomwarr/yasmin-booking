"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./Admin.module.css";

export function AdminLogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    // The server revokes the session even if this response is lost; the page then re-checks.
    await fetch("/api/admin/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
    router.replace("/admin/login");
    router.refresh();
  }

  return <button type="button" className={styles.navButton} onClick={logout} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>;
}
