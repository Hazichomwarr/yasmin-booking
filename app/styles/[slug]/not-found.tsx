import Link from "next/link";

import { PublicCatalogHeader } from "@/components/catalog/PublicCatalogHeader";

import styles from "../styles.module.css";

export default function StyleNotFound() {
  return (
    <main className={styles.page}>
      <PublicCatalogHeader />
      <section className={styles.empty}>
        <p className={styles.eyebrow}>STYLE UNAVAILABLE</p>
        <h1>That style isn&apos;t in our current collection.</h1>
        <p>It may be resting or no longer available. Explore the salon&apos;s active portfolio for another look.</p>
        <Link href="/styles">Browse all styles</Link>
      </section>
    </main>
  );
}
