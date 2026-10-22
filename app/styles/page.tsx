import Link from "next/link";
import { connection } from "next/server";

import { PublicCatalogHeader } from "@/components/catalog/PublicCatalogHeader";
import { PublicHairstyleCover } from "@/components/catalog/PublicHairstyleCover";
import { listPublicHairstyles, type PublicHairstyle } from "@/lib/catalog";
import { isApprovedBlobDeliveryUrl } from "@/lib/media/blob-public-origin";

import styles from "./styles.module.css";

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

export default async function StylesPage() {
  await connection();
  const hairstyles = await listPublicHairstyles({}, {
    isDeliveryUrlAllowed: (url) => isApprovedBlobDeliveryUrl(url, process.env.BLOB_PUBLIC_BASE_URL),
  });
  const categories = groupByCategory(hairstyles);

  return (
    <main className={styles.page}>
      <PublicCatalogHeader />
      <section className={styles.hero}>
        <p className={styles.eyebrow}>THE YASMIN EDIT</p>
        <h1>Find the style that feels like you.</h1>
        <p>Browse our salon portfolio, compare current service prices, and move from inspiration to booking when you&apos;re ready.</p>
      </section>

      {categories.length > 0 ? (
        <>
          <nav className={styles.categoryNav} aria-label="Hairstyle categories">
            {categories.map((category) => <a key={category.slug} href={`#${category.slug}`}>{category.name}</a>)}
          </nav>
          <div className={styles.catalog}>
            {categories.map((category) => (
              <section key={category.slug} id={category.slug} className={styles.category} aria-labelledby={`${category.slug}-title`}>
                <div className={styles.categoryHeading}>
                  <p>Explore</p>
                  <h2 id={`${category.slug}-title`}>{category.name}</h2>
                </div>
                <div className={styles.grid}>
                  {category.hairstyles.map((hairstyle) => (
                    <article key={hairstyle.id} className={styles.card}>
                      <Link href={`/styles/${encodeURIComponent(hairstyle.slug)}`} className={styles.imageLink} aria-label={`View ${hairstyle.name}`}>
                        <PublicHairstyleCover
                          image={hairstyle.coverImage}
                          hairstyleName={hairstyle.name}
                          sizes="(max-width: 700px) 92vw, (max-width: 1100px) 45vw, 30vw"
                          className={styles.image}
                          fallbackClassName={styles.fallback}
                        />
                      </Link>
                      <div className={styles.cardBody}>
                        <p className={styles.cardCategory}>{hairstyle.category.name}</p>
                        <div className={styles.cardTitleRow}>
                          <h3><Link href={`/styles/${encodeURIComponent(hairstyle.slug)}`}>{hairstyle.name}</Link></h3>
                          <p className={styles.price}>{hairstyle.startingPriceCents === null ? "Portfolio" : `${hairstyle.requiresVariant ? "From " : ""}${money(hairstyle.startingPriceCents)}`}</p>
                        </div>
                        <p className={styles.preview}>{hairstyle.description || "Explore this signature Yasmin style and its available options."}</p>
                        <Link href={`/styles/${encodeURIComponent(hairstyle.slug)}`} className={styles.details}>View style <span aria-hidden="true">→</span></Link>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <section className={styles.empty}>
          <p className={styles.eyebrow}>OUR PORTFOLIO</p>
          <h2>Fresh inspiration is on the way.</h2>
          <p>Our current styles are being prepared. You can still contact the salon for help choosing your next look.</p>
          <Link href="/">Return home</Link>
        </section>
      )}
    </main>
  );
}

function groupByCategory(hairstyles: PublicHairstyle[]) {
  const groups = new Map<string, { name: string; slug: string; hairstyles: PublicHairstyle[] }>();
  for (const hairstyle of hairstyles) {
    const group = groups.get(hairstyle.category.slug) ?? {
      name: hairstyle.category.name,
      slug: hairstyle.category.slug,
      hairstyles: [],
    };
    group.hairstyles.push(hairstyle);
    groups.set(hairstyle.category.slug, group);
  }
  return [...groups.values()];
}
