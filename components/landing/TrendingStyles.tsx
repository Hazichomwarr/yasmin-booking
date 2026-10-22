import Link from "next/link";

import { StyleCard } from "@/components/landing/StyleCard";
import { listPublicHomepageFeatures } from "@/lib/catalog";

import styles from "./TrendingStyles.module.css";

export async function TrendingStyles() {
  const cards = await listPublicHomepageFeatures();

  return (
    <section className={styles.section}>
      <div className={styles.container}>
        <p className={styles.eyebrow}><span />TRENDING STYLES<span /></p>
        <h2 className={styles.title}>Get Inspired</h2>
        <p className={styles.copy}>Explore some of our most loved styles.</p>
        {cards.length > 0 ? <div className={styles.grid}>
          {cards.map((style) => <StyleCard key={style.id} name={style.name} serviceName={style.serviceName} href={style.href} priceCents={style.priceCents} coverImage={style.coverImage} />)}
        </div> : <div className={styles.empty}><p>Our featured edit is being refreshed.</p><Link href="/styles">Browse all styles</Link></div>}
      </div>
    </section>
  );
}
