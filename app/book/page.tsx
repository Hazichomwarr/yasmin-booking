import { connection } from "next/server";

import { BookingExperience } from "@/components/booking/BookingExperience";
import { BookingUnavailable } from "@/components/booking/BookingUnavailable";
import { listPublicBookableHairstyles } from "@/lib/catalog";
import { CURRENT_MARKETING_CONSENT_WORDING } from "@/lib/customers/marketing-consent";
import { isPublicBookingEnabled } from "@/lib/http/config";
import { isApprovedBlobDeliveryUrl } from "@/lib/media/blob-public-origin";

export default async function BookPage() {
  // Request time only: the flag and the catalog are never baked in at build.
  await connection();
  if (!isPublicBookingEnabled(process.env)) return <BookingUnavailable />;
  const hairstyles = (await listPublicBookableHairstyles({
    isDeliveryUrlAllowed: (deliveryUrl) => isApprovedBlobDeliveryUrl(deliveryUrl, process.env.BLOB_PUBLIC_BASE_URL),
  })).map(({ id, name, description, category, requiresVariant, priceCents, variants, coverImage, gallery }) => ({
    id,
    name,
    description,
    category,
    requiresVariant,
    priceCents,
    variants,
    coverImage,
    gallery,
  }));
  return (
    <BookingExperience
      hairstyles={hairstyles}
      consentWording={{ email: CURRENT_MARKETING_CONSENT_WORDING.EMAIL.text, sms: CURRENT_MARKETING_CONSENT_WORDING.SMS.text }}
    />
  );
}
