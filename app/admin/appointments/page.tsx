import Link from "next/link";

import { AdminAppointmentList } from "@/components/admin/AdminAppointmentCard";
import { AdminShell } from "@/components/admin/AdminShell";
import { STATUS_LABELS } from "@/components/admin/admin-format";
import styles from "@/components/admin/Admin.module.css";
import { APPOINTMENT_STATUSES, listAdminAppointments, parseAdminAppointmentFilters, type AdminAppointmentFilters } from "@/lib/admin/appointments";
import { requireAdmin } from "@/lib/admin/dal";

function href(filters: AdminAppointmentFilters, page: number) {
  const params = new URLSearchParams();
  if (filters.date) params.set("date", filters.date);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.range) params.set("range", filters.range);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/appointments${query ? `?${query}` : ""}`;
}

export default async function AdminAppointmentsPage({ searchParams }: PageProps<"/admin/appointments">) {
  const access = await requireAdmin();
  const filters = parseAdminAppointmentFilters(await searchParams);
  const result = await listAdminAppointments(access, filters);
  const filtered = Boolean(filters.date || filters.status || filters.q || filters.range);

  return (
    <AdminShell current="appointments" email={access.email}>
      <h1 className={styles.title}>Appointments</h1>
      {filters.range === "upcoming" && <p className={styles.filterDescription}>Showing capacity-consuming appointments from tomorrow onward.</p>}
      <section className={styles.panel} aria-label="Filters">
        <form className={styles.filters} method="get" action="/admin/appointments">
          {filters.range && <input type="hidden" name="range" value={filters.range} />}
          <label>Date<input type="date" name="date" defaultValue={filters.date ?? ""} /></label>
          <label>Status
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">All statuses</option>
              {APPOINTMENT_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
            </select>
          </label>
          <label>Customer name<input type="search" name="q" defaultValue={filters.q ?? ""} maxLength={100} placeholder="Search by name" /></label>
          <div className={styles.filterActions}>
            <button className={styles.primary} type="submit">Apply</button>
            {filtered && <Link href="/admin/appointments">Clear</Link>}
          </div>
        </form>
      </section>
      <section className={styles.panel} aria-label="Results">
        <p className={styles.muted} role="status">{result.total === 1 ? "1 appointment" : `${result.total} appointments`}{filtered ? (result.total === 1 ? " matches these filters" : " match these filters") : ""}</p>
        <AdminAppointmentList appointments={result.appointments} empty={filtered ? "No appointments match these filters." : "No appointments yet."} />
        {result.pageCount > 1 && (
          <nav className={styles.pager} aria-label="Pagination">
            {filters.page > 1 ? <Link href={href(filters, filters.page - 1)} rel="prev">← Previous</Link> : <span />}
            <span className={styles.muted}>Page {Math.min(filters.page, result.pageCount)} of {result.pageCount}</span>
            {filters.page < result.pageCount ? <Link href={href(filters, filters.page + 1)} rel="next">Next →</Link> : <span />}
          </nav>
        )}
      </section>
    </AdminShell>
  );
}
