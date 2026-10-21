"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PublicHairstyleCover, type PublicHairstyleCoverImage } from "@/components/catalog/PublicHairstyleCover";
import { PUBLIC_BOOKING_LIMITS, publicContactProblems, type PublicContactField } from "@/lib/booking/public-booking-rules";

import { apiError, dateLabel, money, postJson, timeLabel, zoneLabel } from "./booking-format";
import {
  requiresVariantSelection,
  selectBookingCategory,
  selectBookingHairstyle,
  selectGalleryImage,
  selectedBookingCover,
} from "./booking-style-selection";
import styles from "./BookingExperience.module.css";

type Availability = {
  location: { id: string; name: string; address: string | null; timeZone: string };
  dates: Array<{ date: string; slots: Array<{ id: string; time: string; availability: "available" | "limited" | "full"; available: boolean }> }>;
};
type Quote = { totalPriceCents: number; depositAmountCents: number; balanceDueCents: number };
type Details = {
  name: string;
  email: string;
  phone: string;
  preferredStylistName: string;
  customerNotes: string;
  hairstyleId: string;
  hairstyleVariantId: string;
  emailMarketingConsent: boolean;
  smsMarketingConsent: boolean;
};
type BookableHairstyle = {
  id: string;
  name: string;
  description: string | null;
  category: { id: string; name: string; slug: string };
  requiresVariant: boolean;
  priceCents: number | null;
  variants: Array<{
    id: string;
    name: string;
    description: string | null;
    priceCents: number;
    coverImage: PublicHairstyleCoverImage | null;
    gallery: PublicHairstyleCoverImage[];
  }>;
  coverImage: PublicHairstyleCoverImage | null;
  gallery: PublicHairstyleCoverImage[];
};
type CreatedBooking = { totalPriceCents: number; depositAmountCents: number; balanceDueCents: number };
type Props = { hairstyles: BookableHairstyle[]; consentWording: { email: string; sms: string } };

const initialDetails: Details = {
  name: "",
  email: "",
  phone: "",
  preferredStylistName: "",
  customerNotes: "",
  hairstyleId: "",
  hairstyleVariantId: "",
  emailMarketingConsent: false,
  smsMarketingConsent: false,
};
const FIELD_ORDER: PublicContactField[] = ["name", "email", "phone", "preferredStylistName"];
const STEP_LABELS = ["Style", "Date & time", "Details", "Review"] as const;

