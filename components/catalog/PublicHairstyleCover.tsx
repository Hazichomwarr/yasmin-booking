"use client";

import Image from "next/image";

export type PublicHairstyleCoverImage = {
  deliveryUrl: string;
  altText: string | null;
};

type Props = {
  image: PublicHairstyleCoverImage | null;
  hairstyleName: string;
  sizes: string;
  className?: string;
  fallbackClassName?: string;
};

/** Public pages pass only pre-validated public delivery URLs to this component. */
export function PublicHairstyleCover({
  image,
  hairstyleName,
  sizes,
  className,
  fallbackClassName,
}: Props) {
  if (image) {
    return (
      <Image
        src={image.deliveryUrl}
        alt={image.altText?.trim() || `${hairstyleName} hairstyle`}
        fill
        sizes={sizes}
        className={className}
      />
    );
  }

  return (
    <div className={fallbackClassName} aria-hidden="true">
      <span>{hairstyleName.slice(0, 1)}</span>
    </div>
  );
}
