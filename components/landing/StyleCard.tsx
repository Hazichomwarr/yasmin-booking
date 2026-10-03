import Image from "next/image";import type {StyleCardData} from "@/lib/landing-data";import styles from "./StyleCard.module.css";
const crops={braids:"", "sew-in":styles.sewIn, "silk-press":styles.silkPress, locs:styles.locs};
export function StyleCard({name,imagePosition,cropClass}:StyleCardData){return <article className={`${styles.card} ${crops[cropClass]}`}><Image src="/images/salon-hero-placeholder.png" alt={`${name} placeholder salon style`} fill sizes="(max-width: 600px) 48vw, 25vw" style={{objectPosition:imagePosition}}/><div className={styles.shade}/><h3>{name}</h3></article>}
