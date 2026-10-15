import Link from "next/link";

import styles from "@/app/book/page.module.css";

/** Shown while PUBLIC_BOOKING_ENABLED is off. */
export function BookingUnavailable() {
  return <main className={styles.main}><p className={styles.eyebrow}>YASMIN’S BEAUTY SALON</p><h1 className={styles.title}>Online booking<br/>coming soon.</h1><Link className={styles.link} href="/">Return home</Link></main>;
}
