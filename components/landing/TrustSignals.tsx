import { HeartIcon } from "@/components/ui/icons/HeartIcon";
import { SparkleIcon } from "@/components/ui/icons/SparkleIcon";
import styles from "./TrustSignals.module.css";

export function TrustSignals() {
  return (
    <div className={styles.signals} aria-label="Salon benefits">
      <div><SparkleIcon /><span>Professional<br />Stylists</span></div>
      <div><HeartIcon /><span>Beautiful<br />Results</span></div>
    </div>
  );
}
