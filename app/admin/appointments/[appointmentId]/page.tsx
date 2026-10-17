import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminShell } from "@/components/admin/AdminShell";
import { AdminAppointmentActions } from "@/components/admin/AdminAppointmentActions";
import { STATUS_LABELS, dateLabel, instantLabel, money, timeLabel, zoneShort } from "@/components/admin/admin-format";
import styles from "@/components/admin/Admin.module.css";
import { getAdminAppointmentDetail } from "@/lib/admin/appointments";
import { requireAdmin } from "@/lib/admin/dal";

export default async function AdminAppointmentDetailPage({ params }: PageProps<"/admin/appointments/[appointmentId]">) {
  const access = await requireAdmin();
  const { appointmentId } = await params;
  const detail = await getAdminAppointmentDetail(access, appointmentId);
  if (!detail) notFound();
  const zone = detail.location.timeZone;
  const { payment } = detail;

  return (
    <AdminShell current="appointments" email={access.email}>
      <Link className={styles.more} href="/admin/appointments">← All appointments</Link>
      <p className={styles.eyebrow}>{STATUS_LABELS[detail.status]}</p>
      <h1 className={styles.title}>{detail.customer.name}</h1>
      {payment.needsAttention && <p className={styles.error} role="status">This booking’s payment needs attention: review it before contacting the customer.</p>}
      <section className={styles.panel} aria-label="Appointment">
        <h2>Appointment</h2>
        <dl className={styles.details}>
          <dt>Date and time</dt><dd>{dateLabel(detail.appointmentDate, "long")} at {timeLabel(detail.slotTime)} {zoneShort(zone)}</dd>
          <dt>Status</dt><dd><span className={styles.badge} data-status={detail.status}>{STATUS_LABELS[detail.status]}</span></dd>
          <dt>Location</dt><dd>{detail.location.name}{detail.location.address ? <><br /><span className={styles.muted}>{detail.location.address}</span></> : null}</dd>
          <dt>Hairstyle</dt><dd>{detail.hairstyleName ?? "No preference"}</dd>
          <dt>Preferred stylist</dt><dd>{detail.preferredStylistName ?? "None"}</dd>
          {detail.customerNotes && <><dt>Customer notes</dt><dd>{detail.customerNotes}</dd></>}
          {detail.status === "PENDING_PAYMENT" && detail.holdExpiresAt && <><dt>Hold expires</dt><dd>{instantLabel(detail.holdExpiresAt, zone)}</dd></>}
          <dt>Booked</dt><dd>{instantLabel(detail.createdAt, zone)}</dd>
        </dl>
      </section>
      <section className={styles.panel} aria-label="Customer">
        <h2>Customer</h2>
        <dl className={styles.details}>
          <dt>Name</dt><dd>{detail.customer.name}</dd>
          <dt>Email</dt><dd><a href={`mailto:${detail.customer.email}`}>{detail.customer.email}</a></dd>
          <dt>Phone</dt><dd><a href={`tel:${detail.customer.phone.replace(/[^\d+]/g, "")}`}>{detail.customer.phone}</a></dd>
        </dl>
      </section>
      <section className={styles.panel} aria-label="Payment">
        <h2>Payment</h2>
        <dl className={styles.details}>
          <dt>Total service price</dt><dd>{money(detail.totalPriceCents)}</dd>
          <dt>Deposit ({money(detail.depositAmountCents)})</dt><dd>{payment.depositLabel}</dd>
          {payment.refundedCents > 0 && <><dt>Refunded</dt><dd>{money(payment.refundedCents)}</dd></>}
          {payment.reconciliationReason && <><dt>Reconciliation</dt><dd>{payment.reconciliationReason.replaceAll("_", " ").toLowerCase()}</dd></>}
          <dt>Remaining balance</dt><dd>{money(payment.remainingCents)}{payment.depositPaid ? " due after service" : " (deposit not paid)"}</dd>
        </dl>
      </section>
      <AdminAppointmentActions appointment={{
        id: detail.id,
        status: detail.status,
        customerName: detail.customer.name,
        hairstyleName: detail.hairstyleName,
        appointmentDate: detail.appointmentDate,
        slotTime: detail.slotTime,
        updatedAt: detail.updatedAt.toISOString(),
        depositReceived: detail.payment.depositPaid,
        hasOpenCheckout: detail.payment.depositState === "checkout-started",
      }} />
      <section className={styles.panel} aria-label="History">
        <h2>History</h2>
        {detail.history.length === 0 ? <p className={styles.empty}>No recorded events.</p> : (
          <ol className={styles.history}>
            {detail.history.map((event, index) => <li key={index}>{event.type.replaceAll("_", " ").toLowerCase()} <span className={styles.muted}>· {instantLabel(event.at, zone)}</span></li>)}
          </ol>
        )}
      </section>
    </AdminShell>
  );
}
