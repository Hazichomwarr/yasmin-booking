import Link from "next/link";
import styles from "./page.module.css";
export default function BookingPlaceholder(){return <main className={styles.main}><p className={styles.eyebrow}>YASMIN’S BEAUTY SALON</p><h1 className={styles.title}>Online booking<br/>coming soon.</h1><Link className={styles.link} href="/">Return home</Link></main>}
