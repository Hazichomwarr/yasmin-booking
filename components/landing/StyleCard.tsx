import Link from "next/link";

import type { PublicHairstyleCoverImage } from "@/components/catalog/PublicHairstyleCover";
import { PublicHairstyleCover } from "@/components/catalog/PublicHairstyleCover";

import styles from "./StyleCard.module.css";

type Props = {
  name: string;
  serviceName?: string;
  href: string;
  priceCents: number | null;
  coverImage: PublicHairstyleCoverImage | null;
};

function price(value: number | null) {
  return value === null ? null : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value / 100);
}
export function StyleCard({ name, serviceName, href, priceCents, coverImage }: Props) {
  const displayedPrice = price(priceCents);
  return (
    <Link className={styles.card} href={href} aria-label={`Explore ${serviceName && serviceName !== name ? `${serviceName}, ${name}` : name}${displayedPrice ? `, ${displayedPrice}` : ""}`}>
      <PublicHairstyleCover
        image={coverImage}
        hairstyleName={name}
        sizes="(max-width: 600px) 48vw, 25vw"
        className={styles.image}
        fallbackClassName={styles.fallback}
      />
      <div className={styles.shade} />
      <div className={styles.identity}>
        {serviceName && serviceName !== name ? <span>{serviceName}</span> : null}
        <h3>{name}</h3>
        {displayedPrice ? <p>{displayedPrice}</p> : <p>View style</p>}
      </div>
    </Link>
  );
}
