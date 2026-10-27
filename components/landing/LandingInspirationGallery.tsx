"use client";

import Image from "next/image";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { LandingInspirationImage } from "./landing-inspiration";
import styles from "./TrendingStyles.module.css";

type Props = {
  images: readonly LandingInspirationImage[];
};

export function LandingInspirationGallery({ images }: Props) {
  const galleryRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const visibleImages = images.slice(0, 6);

  function updateActiveIndex() {
    const gallery = galleryRef.current;
    const firstCard = gallery?.querySelector<HTMLElement>("figure");

    if (!gallery || !firstCard) {
      return;
    }

    const gap = Number.parseFloat(window.getComputedStyle(gallery).columnGap) || 0;
    const stride = firstCard.offsetWidth + gap;
    setActiveIndex(Math.min(visibleImages.length - 1, Math.max(0, Math.round(gallery.scrollLeft / stride))));
  }

  function showImage(index: number) {
    const gallery = galleryRef.current;
    const card = gallery?.querySelectorAll<HTMLElement>("figure")[index];

    if (!gallery || !card) {
      return;
    }

    gallery.scrollTo({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      left: card.offsetLeft - gallery.offsetLeft,
    });
    setActiveIndex(index);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    showImage(Math.min(visibleImages.length - 1, Math.max(0, activeIndex + direction)));
  }

  if (images.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <p>Our inspiration gallery is being refreshed.</p>
      </div>
    );
  }

  return (
    <div className={styles.inspirationGallery}>
      <div
        aria-label="Hairstyle inspiration gallery"
        aria-roledescription="carousel"
        className={styles.inspirationGrid}
        onKeyDown={handleKeyDown}
        onScroll={updateActiveIndex}
        ref={galleryRef}
        role="region"
        tabIndex={0}
      >
        {visibleImages.map((image, index) => (
          <figure
            aria-label={`${index + 1} of ${visibleImages.length}`}
            className={styles.inspirationItem}
            key={image.src}
          >
            <Image
              alt={image.alt}
              className={styles.inspirationImage}
              fill
              sizes="(max-width: 600px) 62vw, (max-width: 900px) 50vw, 33vw"
              src={image.src}
            />
          </figure>
        ))}
      </div>
      <div className={styles.pagination} aria-label="Choose an inspiration photo">
        {visibleImages.map((image, index) => (
          <button
            aria-label={`Show inspiration photo ${index + 1}`}
            aria-pressed={activeIndex === index}
            className={activeIndex === index ? styles.paginationDotActive : styles.paginationDot}
            key={image.src}
            onClick={() => showImage(index)}
            type="button"
          />
        ))}
      </div>
    </div>
  );
}
