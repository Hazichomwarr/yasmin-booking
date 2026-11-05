import type { Metadata } from "next";
import Link from "next/link";

import { LandingHeader } from "@/components/landing/LandingHeader";
import { TODAY_AT_SALON_CONTENT } from "@/components/today-at-salon/today-at-salon-content";
import { TodayAtSalonVideo } from "@/components/today-at-salon/TodayAtSalonVideo";
import styles from "@/components/today-at-salon/TodayAtSalon.module.css";

export const metadata: Metadata = {
  title: "Today at the Salon | Yasmin’s Beauty Salon",
  description: TODAY_AT_SALON_CONTENT.description,
};

export default function TodayAtSalonPage() {
  const content = TODAY_AT_SALON_CONTENT;
  return <main className={styles.page}>
    <LandingHeader />
    <div className={styles.pageContent}>
      <div className={styles.pageGrid}>
        <TodayAtSalonVideo content={content} className={styles.pageVideo} imagePriority />
        <div className={styles.pageCopy}>
          {content.publicationLabel ? <p className={styles.eyebrow}>{content.publicationLabel}</p> : null}
          <h1>{content.title}</h1>
          <p>{content.description}</p>
          <div className={styles.pageActions}>
            <Link className={styles.primaryCta} href={content.ctaHref}>{content.ctaLabel}</Link>
            <Link className={styles.textLink} href="/">Back home</Link>
          </div>
        </div>
      </div>
    </div>
  </main>;
}
