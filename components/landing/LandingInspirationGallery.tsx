import Image from "next/image";

import type { LandingInspirationImage } from "./landing-inspiration";
import styles from "./TrendingStyles.module.css";

type Props = {
  images: readonly LandingInspirationImage[];
};

export function LandingInspirationGallery({ images }: Props) {
  if (images.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <p>Our inspiration gallery is being refreshed.</p>
      </div>
    );
  }

  return (
    <div className={styles.inspirationGrid} aria-label="Hairstyle inspiration gallery">
      {images.slice(0, 6).map((image) => (
        <figure className={styles.inspirationItem} key={image.src}>
          <Image
            alt={image.alt}
            className={styles.inspirationImage}
            fill
            sizes="(max-width: 768px) 50vw, 33vw"
            src={image.src}
          />
        </figure>
      ))}
    </div>
  );
}
