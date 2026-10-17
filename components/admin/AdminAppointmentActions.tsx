"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./Admin.module.css";

type Props = {
  appointment: {
    id: string;
    status: "PENDING_PAYMENT" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
    customerName: string;
    hairstyleName: string | null;
    appointmentDate: string;
    slotTime: string;
    updatedAt: string;
    depositReceived: boolean;
    hasOpenCheckout: boolean;
  };
};

type Pending = { body: Record<string, unknown>; label: string };
type Availability = { locationId: string; closedReason: string | null; slots: Array<{ bookingSlotId: string; startTime: string; remainingCapacity: number }> };

const labelFor = (status: Props["appointment"]["status"]) => status.replaceAll("_", " ").toLowerCase();

/** Interactive layer only; the authenticated action service remains policy authority. */
export function AdminAppointmentActions({ appointment }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"cancel" | "reschedule" | null>(null);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(appointment.appointmentDate);
  const [slotId, setSlotId] = useState("");
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const canCancel = appointment.status === "CONFIRMED" || appointment.status === "PENDING_PAYMENT";
  const canReschedule = appointment.status === "CONFIRMED";

  useEffect(() => {
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && mode && !busy) {
        setMode(null);
      }
    }

    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [busy, mode]);

  async function loadSlots(nextDate: string) {
    setDate(nextDate);
    setSlotId("");
    setAvailability(null);
    if (!nextDate) return;
    const response = await fetch(`/api/admin/appointments/${encodeURIComponent(appointment.id)}/availability?date=${encodeURIComponent(nextDate)}`, { credentials: "same-origin" });
    const data = await response.json() as { availability?: Availability; error?: { code?: string } };
    if (!response.ok || !data.availability) {
      setMessage(data.error?.code === "SESSION_INVALID" ? "Your session has ended. Please sign in again." : "Availability could not be loaded. Choose another date or try again.");
      return;
    }
    setAvailability(data.availability);
  }

  async function submit(body: Record<string, unknown>, label: string) {
    setBusy(true);
    setMessage(null);
    const attempt = { body, label };
    setPending(attempt);
    try {
      const response = await fetch(`/api/admin/appointments/${encodeURIComponent(appointment.id)}/actions`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { appointment?: { status: string }; error?: { code?: string } };
      if (!response.ok) {
        const code = data.error?.code;
        setMessage(code === "STALE_APPOINTMENT" ? "This appointment changed. Reload the current record before trying again." : code === "CAPACITY_FULL" ? "That time was just taken. Please choose another available time." : code === "SESSION_INVALID" ? "Your session has ended. Please sign in again." : "We could not complete that action. Review the details and try again.");
        return;
      }
      setPending(null);
      setMode(null);
      setReason("");
      setMessage(`${label} confirmed. The appointment is now ${labelFor(data.appointment?.status as Props["appointment"]["status"])}.`);
      router.refresh();
    } catch {
      setMessage("Connection uncertain. Retry will use the same action ID and will not duplicate the change.");
    } finally {
      setBusy(false);
    }
  }

  function startCancel() {
    setMessage(null);
    setReason("");
    setMode("cancel");
  }

  function startReschedule() {
    setMessage(null);
    setReason("");
    setDate(appointment.appointmentDate);
    setSlotId("");
    setMode("reschedule");
    void loadSlots(appointment.appointmentDate);
  }

  if (!canCancel && !canReschedule) {
    return <section className={styles.panel} aria-label="Manage appointment"><h2>Manage appointment</h2><p className={styles.empty}>This appointment is {labelFor(appointment.status)}. No further appointment actions are available.</p></section>;
  }

  const operationId = () => crypto.randomUUID();
  return (
    <section className={styles.panel} aria-label="Manage appointment">
      <h2>Manage appointment</h2>
      <p className={styles.muted}>Administrative changes are recorded in the appointment history.</p>
      <div className={styles.actionRow}>
        {canReschedule && <button className={styles.secondary} type="button" onClick={startReschedule}>Reschedule</button>}
        {canCancel && <button className={styles.danger} type="button" onClick={startCancel}>Cancel appointment</button>}
      </div>
      {message && <p className={styles.actionMessage} role="status">{message}</p>}
      {pending && !busy && <button className={styles.secondary} type="button" onClick={() => void submit(pending.body, pending.label)}>Retry {pending.label.toLowerCase()}</button>}

      {mode && <div className={styles.dialogBackdrop} role="presentation">
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="appointment-action-title">
          <div className={styles.dialogHeading}><div><p className={styles.eyebrow}>{mode === "cancel" ? "Cancellation" : "Reschedule"}</p><h2 id="appointment-action-title">{mode === "cancel" ? "Cancel this appointment?" : "Choose a new time"}</h2></div><button className={styles.close} type="button" onClick={() => !busy && setMode(null)} aria-label="Close">×</button></div>
          <dl className={styles.actionFacts}>
            <dt>Customer</dt><dd>{appointment.customerName}</dd><dt>Service</dt><dd>{appointment.hairstyleName ?? "No preference"}</dd><dt>Current schedule</dt><dd>{appointment.appointmentDate} at {appointment.slotTime}</dd><dt>Status</dt><dd>{labelFor(appointment.status)}</dd>
            {appointment.depositReceived && <><dt>Deposit</dt><dd>Received</dd></>}
          </dl>
          {mode === "cancel" ? <>
            <p className={styles.notice}>Cancellation does not automatically refund a deposit.{appointment.hasOpenCheckout ? " A Checkout payment may still arrive and will require reconciliation." : ""}</p>
            <label className={styles.actionLabel}>Cancellation reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={1} maxLength={500} /></label>
            <div className={styles.dialogActions}><button className={styles.secondary} type="button" onClick={() => setMode(null)} disabled={busy}>Keep appointment</button><button className={styles.danger} type="button" disabled={busy || !reason.trim()} onClick={() => void submit({ action: { kind: "cancel" }, operationId: pending?.body.operationId ?? operationId(), expectedUpdatedAt: appointment.updatedAt, reason: reason.trim() }, "Cancellation")}>{busy ? "Cancelling…" : "Confirm cancellation"}</button></div>
          </> : <>
            <p className={styles.notice}>The existing deposit carries over. No new deposit is charged.</p>
            <label className={styles.actionLabel}>New date<input type="date" value={date} onChange={(event) => void loadSlots(event.target.value)} /></label>
            {availability?.closedReason ? <p className={styles.error}>This date is not available for online bookings.</p> : <fieldset className={styles.slotChoices}><legend>Available times</legend>{availability ? availability.slots.length ? availability.slots.map((slot) => <label key={slot.bookingSlotId}><input type="radio" name="slot" value={slot.bookingSlotId} checked={slotId === slot.bookingSlotId} onChange={() => setSlotId(slot.bookingSlotId)} /> {slot.startTime} <span>{slot.remainingCapacity} remaining</span></label>) : <p className={styles.empty}>No future available times on this date.</p> : <p className={styles.empty}>Loading times…</p>}</fieldset>}
            <label className={styles.actionLabel}>Rescheduling reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={1} maxLength={500} /></label>
            {slotId && <p className={styles.notice}>Proposed schedule: {date} at {availability?.slots.find((slot) => slot.bookingSlotId === slotId)?.startTime}.</p>}
            <div className={styles.dialogActions}><button className={styles.secondary} type="button" onClick={() => setMode(null)} disabled={busy}>Keep schedule</button><button className={styles.primary} type="button" disabled={busy || !slotId || !reason.trim() || !availability} onClick={() => availability && void submit({ action: { kind: "reschedule", appointmentDate: date, bookingSlotId: slotId, locationId: availability.locationId }, operationId: pending?.body.operationId ?? operationId(), expectedUpdatedAt: appointment.updatedAt, reason: reason.trim() }, "Reschedule")}>{busy ? "Saving…" : "Confirm reschedule"}</button></div>
          </>}
        </section>
      </div>}
    </section>
  );
}
