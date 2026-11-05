"use client";

import Image from "next/image";
import { forwardRef, useState } from "react";

import type { TodayAtSalonContent } from "./today-at-salon-content";
import styles from "./TodayAtSalon.module.css";

export const TodayAtSalonVideo = forwardRef<HTMLVideoElement, {
  content: TodayAtSalonContent;
  autoPlay?: boolean;
  className?: string;
  imagePriority?: boolean;
}>(function TodayAtSalonVideo({ content, autoPlay = false, className, imagePriority = false }, ref) {
  const [unavailable, setUnavailable] = useState(!content.videoAvailable);

  return <div className={`${styles.videoFrame} ${className ?? ""}`}>
    {unavailable ? <div className={styles.videoFallback} role="status">
      <Image src={content.posterSrc} alt="Inside Yasmin's Beauty Salon" fill priority={imagePriority || autoPlay} sizes="(max-width: 700px) 88vw, 430px" />
      <div><strong>Salon video coming soon.</strong><span>Explore Yasmin&apos;s latest services and salon portfolio.</span></div>
    </div> : <video
      ref={ref}
      aria-label={content.title}
      autoPlay={autoPlay}
      controls
      muted={autoPlay}
      playsInline
      poster={content.posterSrc}
      preload="metadata"
      onError={() => setUnavailable(true)}
    >
      <source src={content.videoSrc} type="video/mp4" />
      Your browser does not support embedded video.
    </video>}
  </div>;
});
