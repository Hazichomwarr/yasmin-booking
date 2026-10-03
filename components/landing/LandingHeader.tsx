import Image from "next/image";
import Link from "next/link";

import { LocationIcon } from "@/components/ui/icons/LocationIcon";
import styles from "./LandingHeader.module.css";

export function LandingHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link
          href="/"
          className={styles.logo}
          aria-label="Yasmin's Beauty Salon"
        >
          <Image
            src="/images/yasmins-logo.png"
            className={styles.logoImage}
            alt=""
            width={72}
            height={72}
            priority
          />
        </Link>

        <button className={styles.locations} type="button">
          <LocationIcon />
          <span>3 Locations</span>
          <span className={styles.chevron} aria-hidden="true">⌄</span>
        </button>
      </div>
    </header>
  );
}
