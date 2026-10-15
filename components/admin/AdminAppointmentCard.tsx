import Link from "next/link";

import type { AdminAppointmentSummary } from "@/lib/admin/appointments";

import { STATUS_LABELS, dateLabel, money, timeLabel } from "./admin-format";
import styles from "./Admin.module.css";

export function AdminAppointmentList({ appointments, empty }: { appointments: AdminAppointmentSummary[]; empty: string }) {
  if (appointments.length === 0) return <p className={styles.empty}>{empty}</p>;
  return (
    <ul className={styles.list}>
      {appointments.map((appointment) => <li key={appointment.id}><AdminAppointmentCard appointment={appointment} /></li>)}
    </ul>
  );
}

/** Compact dashboard rows deliberately omit contact and full booking details. */
export function AdminDashboardPreview({
  appointments,
  empty,
  kind,
}: {
  appointments: AdminAppointmentSummary[];
  empty: string;
  kind: "today" | "upcoming" | "pending";
}) {
  if (appointments.length === 0) return <p className={styles.empty}>{empty}</p>;

  return (
    <ul className={styles.previewList}>
      {appointments.map((appointment) => (
        <li key={appointment.id}>
          <Link className={styles.previewRow} href={`/admin/appointments/${appointment.id}`}>
            <span className={styles.previewIdentity}>
              <span className={styles.cardTitle}>{appointment.customerName}</span>
              <span className={styles.previewMeta}>
                {kind === "today" && timeLabel(appointment.slotTime)}
                {kind === "upcoming" && `${dateLabel(appointment.appointmentDate)} · ${timeLabel(appointment.slotTime)}`}
                {kind === "pending" && `${dateLabel(appointment.appointmentDate)} · ${appointment.payment.depositLabel}`}
              </span>
            </span>
            {kind === "pending" ? (
              <span className={styles.previewState}>{appointment.payment.depositLabel}</span>
            ) : (
              <span className={styles.badge} data-status={appointment.status}>{STATUS_LABELS[appointment.status]}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AdminAppointmentCard({ appointment }: { appointment: AdminAppointmentSummary }) {
  return (
    <Link className={styles.card} href={`/admin/appointments/${appointment.id}`}>
      <span className={styles.cardTop}>
        <span className={styles.cardTitle}>{appointment.customerName}</span>
        <span className={styles.badge} data-status={appointment.status}>{STATUS_LABELS[appointment.status]}</span>
      </span>
      <span className={styles.muted}>{dateLabel(appointment.appointmentDate)} · {timeLabel(appointment.slotTime)} · {appointment.locationName}</span>
      <span className={styles.muted}>{appointment.payment.depositLabel} · Remaining {money(appointment.payment.remainingCents)}{appointment.hairstyleName ? ` · ${appointment.hairstyleName}` : ""}</span>
      {appointment.payment.needsAttention && <span className={styles.attention}>Needs attention</span>}
    </Link>
  );
}