export function BookingExperience({ hairstyles, consentWording }: Props) {
  const router = useRouter();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [date, setDate] = useState("");
  const [slotId, setSlotId] = useState("");
  const [details, setDetails] = useState<Details>(initialDetails);
  const [problems, setProblems] = useState<Partial<Record<PublicContactField, string>>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdQuote, setCreatedQuote] = useState<Quote | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState(() => hairstyles[0]?.category.id ?? "");
  const [galleryImageIndex, setGalleryImageIndex] = useState(0);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const selectedDateButton = useRef<HTMLButtonElement>(null);
  const variantOptions = useRef<HTMLFieldSetElement>(null);
  const fields = useRef<Partial<Record<PublicContactField, HTMLInputElement | null>>>({});

  const applyAvailability = useCallback((value: Availability, keepDate?: string) => {
    setAvailability(value);
    setDate(value.dates.some((item) => item.date === keepDate)
      ? keepDate!
      : value.dates.find((item) => item.slots.some((slot) => slot.available))?.date ?? value.dates[0]?.date ?? "");
  }, []);

  useEffect(() => {
    fetchAvailability().then((value) => applyAvailability(value)).catch(() => setMessage("Online booking is not available right now. Please try again later."));
  }, [applyAvailability]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (step === 2) selectedDateButton.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [date, step]);

  const selectedStyle = useMemo(() => hairstyles.find((style) => style.id === details.hairstyleId) ?? null, [details.hairstyleId, hairstyles]);
  const selectedVariant = selectedStyle?.variants.find((variant) => variant.id === details.hairstyleVariantId) ?? null;
  const selectedDate = useMemo(() => availability?.dates.find((item) => item.date === date), [availability, date]);
  const selectedSlot = selectedDate?.slots.find((slot) => slot.id === slotId && slot.available);
  const displayedQuote = createdQuote ?? (selectedStyle ? quoteFor(selectedStyle, selectedVariant) : null);
  const stylesByCategory = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; styles: BookableHairstyle[] }>();
    for (const hairstyle of hairstyles) {
      const group = groups.get(hairstyle.category.id) ?? {
        id: hairstyle.category.id,
        name: hairstyle.category.name,
        styles: [],
      };
      group.styles.push(hairstyle);
      groups.set(hairstyle.category.id, group);
    }
    return [...groups.values()];
  }, [hairstyles]);
  const activeCategory = stylesByCategory.find((category) => category.id === activeCategoryId) ?? stylesByCategory[0] ?? null;
  const update = (patch: Partial<Details>) => setDetails((current) => ({ ...current, ...patch }));

  function chooseStyle(style: BookableHairstyle) {
    const next = selectBookingHairstyle(details, style.id);
    update(next);
    if (next !== details) setGalleryImageIndex(0);
    setCreatedQuote(null);
    setMessage("");
  }

  function chooseCategory(categoryId: string) {
    if (categoryId === activeCategoryId) return;
    const next = selectBookingCategory(details, selectedStyle?.category.id ?? null, categoryId);
    update(next);
    if (next !== details) setGalleryImageIndex(0);
    setActiveCategoryId(categoryId);
    setCreatedQuote(null);
    setMessage("");
  }

  function chooseVariant(variantId: string) {
    update({ hairstyleVariantId: variantId });
    setGalleryImageIndex(0);
    setCreatedQuote(null);
    setMessage("");
  }

  function continueToTime() {
    if (!selectedStyle || requiresVariantSelection(selectedStyle.requiresVariant, details.hairstyleVariantId)) {
      setMessage(selectedStyle?.requiresVariant ? "Choose a size or variant to continue." : "Choose a service to continue.");
      if (selectedStyle?.requiresVariant) {
        variantOptions.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        variantOptions.current?.focus({ preventScroll: true });
      }
      return;
    }
    setMessage("");
    setStep(2);
  }

  function reviewDetails(event: FormEvent) {
    event.preventDefault();
    const found = publicContactProblems(details);
    setProblems(found);
    const first = FIELD_ORDER.find((field) => found[field]);
    if (first) fields.current[first]?.focus();
    else setStep(4);
  }

  async function openCheckout() {
    const checkout = await postJson("/api/bookings/checkout");
    const body = checkout.ok ? await checkout.json() as { checkout?: { url?: string } } : null;
    if (body?.checkout?.url) return window.location.assign(body.checkout.url);
    router.push("/book/status");
  }

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!availability || !selectedSlot || !selectedStyle || !displayedQuote || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (createdQuote) return await openCheckout();
      const created = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: details.name,
          email: details.email,
          phone: details.phone,
          preferredStylistName: details.preferredStylistName.trim() || null,
          customerNotes: details.customerNotes.trim() || null,
          hairstyleId: selectedStyle.id,
          hairstyleVariantId: selectedVariant?.id ?? null,
          emailMarketingConsent: details.emailMarketingConsent,
          smsMarketingConsent: details.smsMarketingConsent,
          locationId: availability.location.id,
          bookingSlotId: selectedSlot.id,
          appointmentDate: date,
        }),
      });
      if (!created.ok) return await recoverFromCreateFailure(await apiError(created));
      const persistedQuote = (await created.json() as { booking: CreatedBooking }).booking;
      setCreatedQuote(persistedQuote);
      if (!sameQuote(displayedQuote, persistedQuote)) {
        setMessage("The service price changed while you were choosing. Please review the updated total before paying.");
        submitting.current = false;
        setBusy(false);
        return;
      }
      await openCheckout();
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
    if (error.code === "SLOT_FULL") {
      await fetchAvailability().then((value) => applyAvailability(value, date)).catch(() => undefined);
      setSlotId("");
      setStep(2);
      setMessage("That time was just taken. Please choose another time.");
      return;
    }
    if (["BOOKING_OPTION_UNAVAILABLE", "INVALID_BOOKING_INPUT", "HAIRSTYLE_NOT_AVAILABLE", "HAIRSTYLE_VARIANT_REQUIRED", "HAIRSTYLE_VARIANT_NOT_AVAILABLE"].includes(error.code)) {
      setCreatedQuote(null);
      setSlotId("");
      setStep(1);
      setMessage("A selected service or time is no longer available. Please review your booking choices.");
      return;
    }
    setMessage(error.message);
  }

  if (!availability) {
    return <main className={styles.page}><Header /><section className={styles.loadingPanel}><p className={styles.eyebrow}>BOOK ONLINE</p><h1>Book your appointment</h1><p role={message ? "alert" : "status"} className={message ? styles.error : styles.loadingCopy}>{message || "Finding available times…"}</p></section></main>;
  }

  const zone = zoneLabel(availability.location.timeZone);
  const errorFor = (field: PublicContactField) => problems[field] ? { "aria-invalid": true as const, "aria-describedby": `${field}-error` } : {};
  const title = ["Choose your style", "Choose your date & time", "Your details", "Review & pay"][step - 1];
  const summary = <BookingSummary location={availability.location} style={selectedStyle} variant={selectedVariant} date={date} slot={selectedSlot} quote={displayedQuote} zone={zone} />;

  return <main className={styles.page}>
    <Header place={availability.location.address ?? availability.location.name} />
    <div className={styles.bookingLayout}>
      <section className={styles.panel} aria-labelledby="booking-title">
        <div className={styles.panelIntro}>
          <p className={styles.eyebrow}>YOUR APPOINTMENT</p>
          <ol className={styles.steps} aria-label={`Booking step ${step} of 4`}>
            {STEP_LABELS.map((label, index) => {
              const number = index + 1;
              const complete = number < step;
              return <li key={label} className={number === step ? styles.currentStep : complete ? styles.completeStep : undefined}>
                <button type="button" disabled={!complete || Boolean(createdQuote)} onClick={() => setStep(number as 1 | 2 | 3 | 4)} aria-current={number === step ? "step" : undefined}>
                  <span>{complete ? "✓" : number}</span><b>{label}</b>
                </button>
              </li>;
            })}
          </ol>
          <h1 id="booking-title" ref={heading} tabIndex={-1}>{title}</h1>
          {message && <p className={styles.error} role="alert">{message}</p>}
        </div>

        <details className={styles.mobileSummary}>
          <summary><span>Booking summary</span><strong>{displayedQuote ? money(displayedQuote.depositAmountCents) : "Add a service"}</strong></summary>
          {summary}
        </details>

        {step === 1 && <section className={styles.stage} aria-label="Choose your style">
          <p className={styles.stageLead}>Select a service to see your appointment total. We’ll confirm the final quote before you pay.</p>
          {hairstyles.length === 0
            ? <div className={styles.emptyState}><strong>Online services are being refreshed.</strong><p>Please contact the salon to reserve your appointment.</p></div>
            : <>
              <div className={styles.categoryTabs} role="tablist" aria-label="Service categories">
                {stylesByCategory.map((category) => <button key={category.id} id={`category-tab-${category.id}`} type="button" role="tab" aria-selected={activeCategory?.id === category.id} aria-controls={`category-panel-${category.id}`} className={activeCategory?.id === category.id ? styles.selected : ""} onClick={() => chooseCategory(category.id)}>{category.name}</button>)}
              </div>
              {activeCategory && <section className={styles.categoryGroup} id={`category-panel-${activeCategory.id}`} role="tabpanel" aria-labelledby={`category-tab-${activeCategory.id}`}>
              <h2>{activeCategory.name}</h2>
              <div className={styles.styleGrid}>
                {activeCategory.styles.map((style) => {
                  const isSelected = style.id === details.hairstyleId;
                  const hasInlineVariants = isSelected && style.requiresVariant;

                  return <div key={style.id} className={`${styles.styleChoice} ${hasInlineVariants ? styles.styleChoiceWithVariants : ""}`}>
                    <button type="button" className={`${styles.styleCard} ${isSelected ? styles.selected : ""}`} aria-pressed={isSelected} aria-expanded={style.requiresVariant ? isSelected : undefined} aria-controls={hasInlineVariants ? `variant-options-${style.id}` : undefined} onClick={() => chooseStyle(style)}>
                      <span className={styles.styleImage}><PublicHairstyleCover image={style.coverImage} hairstyleName={style.name} sizes="(max-width: 430px) 42vw, (max-width: 900px) 30vw, 230px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} /></span>
                      <span className={styles.styleCardBody}><span className={styles.styleCardHeader}><strong>{style.name}</strong><b>{style.requiresVariant ? "From " + money(Math.min(...style.variants.map((variant) => variant.priceCents))) : money(style.priceCents!)}</b></span>{style.description && <span className={styles.description}>{style.description}</span>}<span className={styles.selectLabel}>{isSelected ? "Selected" : style.requiresVariant ? "Choose options" : "Select service"}</span></span>
                    </button>
                    {hasInlineVariants && <fieldset ref={variantOptions} id={`variant-options-${style.id}`} className={styles.inlineVariants} tabIndex={-1}>
                      <legend>Choose your {style.name} option</legend>
                      <p className={styles.variantAnnouncement} role="status">{style.variants.length} options available for {style.name}.</p>
                      <div className={styles.variantGrid}>{style.variants.map((variant) => <button key={variant.id} type="button" aria-pressed={variant.id === details.hairstyleVariantId} className={variant.id === details.hairstyleVariantId ? styles.selected : ""} onClick={() => chooseVariant(variant.id)}>
                        <span className={styles.variantImage}><PublicHairstyleCover image={variant.coverImage} hairstyleName={variant.name} sizes="(max-width: 600px) 34vw, 160px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} /></span>
                        <span className={styles.variantBody}><span><strong>{variant.name}</strong><b>{money(variant.priceCents)}</b></span>{variant.description && <small>{variant.description}</small>}<em>{variant.id === details.hairstyleVariantId ? "Selected" : "Select this look"}</em></span>
                      </button>)}</div>
                      {selectedVariant && <VariantGallery variant={selectedVariant} galleryImageIndex={galleryImageIndex} onSelectImage={setGalleryImageIndex} />}
                    </fieldset>}
                  </div>;
                })}
              </div>
            </section>}
            </>}
          <button type="button" className={styles.primary} disabled={!selectedStyle || requiresVariantSelection(selectedStyle.requiresVariant, details.hairstyleVariantId)} onClick={continueToTime}>Continue to date & time <span aria-hidden="true">→</span></button>
        </section>}

        {step === 2 && <section className={styles.stage} aria-label="Choose date and time">
          <div className={styles.sectionHeading}><div><p className={styles.kicker}>SALON TIME</p><h2>Find a weekday that works</h2></div><p>Weekend appointments are walk-in only.</p></div>
          <fieldset className={styles.dateFieldset}><legend>Available dates</legend>{availability.dates.length === 0 && <div className={styles.emptyState}>No online times are open right now. Please contact the salon.</div>}<div className={styles.dateStrip}>{availability.dates.map((item) => <button ref={item.date === date ? selectedDateButton : null} type="button" key={item.date} aria-pressed={item.date === date} className={item.date === date ? styles.selected : ""} onClick={() => { setDate(item.date); setSlotId(""); }}><span>{new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${item.date}T00:00:00Z`))}</span><strong>{new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(new Date(`${item.date}T00:00:00Z`))}</strong><small>{new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${item.date}T00:00:00Z`))}</small></button>)}</div></fieldset>
          <fieldset className={styles.timeFieldset}><legend>Available times <span>{zone}</span></legend><div className={styles.slots}>{selectedDate?.slots.map((slot) => <button type="button" key={slot.id} disabled={!slot.available} aria-pressed={slot.id === slotId} className={slot.id === slotId ? styles.selected : ""} onClick={() => setSlotId(slot.id)}><strong>{timeLabel(slot.time)}</strong><small>{!slot.available ? (slot.availability === "full" ? "Fully booked" : "Unavailable") : slot.availability === "limited" ? "Few spots left" : "Available"}</small></button>)}</div></fieldset>
          <div className={styles.actions}><button type="button" className={styles.secondaryAction} onClick={() => setStep(1)}>Back</button><button type="button" className={styles.primary} disabled={!selectedSlot} onClick={() => { setMessage(""); setStep(3); }}>Continue <span aria-hidden="true">→</span></button></div>
        </section>}

        {step === 3 && <form className={styles.stage} onSubmit={reviewDetails} noValidate>
          <div className={styles.sectionHeading}><div><p className={styles.kicker}>ALMOST THERE</p><h2>How can we reach you?</h2></div><p>We’ll use these details only for your appointment.</p></div>
          <div className={styles.formGrid}>{(["name", "email", "phone"] as const).map((field) => <label key={field}>{field === "name" ? "Full name" : field === "email" ? "Email address" : "Phone number"}<input ref={(element) => { fields.current[field] = element; }} type={field === "email" ? "email" : field === "phone" ? "tel" : "text"} autoComplete={field === "name" ? "name" : field === "email" ? "email" : "tel"} inputMode={field === "phone" ? "tel" : field === "email" ? "email" : undefined} value={details[field]} onChange={(event) => update({ [field]: event.target.value })} required maxLength={PUBLIC_BOOKING_LIMITS[field]} {...errorFor(field)} />{problems[field] && <span id={`${field}-error`} className={styles.fieldError}>{problems[field]}</span>}</label>)}</div>
          <label>Preferred stylist <em>Optional</em><input ref={(element) => { fields.current.preferredStylistName = element; }} value={details.preferredStylistName} onChange={(event) => update({ preferredStylistName: event.target.value })} maxLength={PUBLIC_BOOKING_LIMITS.preferredStylistName} {...errorFor("preferredStylistName")} />{problems.preferredStylistName && <span id="preferredStylistName-error" className={styles.fieldError}>{problems.preferredStylistName}</span>}</label>
          <label>Notes for your stylist <em>Optional</em><textarea value={details.customerNotes} onChange={(event) => update({ customerNotes: event.target.value })} maxLength={PUBLIC_BOOKING_LIMITS.customerNotes} rows={4} /></label>
          <fieldset className={styles.marketing}><legend>Keep in touch <span>Optional</span></legend><p>These messages are optional and never required to book.</p><label className={styles.checkbox}><input type="checkbox" checked={details.emailMarketingConsent} onChange={(event) => update({ emailMarketingConsent: event.target.checked })} /> <span>{consentWording.email}</span></label><label className={styles.checkbox}><input type="checkbox" checked={details.smsMarketingConsent} onChange={(event) => update({ smsMarketingConsent: event.target.checked })} /> <span>{consentWording.sms}</span></label></fieldset>
          <div className={styles.actions}><button type="button" className={styles.secondaryAction} onClick={() => setStep(2)}>Back</button><button className={styles.primary}>Continue to review <span aria-hidden="true">→</span></button></div>
        </form>}

        {step === 4 && <form className={styles.stage} onSubmit={pay}>
          <div className={styles.sectionHeading}><div><p className={styles.kicker}>YOUR APPOINTMENT</p><h2>Review before you reserve</h2></div><p>Secure payment is handled by Stripe.</p></div>
          <div className={styles.reviewCard}>
            <div className={styles.reviewImage}><PublicHairstyleCover image={coverFor(selectedStyle, selectedVariant)} hairstyleName={selectedVariant?.name ?? selectedStyle?.name ?? "Selected hairstyle"} sizes="112px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} /></div>
            <div><strong>{selectedStyle?.name}</strong>{selectedVariant && <span>{selectedVariant.name}</span>}<small>{dateLabel(date, "long")} · {selectedSlot ? timeLabel(selectedSlot.time) : ""} {zone}</small></div>
          </div>
          <dl className={styles.review}><dt>Salon</dt><dd>{availability.location.address ?? availability.location.name}</dd><dt>Guest</dt><dd>{details.name.trim()}</dd><dt>Service total</dt><dd>{displayedQuote && money(displayedQuote.totalPriceCents)}</dd><dt>Deposit due today</dt><dd className={styles.deposit}>{displayedQuote && money(displayedQuote.depositAmountCents)}</dd><dt>Due after your service</dt><dd>{displayedQuote && money(displayedQuote.balanceDueCents)}</dd></dl>
          <p className={styles.depositNote}>Your <strong>{displayedQuote && money(displayedQuote.depositAmountCents)} nonrefundable deposit</strong> reserves this time. The remaining balance is paid at the salon after your service. Your booking is confirmed only after payment is verified.</p>
          <div className={styles.actions}>{!createdQuote && <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => setStep(3)}>Back</button>}<button className={styles.primary} disabled={busy || !selectedSlot} aria-busy={busy}>{busy ? "Reserving your time…" : `Reserve & pay ${displayedQuote && money(displayedQuote.depositAmountCents)} deposit`} <span aria-hidden="true">→</span></button></div>
        </form>}
      </section>
      <aside className={styles.desktopSummary} aria-label="Booking summary">{summary}</aside>
    </div>
  </main>;
}

