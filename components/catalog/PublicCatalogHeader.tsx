import Image from "next/image";
import Link from "next/link";

import styles from "./PublicCatalogHeader.module.css";

export function PublicCatalogHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand} aria-label="Yasmin's Beauty Salon home">
          <Image src="/images/yasmins-logo.png" alt="" width={58} height={58} priority />
          <span>Yasmin&apos;s Beauty Salon</span>
        </Link>
        <nav className={styles.nav} aria-label="Customer navigation">
          <Link href="/styles" aria-current="page">Explore styles</Link>
          <Link href="/book" className={styles.book}>Book now</Link>
        </nav>
      </div>
    </header>
  );
}
