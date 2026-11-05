"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { TODAY_AT_SALON_CONTENT } from "./today-at-salon-content";
import {
  shouldOpenTodayAtSalon,
  TODAY_AT_SALON_DELAY_MS,
} from "./today-at-salon-session";
import { TodayAtSalonVideo } from "./TodayAtSalonVideo";
import styles from "./TodayAtSalon.module.css";

const FOCUSABLE = "a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex='-1'])";

export function TodayAtSalonOverlay() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    video.current?.pause();
    setOpen(false);
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;
    const timer = window.setTimeout(() => {
      const hasBlockingInteraction = Boolean(document.querySelector('[role="dialog"], dialog[open], [data-booking-interaction="active"]'));
      if (!shouldOpenTodayAtSalon({ reducedMotion, hasBlockingInteraction })) return;
      setOpen(true);
    }, TODAY_AT_SALON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute("disabled"));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [close, open]);

  if (!open) return null;
  const content = TODAY_AT_SALON_CONTENT;
  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className={styles.overlayCard} role="dialog" aria-modal="true" aria-labelledby="today-at-salon-title" aria-describedby="today-at-salon-description">
      <button ref={closeButton} className={styles.close} type="button" onClick={close} aria-label="Close Today at the Salon">×</button>
      <TodayAtSalonVideo ref={video} content={content} autoPlay className={styles.overlayVideo} />
      <div className={styles.overlayCopy}>
        {content.publicationLabel ? <p className={styles.eyebrow}>{content.publicationLabel}</p> : null}
        <h2 id="today-at-salon-title">{content.title}</h2>
        <p id="today-at-salon-description">{content.description}</p>
        <div className={styles.overlayActions}>
          <Link className={styles.primaryCta} href={content.ctaHref} onClick={close}>{content.ctaLabel}</Link>
          <Link className={styles.textLink} href="/today-at-salon" onClick={close}>Watch on its own page</Link>
        </div>
      </div>
    </section>
  </div>;
}
