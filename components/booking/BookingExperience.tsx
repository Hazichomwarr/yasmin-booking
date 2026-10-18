"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  PublicHairstyleCover,
  type PublicHairstyleCoverImage,
} from "@/components/catalog/PublicHairstyleCover";
import { PUBLIC_BOOKING_LIMITS, publicContactProblems, type PublicContactField } from "@/lib/booking/public-booking-rules";

import { apiError, dateLabel, money, postJson, timeLabel, zoneLabel } from "./booking-format";
import styles from "./BookingExperience.module.css";

type Availability = {
  location: { id: string; name: string; address: string | null; timeZone: string };
  dates: Array<{ date: string; slots: Array<{ id: string; time: string; availability: "available" | "limited" | "full"; available: boolean }> }>;
  pricing: { totalPriceCents: number; depositAmountCents: number; balanceDueCents: number };
};
type Details = { name: string; email: string; phone: string; preferredStylistName: string; hairstyleId: string; emailMarketingConsent: boolean; smsMarketingConsent: boolean };
type Props = {
  hairstyles: Array<{ id: string; name: string; coverImage: PublicHairstyleCoverImage | null }>;
  consentWording: { email: string; sms: string };
};

const initialDetails: Details = { name: "", email: "", phone: "", preferredStylistName: "", hairstyleId: "", emailMarketingConsent: false, smsMarketingConsent: false };
const FIELD_ORDER: PublicContactField[] = ["name", "email", "phone", "preferredStylistName"];

