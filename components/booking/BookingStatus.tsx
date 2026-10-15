"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiError, dateLabel, money, postJson, timeLabel } from "./booking-format";
import styles from "./BookingExperience.module.css";

type Status = { state: string; canStartCheckout: boolean; holdExpiresAt: string | null; locationName: string; appointmentDate: string; slotTime: string; hairstyleName: string | null; totalPriceCents: number; depositAmountCents: number; balanceDueCents: number; depositPaid: boolean };

type StatusResult = { kind: "found"; booking: Status } | { kind: "missing" } | { kind: "error"; message: string };

async function fetchStatus(): Promise<StatusResult> {
  try {
    const response = await fetch("/api/bookings/status", { cache: "no-store" });
    if (response.status === 401) return { kind: "missing" };
    if (!response.ok) return { kind: "error", message: (await apiError(response)).message };
    return { kind: "found", booking: (await response.json() as { booking: Status }).booking };
  } catch {
    return { kind: "error", message: "We could not reach the booking service. Check your connection and refresh this page." };
  }
}

/** Polling after a success return: every 3 s for up to 2 minutes, then stop. Webhook confirmation can be slower. */
const POLL_MS = 3_000;
const POLL_LIMIT_MS = 120_000;

/**
 * The single place a customer returns to. Only `state === "confirmed"` from
 * the status API is shown as confirmed; `returnedFrom` changes wording only.
 */
export function BookingStatus({ returnedFrom }: { returnedFrom: "success" | "cancel" | null }) {
  const router = useRouter();
  const [booking, setBooking] = useState<Status | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  const pollStarted = useRef(0);

  const apply = useCallback((result: StatusResult) => {
    if (result.kind === "missing") { setMissing(true); setBooking(null); }
    else if (result.kind === "error") setError(result.message);
    else { setBooking(result.booking); setError(""); }
  }, []);
  const load = useCallback(() => fetchStatus().then(apply), [apply]);

  useEffect(() => { fetchStatus().then(apply); }, [apply]);

  const confirming = booking?.state === "payment-in-progress" && returnedFrom === "success";
  useEffect(() => {
    if (!confirming || pollingStopped) return;
    if (pollStarted.current === 0) pollStarted.current = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - pollStarted.current > POLL_LIMIT_MS) setPollingStopped(true);
      else if (!document.hidden) load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [confirming, pollingStopped, load]);

  async function checkout() {
    setBusy(true);
    setError("");
    try {
      const response = await postJson("/api/bookings/checkout");
      if (response.ok) {
        const body = await response.json() as { checkout?: { url?: string } };
        if (body.checkout?.url) return window.location.assign(body.checkout.url);
      }
      setError((await apiError(response)).message);
    } catch {
      setError("We could not reach the booking service. Please try again.");
    }
    setBusy(false);
    await load();
  }

  async function release() {
    setBusy(true);
    setError("");
    try {
      const response = await postJson("/api/bookings/release");
      if (response.ok) return router.push("/book");
      setError((await apiError(response)).message);
    } catch {
      setError("We could not reach the booking service. Please try again.");
    }
    setBusy(false);
    await load();
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}><Link href="/" className={styles.brand}>YASMIN’S BEAUTY SALON</Link></header>
      <section className={styles.panel} aria-labelledby="status-title" aria-live="polite">
        <p className={styles.eyebrow}>YOUR BOOKING</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {missing ? <>
          <h1 id="status-title">We can’t find a booking in this browser</h1>
          <p className={styles.note}>Booking details are kept only in the browser you booked with, for 24 hours. If you already paid a deposit, <strong>please don’t book again</strong>: your confirmation email has the details, or contact the salon.</p>
          <Link className={styles.primary} href="/book">Start a new booking</Link>
        </> : !booking ? <p role="status">Loading your booking…</p> : <>
          <h1 id="status-title">{heading(booking.state, returnedFrom)}</h1>
          <dl className={styles.review}>
            <dt>Appointment</dt><dd>{dateLabel(booking.appointmentDate, "long")} at {timeLabel(booking.slotTime)}</dd>
            <dt>Location</dt><dd>{booking.locationName}</dd>
            {booking.hairstyleName && <><dt>Hairstyle</dt><dd>{booking.hairstyleName}</dd></>}
            <dt>Total</dt><dd>{money(booking.totalPriceCents)}</dd>
            <dt>{booking.depositPaid ? "Deposit paid" : "Deposit"}</dt><dd>{money(booking.depositAmountCents)}</dd>
            <dt>Due after your service</dt><dd>{money(booking.balanceDueCents)}</dd>
          </dl>
          <StateDetails booking={booking} returnedFrom={returnedFrom} pollingStopped={pollingStopped} busy={busy} onCheckout={checkout} onRelease={release} onRefresh={() => { pollStarted.current = 0; setPollingStopped(false); load(); }} />
        </>}
      </section>
    </main>
  );
}

