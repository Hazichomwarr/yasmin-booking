import Link from "next/link";
import type { ReactNode } from "react";

import { AdminLogoutButton } from "./AdminLogoutButton";
import styles from "./Admin.module.css";

export function AdminShell({ current, email, children }: { current: "dashboard" | "appointments" | "services"; email: string; children: ReactNode }) {
  const navigation = (
    <>
      <Link href="/admin" aria-current={current === "dashboard" ? "page" : undefined}>Dashboard</Link>
      <Link href="/admin/appointments" aria-current={current === "appointments" ? "page" : undefined}>Appointments</Link>
      <Link href="/admin/services" aria-current={current === "services" ? "page" : undefined}>Services</Link>
    </>
  );

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <aside className={styles.sidebar} aria-label="Admin workspace">
          <div>
            <p className={styles.brand}>YASMIN’S</p>
            <p className={styles.brandSubtitle}>Beauty Salon</p>
          </div>
          <nav className={styles.sidebarNav} aria-label="Admin navigation">{navigation}</nav>
          <div className={styles.sidebarFooter}>
            <p className={styles.who}>Signed in as<br />{email}</p>
            <AdminLogoutButton />
          </div>
        </aside>
        <div className={styles.workspace}>
          <header className={styles.mobileHeader}>
            <Link className={styles.mobileBrand} href="/admin">YASMIN’S <span>Beauty Salon</span></Link>
            <details className={styles.mobileMenu}>
              <summary aria-label="Open admin navigation">Menu</summary>
              <nav aria-label="Admin navigation">{navigation}<AdminLogoutButton /></nav>
            </details>
          </header>
          <div className={styles.content}>{children}</div>
        </div>
      </div>
    </main>
  );
}