export function BookingExperience({ hairstyles, consentWording }: Props) {
  const router = useRouter();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [date, setDate] = useState("");
  const [slotId, setSlotId] = useState("");
  const [details, setDetails] = useState<Details>(initialDetails);
  const [problems, setProblems] = useState<Partial<Record<PublicContactField, string>>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const fields = useRef<Partial<Record<PublicContactField, HTMLInputElement | null>>>({});

  const applyAvailability = useCallback((value: Availability, keepDate?: string) => {
    setAvailability(value);
    setDate(value.dates.some((item) => item.date === keepDate) ? keepDate! : value.dates.find((item) => item.slots.some((slot) => slot.available))?.date ?? value.dates[0]?.date ?? "");
  }, []);

  useEffect(() => {
    fetchAvailability().then((value) => applyAvailability(value)).catch(() => setMessage("Online booking is not available right now. Please try again later."));
  }, [applyAvailability]);
  useEffect(() => { heading.current?.focus(); }, [step]);

  const selectedDate = useMemo(() => availability?.dates.find((item) => item.date === date), [availability, date]);
  const selectedSlot = selectedDate?.slots.find((slot) => slot.id === slotId && slot.available);
  const update = (patch: Partial<Details>) => setDetails((current) => ({ ...current, ...patch }));

  function review(event: FormEvent) {
    event.preventDefault();
    const found = publicContactProblems(details);
    setProblems(found);
    const first = FIELD_ORDER.find((field) => found[field]);
    if (first) fields.current[first]?.focus();
    else setStep(3);
  }

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!availability || !selectedSlot || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const created = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: details.name, email: details.email, phone: details.phone,
          preferredStylistName: details.preferredStylistName.trim() || null,
          hairstyleId: details.hairstyleId || null,
          emailMarketingConsent: details.emailMarketingConsent, smsMarketingConsent: details.smsMarketingConsent,
          locationId: availability.location.id, bookingSlotId: selectedSlot.id, appointmentDate: date,
        }),
      });
      if (!created.ok) return await recoverFromCreateFailure(await apiError(created));
      // The booking now exists in this browser's cookie; every follow-up belongs to the status page.
      const checkout = await postJson("/api/bookings/checkout");
      const body = checkout.ok ? await checkout.json() as { checkout?: { url?: string } } : null;
      if (body?.checkout?.url) window.location.assign(body.checkout.url);
      else router.push("/book/status");
    } catch {
      setMessage("We could not reach the booking service. Check your connection and try again.");
      submitting.current = false;
      setBusy(false);
    }
  }

  async function recoverFromCreateFailure(error: { code: string; message: string }) {
    if (error.code === "ACTIVE_BOOKING_EXISTS") return router.push("/book/status");
    submitting.current = false;
    setBusy(false);
    if (error.code === "SLOT_FULL" || error.code === "BOOKING_OPTION_UNAVAILABLE") {
      // Refresh first, so step 1 never shows the taken time as still bookable.
      await fetchAvailability().then((value) => applyAvailability(value, date)).catch(() => undefined);
      setSlotId("");
      setStep(1);
      setMessage("That time was just taken or is no longer available. Please choose another time.");
      return;
    }
    if (error.code === "INVALID_BOOKING_INPUT") {
      setStep(2);
      setMessage("Please check your details and try again.");
      return;
    }
    setMessage(error.message);
  }

  if (!availability) {
    return <main className={styles.page}><Header /><section className={styles.panel}><p className={styles.eyebrow}>BOOK ONLINE</p><h1>Book your appointment</h1><p role={message ? "alert" : "status"} className={message ? styles.error : undefined}>{message || "Loading available times…"}</p></section></main>;
  }

  const zone = zoneLabel(availability.location.timeZone);
  const errorFor = (field: PublicContactField) => problems[field] ? { "aria-invalid": true as const, "aria-describedby": `${field}-error` } : {};

  return (
    <main className={styles.page}>
      <Header place={availability.location.address ?? availability.location.name} />
      <section className={styles.panel} aria-labelledby="booking-title">
        <p className={styles.eyebrow}>STEP {step} OF 3</p>
        <h1 id="booking-title" ref={heading} tabIndex={-1}>{step === 1 ? "Choose your time" : step === 2 ? "Your details" : "Review and pay"}</h1>
        {message && <p className={styles.error} role="alert">{message}</p>}

        {step === 1 && <>
          <fieldset>
            <legend>Date</legend>
            {availability.dates.length === 0 && <p className={styles.note}>No online times are open right now.</p>}
            <div className={styles.dates}>
              {availability.dates.map((item) => (
                <button type="button" key={item.date} aria-pressed={item.date === date} className={item.date === date ? styles.selected : ""} onClick={() => { setDate(item.date); setSlotId(""); }}>
                  {dateLabel(item.date)}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Time <span className={styles.hint}>({zone})</span></legend>
            <div className={styles.slots}>
              {selectedDate?.slots.map((slot) => (
                <button type="button" key={slot.id} disabled={!slot.available} aria-pressed={slot.id === slotId} className={slot.id === slotId ? styles.selected : ""} onClick={() => setSlotId(slot.id)}>
                  {timeLabel(slot.time)}
                  <small>{!slot.available ? (slot.availability === "full" ? "Full" : "Unavailable") : slot.availability === "limited" ? "Few left" : "Available"}</small>
                </button>
              ))}
            </div>
          </fieldset>
          <Price pricing={availability.pricing} />
          <button type="button" className={styles.primary} disabled={!selectedSlot} onClick={() => { setMessage(""); setStep(2); }}>Continue</button>
        </>}

        {step === 2 && <form onSubmit={review} noValidate>
          {(["name", "email", "phone"] as const).map((field) => (
            <label key={field}>
              {field === "name" ? "Full name" : field === "email" ? "Email" : "Phone"}
              <input
                ref={(element) => { fields.current[field] = element; }}
                type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
                autoComplete={field === "name" ? "name" : field === "email" ? "email" : "tel"}
                inputMode={field === "phone" ? "tel" : field === "email" ? "email" : undefined}
                value={details[field]} onChange={(e) => update({ [field]: e.target.value })}
                required maxLength={PUBLIC_BOOKING_LIMITS[field]} {...errorFor(field)}
              />
              {problems[field] && <span id={`${field}-error`} className={styles.fieldError}>{problems[field]}</span>}
            </label>
          ))}
          {hairstyles.length > 0 && <label>Hairstyle <em>(optional)</em>
            <div className={styles.hairstyleChoice}>
              <select value={details.hairstyleId} onChange={(e) => update({ hairstyleId: e.target.value })}>
                <option value="">No preference</option>
                {hairstyles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
              </select>
              {details.hairstyleId && (() => {
                const style = hairstyles.find((item) => item.id === details.hairstyleId);
                if (!style) return null;
                return (
                  <div className={styles.hairstylePreview}>
                    <div className={styles.hairstylePreviewImage}>
                      <PublicHairstyleCover image={style.coverImage} hairstyleName={style.name} sizes="88px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} />
                    </div>
                    <span>{style.name}</span>
                  </div>
                );
              })()}
            </div>
          </label>}
          <label>Preferred stylist <em>(optional)</em>
            <input ref={(element) => { fields.current.preferredStylistName = element; }} value={details.preferredStylistName} onChange={(e) => update({ preferredStylistName: e.target.value })} maxLength={PUBLIC_BOOKING_LIMITS.preferredStylistName} {...errorFor("preferredStylistName")} />
            <span className={styles.hint}>We’ll try to match your request; it isn’t guaranteed.</span>
            {problems.preferredStylistName && <span id="preferredStylistName-error" className={styles.fieldError}>{problems.preferredStylistName}</span>}
          </label>
          <fieldset>
            <legend>Marketing <span className={styles.hint}>(optional, not needed to book)</span></legend>
            <label className={styles.checkbox}><input type="checkbox" checked={details.emailMarketingConsent} onChange={(e) => update({ emailMarketingConsent: e.target.checked })} /> {consentWording.email}</label>
            <label className={styles.checkbox}><input type="checkbox" checked={details.smsMarketingConsent} onChange={(e) => update({ smsMarketingConsent: e.target.checked })} /> {consentWording.sms}</label>
          </fieldset>
          <div className={styles.actions}><button type="button" onClick={() => setStep(1)}>Back</button><button className={styles.primary}>Continue to review</button></div>
        </form>}

        {step === 3 && <form onSubmit={pay}>
          <dl className={styles.review}>
            <dt>Appointment</dt><dd>{dateLabel(date, "long")} at {selectedSlot ? timeLabel(selectedSlot.time) : ""} {zone}</dd>
            <dt>Location</dt><dd>{availability.location.address ?? availability.location.name}</dd>
            {details.hairstyleId && <><dt>Hairstyle</dt><dd>{hairstyles.find((style) => style.id === details.hairstyleId)?.name}</dd></>}
            <dt>Name</dt><dd>{details.name.trim()}</dd>
            <dt>Total</dt><dd>{money(availability.pricing.totalPriceCents)}</dd>
            <dt>Deposit due today</dt><dd>{money(availability.pricing.depositAmountCents)}</dd>
            <dt>Due after your service</dt><dd>{money(availability.pricing.balanceDueCents)}</dd>
          </dl>
          <p className={styles.note}>The {money(availability.pricing.depositAmountCents)} deposit is <strong>nonrefundable</strong>. Your time is held for 15 minutes while you pay securely with Stripe. Your booking is confirmed only after the payment is verified.</p>
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={() => setStep(2)}>Back</button>
            <button className={styles.primary} disabled={busy || !selectedSlot} aria-busy={busy}>{busy ? "Reserving your time…" : `Reserve & pay ${money(availability.pricing.depositAmountCents)} deposit`}</button>
          </div>
        </form>}
      </section>
    </main>
  );
}

async function fetchAvailability(): Promise<Availability> {
  const response = await fetch("/api/bookings/availability", { cache: "no-store" });
  if (!response.ok) throw new Error((await apiError(response)).message);
  return (await response.json() as { availability: Availability }).availability;
}

/** `place`: the location's configured street address, or its name when none is configured. */
function Header({ place }: { place?: string }) {
  return <header className={styles.header}><Link href="/" className={styles.brand}>YASMIN’S BEAUTY SALON</Link>{place && <address className={styles.place}>{place}</address>}</header>;
}

function Price({ pricing }: { pricing: Availability["pricing"] }) {
  return <p className={styles.price}>All styles {money(pricing.totalPriceCents)} · <strong>{money(pricing.depositAmountCents)} nonrefundable deposit today</strong> · {money(pricing.balanceDueCents)} after your service</p>;
}
