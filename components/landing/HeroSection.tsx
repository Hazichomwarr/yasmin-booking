import Image from "next/image";

import { BookingCTA } from "@/components/landing/BookingCTA";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { TrustSignals } from "@/components/landing/TrustSignals";

import styles from "./HeroSection.module.css";

export function HeroSection() {
  return (
    <section className={styles.hero}>
      <Image
        className={styles.photo}
        src="/images/salon-hero-placeholder.png"
        alt="Woman with knotless braids in a warm beauty salon"
        fill
        priority
        sizes="100vw"
      />

      <div className={styles.overlay} />

      <LandingHeader />

      <div className={styles.container}>
        <div className={styles.content}>
          <p className={styles.eyebrow}>Welcome to</p>

          <h1 className={styles.title}>
            Yasmin’s
            <span>Booking System</span>
          </h1>

          <p className={styles.intro}>
            Your beauty. Our passion.
            <br />
            We can’t wait to see you! <span aria-hidden="true">♡</span>
          </p>

          <div className={styles.divider} />

          <h2 className={styles.prompt}>
            When are you coming
            <br />
            to visit us?
          </h2>

          <BookingCTA />
          <TrustSignals />
        </div>
      </div>
    </section>
  );
}