function StateDetails({ booking, returnedFrom, pollingStopped, busy, onCheckout, onRelease, onRefresh }: {
  booking: Status; returnedFrom: "success" | "cancel" | null; pollingStopped: boolean; busy: boolean;
  onCheckout: () => void; onRelease: () => void; onRefresh: () => void;
}) {
  const heldUntil = booking.holdExpiresAt ? new Date(booking.holdExpiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  switch (booking.state) {
    case "confirmed":
      return <p className={styles.note}>Your {money(booking.depositAmountCents)} deposit was received. Please pay the remaining {money(booking.balanceDueCents)} at the salon after your service. A confirmation email is on its way.</p>;
    case "awaiting-payment":
      return <>
        <p className={styles.note}>Your time is held{heldUntil ? ` until about ${heldUntil}` : ""}. It’s booked only after your {money(booking.depositAmountCents)} nonrefundable deposit is paid.</p>
        {booking.canStartCheckout
          ? <button type="button" className={styles.primary} disabled={busy} onClick={onCheckout}>{busy ? "Opening secure payment…" : `Pay ${money(booking.depositAmountCents)} deposit`}</button>
          : <p className={styles.note}>Too little time remains to pay. You can start a new booking once this hold ends.</p>}
        <button type="button" className={styles.secondary} disabled={busy} onClick={onRelease}>Release this time and choose another</button>
      </>;
    case "payment-in-progress":
      if (returnedFrom === "success") {
        return pollingStopped
          ? <><p className={styles.note}>Your payment is still being confirmed. This can take a few minutes. <strong>Please don’t pay again.</strong></p><button type="button" className={styles.secondary} onClick={onRefresh}>Check again</button></>
          : <p className={styles.note} role="status">Confirming your payment with Stripe… This page updates automatically. Please don’t pay again.</p>;
      }
      return <>
        <p className={styles.note}>Your payment isn’t finished. Your time stays held{heldUntil ? ` until about ${heldUntil}` : ""} while the payment page is open.</p>
        <button type="button" className={styles.primary} disabled={busy} onClick={onCheckout}>{busy ? "Opening secure payment…" : "Return to payment"}</button>
      </>;
    case "expired":
      return <><p className={styles.note}>Your reservation ended before payment. No deposit was charged.</p><Link className={styles.primary} href="/book">Start a new booking</Link></>;
    case "cancelled":
      return <><p className={styles.note}>This booking was cancelled.</p><Link className={styles.primary} href="/book">Start a new booking</Link></>;
    case "needs-attention":
      return <p className={styles.note}>We’re checking a payment for this booking. <strong>Please don’t book or pay again</strong>; the salon will contact you.</p>;
    default:
      return <p className={styles.note}>This appointment has already taken place.</p>;
  }
}

function heading(state: string, returnedFrom: "success" | "cancel" | null) {
  if (state === "payment-in-progress") return returnedFrom === "success" ? "Confirming your payment" : "Payment not finished";
  return ({ "awaiting-payment": "Your time is reserved", confirmed: "You’re booked!", expired: "Your reservation expired", cancelled: "Booking cancelled", "needs-attention": "We’re checking your booking", closed: "Booking complete" } as Record<string, string>)[state] ?? "Your booking";
}
