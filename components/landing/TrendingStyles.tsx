import Link from "next/link";

import { LandingInspirationGallery } from "@/components/landing/LandingInspirationGallery";
import { StyleCard } from "@/components/landing/StyleCard";
import {
  LANDING_INSPIRATION_IMAGES,
  resolveTrendingStylesSource,
  type LandingInspirationImage,
} from "@/components/landing/landing-inspiration";
import { listPublicHomepageFeatures } from "@/lib/catalog";

import styles from "./TrendingStyles.module.css";

type FeaturedStyle = Awaited<ReturnType<typeof listPublicHomepageFeatures>>[number];

type ContentProps = {
  cards: readonly FeaturedStyle[];
  inspirationImages?: readonly LandingInspirationImage[];
};

export function TrendingStylesContent({ cards, inspirationImages = LANDING_INSPIRATION_IMAGES }: ContentProps) {
  const source = resolveTrendingStylesSource(cards, inspirationImages);

  return (
    <section className={styles.section}>
      <div className={styles.container}>
        <p className={styles.eyebrow}><span />TRENDING STYLES<span /></p>
        <h2 className={styles.title}>Get Inspired</h2>
        <p className={styles.copy}>Explore some of our most loved styles.</p>
        {source.kind === "features" ? <div className={styles.grid}>
          {source.items.map((style) => <StyleCard key={style.id} name={style.name} serviceName={style.serviceName} href={style.href} priceCents={style.priceCents} coverImage={style.coverImage} />)}
        </div> : <LandingInspirationGallery images={source.items} />}
        <Link className={styles.exploreLink} href="/styles">Explore All Hairstyles</Link>
      </div>
    </section>
  );
}

export async function TrendingStyles() {
  const cards = await listPublicHomepageFeatures();
  return <TrendingStylesContent cards={cards} />;
}
