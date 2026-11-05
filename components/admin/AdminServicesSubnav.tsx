import Link from "next/link";

import { adminServicesPath, type AdminServicesView } from "@/lib/admin/service-list";

import styles from "./Admin.module.css";

const destinations: Array<{ view: AdminServicesView; label: string }> = [
  { view: "hairstyles", label: "Hairstyles" },
  { view: "categories", label: "Categories" },
  { view: "published", label: "Published" },
  { view: "drafts", label: "Drafts" },
];

export function AdminServicesSubnav({
  current,
  search,
  categoryId,
}: {
  current: AdminServicesView;
  search: string;
  categoryId: string;
}) {
  return (
    <nav className={styles.servicesSubnav} aria-label="Service management">
      {destinations.map(({ view, label }) => (
        <Link
          key={view}
          href={adminServicesPath({ view, search, categoryId })}
          aria-current={current === view ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
