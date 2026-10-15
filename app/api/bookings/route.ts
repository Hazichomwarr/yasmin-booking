import { publicBookingApi } from "@/lib/http/public-booking-api";

export const runtime = "nodejs";

/** Anonymous booking creation. Off unless PUBLIC_BOOKING_ENABLED=true. */
export const POST = publicBookingApi.createBooking;