function BookingSummary({ location, style, variant, date, slot, quote, zone }: {
  location: Availability["location"];
  style: BookableHairstyle | null;
  variant: BookableHairstyle["variants"][number] | null | undefined;
  date: string;
  slot: Availability["dates"][number]["slots"][number] | undefined;
  quote: Quote | null;
  zone: string;
}) {
  return <div className={styles.summaryCard}>
    <p className={styles.summaryEyebrow}>BOOKING SUMMARY</p>
    <div className={styles.summaryStyle}>
      <div className={styles.summaryImage}><PublicHairstyleCover image={coverFor(style, variant)} hairstyleName={variant?.name ?? style?.name ?? "Your selected style"} sizes="112px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} /></div>
      <div><strong>{style?.name ?? "Choose your style"}</strong><span>{variant?.name ?? (style?.requiresVariant ? "Choose an option" : "Service selection")}</span></div>
    </div>
    <dl className={styles.summaryList}>
      <dt>When</dt><dd>{date && slot ? <>{dateLabel(date, "long")}<br />{timeLabel(slot.time)} {zone}</> : "Choose a date & time"}</dd>
      <dt>Where</dt><dd>{location.address ?? location.name}</dd>
    </dl>
    <div className={styles.summaryPrices}>
      <p><span>Service total</span><strong>{quote ? money(quote.totalPriceCents) : "—"}</strong></p>
      <p><span>Due today</span><strong>{quote ? money(quote.depositAmountCents) : "—"}</strong></p>
      <p><span>Due at salon</span><strong>{quote ? money(quote.balanceDueCents) : "—"}</strong></p>
    </div>
  </div>;
}

