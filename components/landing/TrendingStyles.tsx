import { StyleCard } from "@/components/landing/StyleCard";
import { listPublicHairstyles } from "@/lib/catalog";
import { trendingStyles } from "@/lib/landing-data";
import { isApprovedBlobDeliveryUrl } from "@/lib/media/blob-public-origin";

import styles from "./TrendingStyles.module.css";

export async function TrendingStyles() {
  const catalogStyles = await listPublicHairstyles();
  const cards = [
    ...catalogStyles.slice(0, 4).map((style) => ({
      key: style.id,
      name: style.name,
      coverImage: style.coverImage && isApprovedBlobDeliveryUrl(style.coverImage.deliveryUrl, process.env.BLOB_PUBLIC_BASE_URL)
        ? style.coverImage
        : null,
    })),
    ...trendingStyles.slice(catalogStyles.length, 4).map((style) => ({
      key: `fallback-${style.name}`,
      name: style.name,
      coverImage: null,
    })),
  ].slice(0, 4);

  return (
    <section className={styles.section}>
      <div className={styles.container}>
        <p className={styles.eyebrow}><span />TRENDING STYLES<span /></p>
        <h2 className={styles.title}>Get Inspired</h2>
        <p className={styles.copy}>Explore some of our most loved styles.</p>
        <div className={styles.grid}>
          {cards.map((style) => <StyleCard key={style.key} name={style.name} coverImage={style.coverImage} />)}
        </div>
      </div>
    </section>
  );
}
