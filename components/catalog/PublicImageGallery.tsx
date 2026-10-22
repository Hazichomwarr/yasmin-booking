"use client";

import Image from "next/image";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { PublicHairstyleCover, publicImageAlt, type PublicHairstyleCoverImage } from "./PublicHairstyleCover";

export type PublicGalleryImage = PublicHairstyleCoverImage & { id: string };

type Props = {
  images: PublicGalleryImage[];
  /** Used for fallback alt text and the thumbnail group's accessible name. */
  hairstyleName: string;
  mainSizes: string;
  thumbSizes: string;
  classNames: {
    root: string;
    main: string;
    image: string;
    fallback: string;
    thumbs: string;
    thumb: string;
    thumbActive: string;
  };
};

/**
 * Main photo plus selectable thumbnails. The main frame is sized by CSS, so
 * swapping images never moves the layout. Catalog reads stay on the server;
 * this only receives already-validated public media.
 */
export function PublicImageGallery({ images, hairstyleName, mainSizes, thumbSizes, classNames }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mainId = useId();
  const selected = images[Math.min(selectedIndex, images.length - 1)] ?? null;

  function select(index: number, focus = false) {
    setSelectedIndex(index);
    if (focus) thumbRefs.current[index]?.focus();
  }

  function onThumbKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = images.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  }

  return (
    <div className={classNames.root}>
      <div className={classNames.main} id={mainId}>
        <PublicHairstyleCover
          image={selected}
          hairstyleName={hairstyleName}
          sizes={mainSizes}
          className={classNames.image}
          fallbackClassName={classNames.fallback}
        />
      </div>
      {images.length > 1 && (
        <div className={classNames.thumbs} role="group" aria-label={`${hairstyleName} photos`}>
          {images.map((image, index) => {
            const active = image.id === selected?.id;
            return (
              <button
                key={image.id}
                ref={(node) => { thumbRefs.current[index] = node; }}
                type="button"
                className={`${classNames.thumb} ${active ? classNames.thumbActive : ""}`}
                aria-label={`Show photo ${index + 1} of ${images.length}: ${publicImageAlt(image, hairstyleName)}`}
                aria-pressed={active}
                aria-controls={mainId}
                onClick={() => select(index)}
                onKeyDown={(event) => onThumbKeyDown(event, index)}
              >
                <Image src={image.deliveryUrl} alt="" fill sizes={thumbSizes} className={classNames.image} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
