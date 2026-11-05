"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

import { PublicHairstyleCover } from "@/components/catalog/PublicHairstyleCover";
import {
  ADMIN_SERVICE_BATCH_SIZE,
  adminServicesPath,
  filterAdminServices,
  nextAdminServiceVisibleCount,
  visibleAdminServices,
  type AdminServiceListItem,
  type AdminServicesView,
} from "@/lib/admin/service-list";

import styles from "./Admin.module.css";

type Category = { id: string; name: string };

function dollars(cents: number | null) {
  return cents === null ? "Draft" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function updateLocation(filter: { search: string; categoryId: string; view: Exclude<AdminServicesView, "categories">; visibleCount?: number }) {
  window.history.replaceState(null, "", adminServicesPath(filter));
}

export function AdminServiceCatalog({
  categories,
  services,
  view = "hairstyles",
  initialCategoryId = "",
  initialSearch = "",
  initialVisibleCount = ADMIN_SERVICE_BATCH_SIZE,
}: {
  categories: Category[];
  services: AdminServiceListItem[];
  view?: Exclude<AdminServicesView, "categories">;
  initialCategoryId?: string;
  initialSearch?: string;
  initialVisibleCount?: number;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [draftCategoryId, setDraftCategoryId] = useState(initialCategoryId);
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);

  const matching = useMemo(
    () => filterAdminServices(services, { search, categoryId, view }),
    [categoryId, search, services, view],
  );
  const visible = visibleAdminServices(matching, visibleCount);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCategoryId(draftCategoryId);
    setVisibleCount(ADMIN_SERVICE_BATCH_SIZE);
    updateLocation({ search, categoryId: draftCategoryId, view });
  }

  function changeSearch(value: string) {
    setSearch(value);
    setVisibleCount(ADMIN_SERVICE_BATCH_SIZE);
    updateLocation({ search: value, categoryId, view });
  }

  function clearAll() {
    setSearch("");
    setCategoryId("");
    setDraftCategoryId("");
    setVisibleCount(ADMIN_SERVICE_BATCH_SIZE);
    updateLocation({ search: "", categoryId: "", view });
  }

  const returnTo = adminServicesPath({ search, categoryId, view, visibleCount });

  return <>
    <section className={styles.panel} aria-label="Service search and filters">
      <div className={styles.serviceSearch}>
        <label htmlFor="service-search">Search services</label>
        <div className={styles.serviceSearchInput}>
          <input
            id="service-search"
            type="search"
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
            placeholder="Search hairstyles..."
            autoComplete="off"
          />
          {search ? <button type="button" className={styles.secondary} onClick={() => changeSearch("")}>Clear search</button> : null}
        </div>
      </div>
      <form className={styles.filters} onSubmit={applyFilters}>
        <label>Category<select value={draftCategoryId} onChange={(event) => setDraftCategoryId(event.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <div className={styles.filterActions}><button className={styles.primary} type="submit">Apply</button><button className={styles.linkButton} type="button" onClick={clearAll}>Clear all</button></div>
      </form>
    </section>

    <p className={styles.catalogCount} role="status">Showing {visible.length} of {matching.length} services</p>
    {matching.length === 0 ? <section className={styles.panel}><p className={styles.empty}>No services match your search and filters. Clear or adjust the search above to continue.</p></section> :
      <section className={styles.catalogList} aria-label="Services">
        {visible.map((service) => <article className={styles.catalogRow} key={service.id}>
          <div className={styles.catalogThumb}>
            <PublicHairstyleCover image={service.coverImage} hairstyleName={service.name} sizes="64px" className={styles.catalogThumbImage} fallbackClassName={styles.catalogThumbFallback} />
          </div>
          <div className={styles.catalogIdentity}><h2>{service.name}</h2><p>{service.category.name}</p></div>
          <p className={styles.catalogPrice}>{service.requiresVariant ? "Prices by variant" : service.priceCents === null ? "Price not set" : dollars(service.priceCents)}</p>
          <div className={styles.catalogActions}>
            <span className={styles.badge} data-catalog-state={!service.isActive ? "draft" : service.category.isActive ? "published" : "hidden"}>{!service.isActive ? "Draft" : service.category.isActive ? "Published" : "Hidden — category inactive"}</span>
            <Link className={styles.secondary} href={`/admin/services/${service.id}/edit?returnTo=${encodeURIComponent(returnTo)}`}>Edit</Link>
          </div>
        </article>)}
        {visible.length < matching.length ? <button className={`${styles.secondary} ${styles.showMore}`} type="button" onClick={() => {
          const next = nextAdminServiceVisibleCount(visibleCount, matching.length);
          setVisibleCount(next);
          updateLocation({ search, categoryId, view, visibleCount: next });
        }}>Show 10 more</button> : null}
      </section>}
  </>;
}
