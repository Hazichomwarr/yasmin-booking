import Link from "next/link";

import { AdminAppointmentList } from "@/components/admin/AdminAppointmentCard";
import { AdminShell } from "@/components/admin/AdminShell";
import { STATUS_LABELS, dateLabel } from "@/components/admin/admin-format";
import styles from "@/components/admin/Admin.module.css";
import { APPOINTMENT_STATUSES, getAdminDashboard } from "@/lib/admin/appointments";
import { requireAdmin } from "@/lib/admin/dal";

export default async function AdminDashboardPage() {
  const access = await requireAdmin();
  const dashboard = await getAdminDashboard(access);
  const section = (title: string, count: number, list: typeof dashboard.pending.appointments, empty: string, link?: string) => (
    <section className={styles.panel} aria-label={title}>
      <h2>{title} <span className={styles.muted}>({count})</span></h2>
      <AdminAppointmentList appointments={list} empty={empty} />
      {link && count > list.length && <Link className={styles.more} href={link}>View all {count}</Link>}
    </section>
  );

  return (
    <AdminShell current="dashboard" email={access.email}>
      <p className={styles.eyebrow}>{dateLabel(dashboard.today, "long")}</p>
      <h1 className={styles.title}>Dashboard</h1>
      <ul className={styles.counts} aria-label="Appointments by status (all time)">
        {APPOINTMENT_STATUSES.map((status) => (
          <li key={status} className={styles.count}><strong>{dashboard.countsByStatus[status]}</strong><span>{STATUS_LABELS[status]}</span></li>
        ))}
      </ul>
      {section("Today", dashboard.todayAppointments.length, dashboard.todayAppointments, "No appointments today.", `/admin/appointments?date=${dashboard.today}`)}
      <div className={styles.sections}>
        {section("Upcoming", dashboard.upcoming.count, dashboard.upcoming.appointments, "No upcoming appointments.", "/admin/appointments")}
        {section("Confirmed (today and later)", dashboard.confirmedUpcoming.count, dashboard.confirmedUpcoming.appointments, "No confirmed upcoming appointments.", "/admin/appointments?status=CONFIRMED")}
        {section("Pending payment", dashboard.pending.count, dashboard.pending.appointments, "No unpaid bookings.", "/admin/appointments?status=PENDING_PAYMENT")}
        {section("Cancelled", dashboard.cancelled.count, dashboard.cancelled.appointments, "No cancelled bookings.", "/admin/appointments?status=CANCELLED")}
      </div>
    </AdminShell>
  );
}