function VariantGallery({ variant, galleryImageIndex, onSelectImage }: {
  variant: BookableHairstyle["variants"][number];
  galleryImageIndex: number;
  onSelectImage: (index: number) => void;
}) {
  const image = selectGalleryImage(variant.gallery, variant.coverImage, galleryImageIndex);
  if (!image) return null;

  return <section className={styles.variantGallery} aria-label={`${variant.name} photo gallery`}>
    <div className={styles.variantGalleryMain}>
      <PublicHairstyleCover image={image} hairstyleName={variant.name} sizes="(max-width: 600px) 100vw, 420px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} />
    </div>
    {variant.gallery.length > 1 && <div className={styles.variantThumbnails} aria-label={`Choose a ${variant.name} photo`}>
      {variant.gallery.map((photo, index) => <button key={photo.deliveryUrl} type="button" aria-pressed={index === galleryImageIndex} aria-label={`View ${variant.name} photo ${index + 1} of ${variant.gallery.length}`} className={index === galleryImageIndex ? styles.selected : ""} onClick={() => onSelectImage(index)}>
        <span><PublicHairstyleCover image={photo} hairstyleName={variant.name} sizes="72px" className={styles.hairstyleImage} fallbackClassName={styles.hairstyleFallback} /></span>
      </button>)}
    </div>}
  </section>;
}

