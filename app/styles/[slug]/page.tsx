import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PublicCatalogHeader } from "@/components/catalog/PublicCatalogHeader";
import { PublicImageGallery } from "@/components/catalog/PublicImageGallery";
import { getPublicHairstyleBySlug } from "@/lib/catalog";
import { isApprovedBlobDeliveryUrl } from "@/lib/media/blob-public-origin";

import styles from "../styles.module.css";

type DetailPageProps = { params: Promise<{ slug: string }> };

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

export default async function StyleDetailPage({ params }: DetailPageProps) {
  await connection();
  const { slug } = await params;
  const hairstyle = await getPublicHairstyleBySlug(slug, {
    isDeliveryUrlAllowed: (url) => isApprovedBlobDeliveryUrl(url, process.env.BLOB_PUBLIC_BASE_URL),
  });
  if (!hairstyle) notFound();

  const simpleBookingUrl = `/book?style=${encodeURIComponent(hairstyle.slug)}`;
  return (
    <main className={styles.page}>
      <PublicCatalogHeader />
      <div className={styles.detailShell}>
        <Link href="/styles" className={styles.back}>← All styles</Link>
        <section className={styles.detailHero}>
          <PublicImageGallery
            images={hairstyle.gallery}
            hairstyleName={hairstyle.name}
            mainSizes="(max-width: 950px) 92vw, 45vw"
            thumbSizes="88px"
            classNames={heroGalleryClasses}
          />
          <div className={styles.detailCopy}>
            <p className={styles.eyebrow}>{hairstyle.category.name}</p>
            <h1>{hairstyle.name}</h1>
            <p className={styles.detailDescription}>{hairstyle.description || "A signature salon look, thoughtfully tailored for you."}</p>
            {!hairstyle.requiresVariant && hairstyle.isBookable && hairstyle.priceCents !== null ? (
              <div className={styles.bookingAction}>
                <div><span>Service price</span><strong>{money(hairstyle.priceCents)}</strong></div>
                <Link href={simpleBookingUrl}>Choose this style</Link>
              </div>
            ) : hairstyle.requiresVariant ? (
              <p className={styles.choiceHint}>Choose an option below to see its price and book.</p>
            ) : (
              <p className={styles.portfolioNote}>Portfolio inspiration — online booking is not currently available for this style.</p>
            )}
          </div>
        </section>

        {hairstyle.requiresVariant && hairstyle.variants.length > 0 && (
          <section className={styles.variants} aria-labelledby="options-title">
            <div className={styles.sectionHeading}>
              <p className={styles.eyebrow}>MAKE IT YOURS</p>
              <h2 id="options-title">Choose your option</h2>
            </div>
            <div className={styles.variantGrid}>
              {hairstyle.variants.map((variant) => (
                <article key={variant.id} className={styles.variantCard}>
                  {/* Only a variant's own photos are browsable; the service fallback is already in the hero. */}
                  <PublicImageGallery
                    images={variant.hasOwnGallery ? variant.gallery : variant.gallery.slice(0, 1)}
                    hairstyleName={`${hairstyle.name} ${variant.name}`}
                    mainSizes="(max-width: 950px) 92vw, 20vw"
                    thumbSizes="56px"
                    classNames={variantGalleryClasses}
                  />
                  <div className={styles.variantBody}>
                    <div><h3>{variant.name}</h3><p>{variant.description || `A ${hairstyle.name} option prepared with Yasmin's signature finish.`}</p></div>
                    {variant.isBookable && variant.priceCents !== null ? (
                      <div className={styles.variantAction}>
                        <strong>{money(variant.priceCents)}</strong>
                        <Link href={`/book?style=${encodeURIComponent(hairstyle.slug)}&variant=${encodeURIComponent(variant.id)}`}>Book this option</Link>
                      </div>
                    ) : <p className={styles.portfolioNote}>Portfolio only</p>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

const heroGalleryClasses = {
  root: styles.detailGallery,
  main: styles.galleryMain,
  image: styles.image,
  fallback: styles.fallback,
  thumbs: styles.galleryThumbs,
  thumb: styles.galleryThumb,
  thumbActive: styles.thumbActive,
};

const variantGalleryClasses = {
  ...heroGalleryClasses,
  root: styles.variantMedia,
  main: styles.variantImage,
  thumbs: styles.variantThumbs,
};
