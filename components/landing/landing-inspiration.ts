export type LandingInspirationImage = {
  src: `/images/landing/${string}`;
  alt: string;
};

/** Owner-supplied, locally stored salon photography. */
export const LANDING_INSPIRATION_IMAGES: readonly LandingInspirationImage[] = [
  {
    src: "/images/landing/highlighted-long-braids-salon-exterior.jpg",
    alt: "Long highlighted braids photographed from behind outside Yasmin's Beauty Salon",
  },
  {
    src: "/images/landing/cornrow-updo-detail.jpg",
    alt: "Detailed cornrow pattern gathered into a braided updo",
  },
  {
    src: "/images/landing/highlighted-curly-braids-salon-interior.jpg",
    alt: "Long highlighted curly braids photographed from the side inside the salon",
  },
  {
    src: "/images/landing/stylist-long-dark-braids-salon-sign.jpg",
    alt: "Stylist working on long dark braids in front of the Yasmin's Beauty Salon sign",
  },
  {
    src: "/images/landing/blonde-curly-braids-closeup.jpg",
    alt: "Close-up back view of long blonde curly braids",
  },
  {
    src: "/images/landing/long-dark-curly-braids-salon-sign.jpg",
    alt: "Long dark curly braids photographed from behind in front of the Yasmin's Beauty Salon sign",
  },
];

export type TrendingStylesSource<T> =
  | { kind: "features"; items: readonly T[] }
  | { kind: "inspiration"; items: readonly LandingInspirationImage[] };

/** Dynamic curation always wins; the two sources are never mixed. */
export function resolveTrendingStylesSource<T>(
  features: readonly T[],
  inspirationImages: readonly LandingInspirationImage[],
): TrendingStylesSource<T> {
  return features.length > 0
    ? { kind: "features", items: features }
    : { kind: "inspiration", items: inspirationImages.slice(0, 6) };
}
