import type { AppointmentEventType, AppointmentStatus, Prisma } from "@prisma/client";

import { capacityConsumingAppointments } from "@/lib/booking/capacity";
import { formatSalonAddress, salonAddressSelect } from "@/lib/booking/location-address";
import { addSalonDays, parseSalonDate, salonDateFromDatabase, salonDateToDatabase, salonToday, type SalonDate } from "@/lib/booking/salon-calendar";
import { prisma } from "@/lib/prisma";

import { assertAdminAccess, type AdminAccess } from "./auth";
import { adminPaymentView, type AdminPaymentView, type DepositFacts } from "./deposit-state";

/**
 * Read-only admin appointment views (YASMIN-2A).
 *
 * - Every function requires an AdminAccess grant (checked first).
 * - Reads only: no lifecycle, capacity or payment change.
 * - Shows booking-time snapshots (location name, slot time, hairstyle,
 *   prices) — what the customer booked — never re-derived from current
 *   configuration; the location's current address is shown alongside.
 * - Selects only display fields: no Stripe identifiers, access-token hashes,
 *   event detail payloads or internal reconciliation notes.
 */

/** The salon's calendar for "today"/"upcoming" (the business requirement's zone). */
export const ADMIN_TIME_ZONE = "America/New_York";
export const ADMIN_PAGE_SIZE = 20;
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ["PENDING_PAYMENT", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"];

export type AdminAppointmentSummary = {
  id: string;
  status: AppointmentStatus;
  customerName: string;
  appointmentDate: SalonDate;
  slotTime: string;
  locationName: string;
  hairstyleName: string | null;
  totalPriceCents: number;
  payment: AdminPaymentView;
};

const listSelect = {
  id: true,
  status: true,
  appointmentDate: true,
  slotTimeSnapshot: true,
  locationNameSnapshot: true,
  hairstyleNameSnapshot: true,
  holdExpiresAt: true,
  totalPriceCents: true,
  depositAmountCents: true,
  balanceDueCents: true,
  customer: { select: { name: true } },
  payments: {
    where: { purpose: "BOOKING_DEPOSIT" },
    select: { status: true, providerCheckoutSessionId: true, paidAt: true, allocatedAt: true, refundedAmountCents: true, reconciliationReason: true },
  },
} satisfies Prisma.AppointmentSelect;

type ListRow = Prisma.AppointmentGetPayload<{ select: typeof listSelect }>;

async function databaseNow(): Promise<Date> {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}

function depositFacts(row: Pick<ListRow, "payments">): DepositFacts {
  const payment = row.payments[0];
  // The Session id itself never leaves this function: only whether one exists.
  return payment ? {
    status: payment.status,
    hasCheckoutSession: payment.providerCheckoutSessionId !== null,
    paidAt: payment.paidAt,
    allocatedAt: payment.allocatedAt,
    refundedAmountCents: payment.refundedAmountCents,
    reconciliationReason: payment.reconciliationReason,
  } : null;
}

async function unresolvedExceptionIds(appointmentIds: string[]): Promise<Set<string>> {
  if (appointmentIds.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT "expectedAppointmentId" AS id FROM "PaymentProcessingException"
    WHERE "expectedAppointmentId" = ANY(${appointmentIds})
      AND ("resolvedAt" IS NULL OR "lastObservedAt" > "resolvedAt")
  `;
  return new Set(rows.map((row) => row.id));
}

async function summarize(rows: ListRow[], now: Date): Promise<AdminAppointmentSummary[]> {
  const flagged = await unresolvedExceptionIds(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    customerName: row.customer.name,
    appointmentDate: salonDateFromDatabase(row.appointmentDate),
    slotTime: row.slotTimeSnapshot,
    locationName: row.locationNameSnapshot,
    hairstyleName: row.hairstyleNameSnapshot,
    totalPriceCents: row.totalPriceCents,
    payment: adminPaymentView(row, depositFacts(row), flagged.has(row.id), now),
  }));
}

const chronological = [{ appointmentDate: "asc" }, { slotTimeSnapshot: "asc" }, { createdAt: "asc" }] satisfies Prisma.AppointmentOrderByWithRelationInput[];

export type AdminDashboard = {
  today: SalonDate;
  countsByStatus: Record<AppointmentStatus, number>;
  todayAppointments: { count: number; appointments: AdminAppointmentSummary[] };
  upcoming: { count: number; appointments: AdminAppointmentSummary[] };
  confirmedUpcoming: { count: number; appointments: AdminAppointmentSummary[] };
  pending: { count: number; appointments: AdminAppointmentSummary[] };
  cancelled: { count: number; appointments: AdminAppointmentSummary[] };
};

/** Dashboard previews intentionally stay brief; full records belong in the workspace. */
const SECTION_LIMIT = 3;

/**
 * Dashboard sections, all in terms of existing statuses and rules:
 * - today: every appointment on the salon's date today (any status);
 * - upcoming: after today and occupying a place by THE capacity rule
 *   (confirmed/completed/no-show, or an unpaid hold that is still active);
 * - confirmed: status CONFIRMED, today or later;
 * - pending: status PENDING_PAYMENT (any hold state), most recent first;
 * - cancelled: status CANCELLED, most recently changed first.
 */
export async function getAdminDashboard(access: AdminAccess): Promise<AdminDashboard> {
  assertAdminAccess(access);
  const now = await databaseNow();
  const today = salonToday(ADMIN_TIME_ZONE, now);
  const todayDb = salonDateToDatabase(today);
  const tomorrowDb = salonDateToDatabase(addSalonDays(today, 1));

  const upcomingWhere = { appointmentDate: { gte: tomorrowDb }, ...capacityConsumingAppointments(now) } satisfies Prisma.AppointmentWhereInput;
  const confirmedWhere = { status: "CONFIRMED", appointmentDate: { gte: todayDb } } satisfies Prisma.AppointmentWhereInput;
  const pendingWhere = { status: "PENDING_PAYMENT" } satisfies Prisma.AppointmentWhereInput;
  const cancelledWhere = { status: "CANCELLED" } satisfies Prisma.AppointmentWhereInput;

  const [grouped, todayCount, todayRows, upcomingCount, upcomingRows, confirmedCount, confirmedRows, pendingCount, pendingRows, cancelledCount, cancelledRows] = await Promise.all([
    prisma.appointment.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.appointment.count({ where: { appointmentDate: todayDb } }),
    prisma.appointment.findMany({ where: { appointmentDate: todayDb }, select: listSelect, orderBy: chronological, take: SECTION_LIMIT }),
    prisma.appointment.count({ where: upcomingWhere }),
    prisma.appointment.findMany({ where: upcomingWhere, select: listSelect, orderBy: chronological, take: SECTION_LIMIT }),
    prisma.appointment.count({ where: confirmedWhere }),
    prisma.appointment.findMany({ where: confirmedWhere, select: listSelect, orderBy: chronological, take: SECTION_LIMIT }),
    prisma.appointment.count({ where: pendingWhere }),
    prisma.appointment.findMany({ where: pendingWhere, select: listSelect, orderBy: [{ createdAt: "desc" }], take: SECTION_LIMIT }),
    prisma.appointment.count({ where: cancelledWhere }),
    prisma.appointment.findMany({ where: cancelledWhere, select: listSelect, orderBy: [{ updatedAt: "desc" }], take: SECTION_LIMIT }),
  ]);

  const countsByStatus = Object.fromEntries(APPOINTMENT_STATUSES.map((status) => [status, 0])) as Record<AppointmentStatus, number>;
  for (const row of grouped) countsByStatus[row.status] = row._count._all;

  return {
    today,
    countsByStatus,
    todayAppointments: { count: todayCount, appointments: await summarize(todayRows, now) },
    upcoming: { count: upcomingCount, appointments: await summarize(upcomingRows, now) },
    confirmedUpcoming: { count: confirmedCount, appointments: await summarize(confirmedRows, now) },
    pending: { count: pendingCount, appointments: await summarize(pendingRows, now) },
    cancelled: { count: cancelledCount, appointments: await summarize(cancelledRows, now) },
  };
}

export type AdminAppointmentFilters = {
  date: SalonDate | null;
  status: AppointmentStatus | null;
  q: string | null;
  range: "upcoming" | null;
  page: number;
};

/** Parses untrusted search params; anything invalid is ignored, never trusted. */
export function parseAdminAppointmentFilters(params: Record<string, string | string[] | undefined>): AdminAppointmentFilters {
  const one = (key: string) => (typeof params[key] === "string" ? (params[key] as string).trim() : "");
  let date: SalonDate | null = null;
  try {
    date = one("date") ? parseSalonDate(one("date")) : null;
  } catch {
    date = null;
  }
  const statusValue = one("status");
  const status = (APPOINTMENT_STATUSES as readonly string[]).includes(statusValue) ? (statusValue as AppointmentStatus) : null;
  const q = one("q").slice(0, 100) || null;
  const range = one("range") === "upcoming" ? "upcoming" : null;
  const pageText = one("page");
  const pageNumber = /^\d{1,5}$/.test(pageText) ? Number(pageText) : 1;
  const page = pageNumber >= 1 && pageNumber <= 10_000 ? pageNumber : 1;
  return { date, status, q, range, page };
}

export type AdminAppointmentPage = { filters: AdminAppointmentFilters; appointments: AdminAppointmentSummary[]; total: number; pageCount: number };

/** Filtered, paginated list: date, status, and case-insensitive customer-name search. */
export async function listAdminAppointments(access: AdminAccess, filters: AdminAppointmentFilters): Promise<AdminAppointmentPage> {
  assertAdminAccess(access);
  const now = await databaseNow();
  const today = salonToday(ADMIN_TIME_ZONE, now);
  const tomorrowDb = salonDateToDatabase(addSalonDays(today, 1));
  const where: Prisma.AppointmentWhereInput = {
    ...(filters.date ? { appointmentDate: salonDateToDatabase(filters.date) } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.q ? { customer: { name: { contains: filters.q, mode: "insensitive" } } } : {}),
    ...(filters.range === "upcoming" ? { appointmentDate: { gte: tomorrowDb }, ...capacityConsumingAppointments(now) } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      select: listSelect,
      // Latest appointment dates first; within a day, by time.
      orderBy: [{ appointmentDate: "desc" }, { slotTimeSnapshot: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip: (filters.page - 1) * ADMIN_PAGE_SIZE,
      take: ADMIN_PAGE_SIZE,
    }),
  ]);
  return { filters, appointments: await summarize(rows, now), total, pageCount: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)) };
}

export type AdminAppointmentDetail = AdminAppointmentSummary & {
  customer: { name: string; email: string; phone: string };
  location: { name: string; address: string | null; timeZone: string };
  preferredStylistName: string | null;
  customerNotes: string | null;
  depositAmountCents: number;
  balanceDueCents: number;
  holdExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Audit trail: event types and times only (details may hold internal identifiers). */
  history: Array<{ type: AppointmentEventType; at: Date }>;
};

export async function getAdminAppointmentDetail(access: AdminAccess, appointmentId: string): Promise<AdminAppointmentDetail | null> {
  assertAdminAccess(access);
  if (typeof appointmentId !== "string" || appointmentId.length === 0 || appointmentId.length > 64) return null;
  const row = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      ...listSelect,
      preferredStylistName: true,
      customerNotes: true,
      createdAt: true,
      updatedAt: true,
      customer: { select: { name: true, email: true, phone: true } },
      location: { select: { name: true, timeZone: true, ...salonAddressSelect } },
      events: { select: { type: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!row) return null;
  const now = await databaseNow();
  const [summary] = await summarize([row], now);
  return {
    ...summary,
    customer: row.customer,
    location: { name: row.locationNameSnapshot, address: formatSalonAddress(row.location), timeZone: row.location.timeZone },
    preferredStylistName: row.preferredStylistName,
    customerNotes: row.customerNotes,
    depositAmountCents: row.depositAmountCents,
    balanceDueCents: row.balanceDueCents,
    holdExpiresAt: row.holdExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    history: row.events.map((event) => ({ type: event.type, at: event.createdAt })),
  };
}
