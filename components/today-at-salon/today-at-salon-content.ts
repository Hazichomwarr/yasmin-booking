export type TodayAtSalonContent = {
  title: string;
  description: string;
  videoSrc: string;
  videoAvailable: boolean;
  posterSrc: string;
  ctaLabel: string;
  ctaHref: string;
  publicationLabel?: string;
};

export const TODAY_AT_SALON_BOOKING_CTA = {
  label: "Book an Appointment",
  href: "/book",
} as const;

/**
 * Weekly rotation is deliberately static: add the optimized MP4 under
 * public/media, update this one versioned path, and deploy. Older videos are
 * retained until an owner explicitly removes them.
 */
export const TODAY_AT_SALON_CONTENT: Readonly<TodayAtSalonContent> = {
  title: "Inside Yasmin's Beauty Salon",
  description: "A glimpse of the beauty, creativity, and care behind every appointment.",
  videoSrc: "/media/yasmin-salon-week-01.mp4",
  videoAvailable: true,
  posterSrc: "/media/yasmin-salon-week-01.jpg",
  ctaLabel: "Explore Our Services",
  ctaHref: "/styles",
  publicationLabel: "Today at the salon",
};
