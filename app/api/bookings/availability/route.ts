import { publicBookingApi } from "@/lib/http/public-booking-api";

export const runtime = "nodejs";

/** Informational, no-store public availability; booking creation rechecks every fact. */
export const GET = publicBookingApi.getAvailability;
