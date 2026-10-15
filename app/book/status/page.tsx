import { connection } from "next/server";

import { BookingStatus } from "@/components/booking/BookingStatus";
import { BookingUnavailable } from "@/components/booking/BookingUnavailable";
import { isPublicBookingEnabled } from "@/lib/http/config";

export default async function BookingStatusPage({ searchParams }: PageProps<"/book/status">) {
  await connection();
  if (!isPublicBookingEnabled(process.env)) return <BookingUnavailable />;
  // Wording hint only (Stripe's success/cancel URL). Never proof of payment.
  const { return: returned } = await searchParams;
  return <BookingStatus returnedFrom={returned === "success" ? "success" : returned === "cancel" ? "cancel" : null} />;
}
