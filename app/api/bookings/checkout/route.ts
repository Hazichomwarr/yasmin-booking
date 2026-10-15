import { publicBookingApi } from "@/lib/http/public-booking-api";

export const runtime = "nodejs";

/** Starts or resumes Stripe Checkout for the booking in the HttpOnly cookie. */
export const POST = publicBookingApi.startCheckout;
