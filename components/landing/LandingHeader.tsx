"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import styles from "./LandingHeader.module.css";

export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
  }

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

        <div className={styles.actions}>
          <Link href="/styles" className={styles.stylesLink}>Explore styles</Link>
          <Link href="/book" className={styles.bookLink}>Book Now</Link>
          <button
            aria-controls="mobile-site-navigation"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            className={styles.menuButton}
            onClick={() => setMenuOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            <span />
            <span />
            <span />
          </button>
        </div>

        {menuOpen ? (
          <nav
            aria-label="Mobile navigation"
            className={styles.mobileMenu}
            id="mobile-site-navigation"
          >
            <Link href="/" onClick={closeMenu}>Home</Link>
            <Link href="/styles" onClick={closeMenu}>Explore Hairstyles</Link>
            <Link href="/book" onClick={closeMenu}>Book Now</Link>
          </nav>
        ) : null}
      </div>
    </header>
  );
}
