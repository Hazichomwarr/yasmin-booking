import type { PublicHairstyleCoverImage } from "@/components/catalog/PublicHairstyleCover";
import { PublicHairstyleCover } from "@/components/catalog/PublicHairstyleCover";

import styles from "./StyleCard.module.css";

type Props = {
  name: string;
  coverImage: PublicHairstyleCoverImage | null;
};

export function StyleCard({ name, coverImage }: Props) {
  return (
    <article className={styles.card}>
      <PublicHairstyleCover
        image={coverImage}
        hairstyleName={name}
        sizes="(max-width: 600px) 48vw, 25vw"
        className={styles.image}
        fallbackClassName={styles.fallback}
      />
      <div className={styles.shade} />
      <h3>{name}</h3>
    </article>
  );
}
