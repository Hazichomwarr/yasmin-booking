import { publicBookingApi } from "@/lib/http/public-booking-api";

export const runtime = "nodejs";

/** Releases only a safely unpaid cookie-authorized booking. */
export const POST = publicBookingApi.releaseBooking;
