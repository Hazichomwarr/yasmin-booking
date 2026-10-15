import { redirect } from "next/navigation";

import { AdminLoginForm } from "@/components/admin/AdminLoginForm";
import styles from "@/components/admin/Admin.module.css";
import { getAdminAccess } from "@/lib/admin/dal";

export default async function AdminLoginPage() {
  if (await getAdminAccess()) redirect("/admin");
  return (
    <main className={styles.page}>
      <section className={`${styles.panel} ${styles.login}`} aria-labelledby="admin-login-title">
        <p className={styles.brand}>YASMIN’S BEAUTY SALON</p>
        <h1 id="admin-login-title" className={styles.title}>Admin sign in</h1>
        <AdminLoginForm />
      </section>
    </main>
  );
}
