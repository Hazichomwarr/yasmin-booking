import Link from "next/link";
import type { ReactNode } from "react";

import { AdminLogoutButton } from "./AdminLogoutButton";
import styles from "./Admin.module.css";

export function AdminShell({ current, email, children }: { current: "dashboard" | "appointments"; email: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.brand}>YASMIN’S BEAUTY SALON · ADMIN</p>
            <p className={styles.who}>Signed in as {email}</p>
          </div>
          <nav className={styles.nav} aria-label="Admin">
            <Link href="/admin" aria-current={current === "dashboard" ? "page" : undefined}>Dashboard</Link>
            <Link href="/admin/appointments" aria-current={current === "appointments" ? "page" : undefined}>Appointments</Link>
            <AdminLogoutButton />
          </nav>
        </header>
        {children}
      </div>
    </main>
  );
}
