import Link from "next/link";

import { AdminDashboardPreview } from "@/components/admin/AdminAppointmentCard";
import { AdminShell } from "@/components/admin/AdminShell";
import { STATUS_LABELS, dateLabel } from "@/components/admin/admin-format";
import styles from "@/components/admin/Admin.module.css";
import { APPOINTMENT_STATUSES, getAdminDashboard } from "@/lib/admin/appointments";
import { requireAdmin } from "@/lib/admin/dal";

export default async function AdminDashboardPage() {
  const access = await requireAdmin();
  const dashboard = await getAdminDashboard(access);
  const preview = (title: string, count: number, appointments: typeof dashboard.pending.appointments, empty: string, href: string, kind: "today" | "upcoming" | "pending") => (
    <section className={styles.previewPanel} aria-label={title}>
      <div className={styles.previewHeading}>
        <h2>{title}</h2>
        <Link className={styles.more} href={href}>View all</Link>
      </div>
      <AdminDashboardPreview appointments={appointments} empty={empty} kind={kind} />
      {count > appointments.length && <p className={styles.previewCount}>Showing 3 of {count}</p>}
    </section>
  );

  return (
    <AdminShell current="dashboard" email={access.email}>
      <p className={styles.eyebrow}>{dateLabel(dashboard.today, "long")}</p>
      <h1 className={styles.title}>Dashboard</h1>
      <ul className={styles.counts} aria-label="Appointments by status (all time)">
        {APPOINTMENT_STATUSES.map((status) => (
          <li key={status}>
            <Link className={styles.count} href={`/admin/appointments?status=${status}`}>
              <strong>{dashboard.countsByStatus[status]}</strong>
              <span>{STATUS_LABELS[status]}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className={styles.previewGrid}>
        {preview("Today’s appointments", dashboard.todayAppointments.count, dashboard.todayAppointments.appointments, "Nothing on the chair today.", `/admin/appointments?date=${dashboard.today}`, "today")}
        {preview("Upcoming appointments", dashboard.upcoming.count, dashboard.upcoming.appointments, "Your upcoming book is clear.", "/admin/appointments?range=upcoming", "upcoming")}
        {preview("Pending payment", dashboard.pending.count, dashboard.pending.appointments, "No pending deposits right now.", "/admin/appointments?status=PENDING_PAYMENT", "pending")}
      </div>
    </AdminShell>
  );
}