function coverFor(
  style: BookableHairstyle | null,
  variant: BookableHairstyle["variants"][number] | null | undefined,
): PublicHairstyleCoverImage | null {
  return selectedBookingCover(style?.coverImage ?? null, variant?.coverImage);
}

function quoteFor(style: BookableHairstyle, variant: BookableHairstyle["variants"][number] | null | undefined): Quote | null {
  const totalPriceCents = style.requiresVariant ? variant?.priceCents : style.priceCents;
  if (totalPriceCents === null || totalPriceCents === undefined) return null;
  return { totalPriceCents, depositAmountCents: 4_000, balanceDueCents: totalPriceCents - 4_000 };
}

function sameQuote(left: Quote, right: Quote): boolean {
  return left.totalPriceCents === right.totalPriceCents && left.depositAmountCents === right.depositAmountCents && left.balanceDueCents === right.balanceDueCents;
}

async function fetchAvailability(): Promise<Availability> {
  const response = await fetch("/api/bookings/availability", { cache: "no-store" });
  if (!response.ok) throw new Error((await apiError(response)).message);
  return (await response.json() as { availability: Availability }).availability;
}

function Header({ place }: { place?: string }) {
  return <header className={styles.header}><Link href="/" className={styles.brand}>YASMIN’S <span>BEAUTY SALON</span></Link>{place && <address className={styles.place}>{place}</address>}</header>;
}
