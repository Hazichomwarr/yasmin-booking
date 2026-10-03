import Link from "next/link";import {CalendarIcon} from "@/components/ui/icons/CalendarIcon";import styles from "./BookingCTA.module.css";
export function BookingCTA(){return <Link className={styles.cta} href="/book"><CalendarIcon/><span>Book Now</span><b>→</b></Link>}
