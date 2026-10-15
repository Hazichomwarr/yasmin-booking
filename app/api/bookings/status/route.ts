import { publicBookingApi } from "@/lib/http/public-booking-api";

export const runtime = "nodejs";

/** Allow-listed status of the booking in the HttpOnly cookie. Read-only. */
export const GET = publicBookingApi.getStatus;
