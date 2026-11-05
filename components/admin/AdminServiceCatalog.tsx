"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

import {
  ADMIN_SERVICE_BATCH_SIZE,
  filterAdminServices,
  nextAdminServiceVisibleCount,
  visibleAdminServices,
  type AdminServiceListItem,
  type AdminServiceListState,
} from "@/lib/admin/service-list";

import styles from "./Admin.module.css";

type Category = { id: string; name: string };

function dollars(cents: number | null) {
  return cents === null ? "Draft" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function servicesPath(filter: { search: string; categoryId: string; state: AdminServiceListState }) {
  const params = new URLSearchParams();
  if (filter.categoryId) params.set("category", filter.categoryId);
  if (filter.state) params.set("state", filter.state);
  if (filter.search.trim()) params.set("q", filter.search.trim());
  const query = params.toString();
  return `/admin/services${query ? `?${query}` : ""}`;
}

function updateLocation(filter: { search: string; categoryId: string; state: AdminServiceListState }) {
  window.history.replaceState(null, "", servicesPath(filter));
}

export function AdminServiceCatalog({
  categories,
  services,
  initialCategoryId = "",
  initialState = "",
  initialSearch = "",
}: {
  categories: Category[];
  services: AdminServiceListItem[];
  initialCategoryId?: string;
  initialState?: AdminServiceListState;
  initialSearch?: string;
}) {
  const [search, setSearch] = useState(initialSearch);
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [state, setState] = useState<AdminServiceListState>(initialState);
  const [draftCategoryId, setDraftCategoryId] = useState(initialCategoryId);
  const [draftState, setDraftState] = useState<AdminServiceListState>(initialState);
  const [visibleCount, setVisibleCount] = useState(ADMIN_SERVICE_BATCH_SIZE);

  const matching = useMemo(
    () => filterAdminServices(services, { search, categoryId, state }),
    [categoryId, search, services, state],
  );
  const visible = visibleAdminServices(matching, visibleCount);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCategoryId(draftCategoryId);
    setState(draftState);
    setVisibleCount(ADMIN_SERVICE_BATCH_SIZE);
    updateLocation({ search, categoryId: draftCategoryId, state: draftState });
  }

  function changeSearch(value: string) {
    setSearch(value);
    setVisibleCount(ADMIN_SERVICE_BATCH_SIZE);
    updateLocation({ search: value, categoryId, state });
  }

  function clearAll() {
    setSearch("");
    setCategoryId("");
    setState("");
    setDraftCategoryId("");
    setDraftState("");
    setVisibleCount(ADMIN_SERVICE_BATCH_SIZE);
    updateLocation({ search: "", categoryId: "", state: "" });
  }

  const returnTo = servicesPath({ search, categoryId, state });

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
            placeholder="Search by hairstyle name"
            autoComplete="off"
          />
          {search ? <button type="button" className={styles.secondary} onClick={() => changeSearch("")}>Clear search</button> : null}
        </div>
      </div>
      <form className={styles.filters} onSubmit={applyFilters}>
        <label>Category<select value={draftCategoryId} onChange={(event) => setDraftCategoryId(event.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label>Status<select value={draftState} onChange={(event) => setDraftState(event.target.value as AdminServiceListState)}><option value="">All states</option><option value="active">Active</option><option value="draft">Draft</option><option value="inactive">Inactive</option></select></label>
        <div className={styles.filterActions}><button className={styles.primary} type="submit">Apply</button><button className={styles.linkButton} type="button" onClick={clearAll}>Clear all</button></div>
      </form>
    </section>

    <p className={styles.catalogCount} role="status">Showing {visible.length} of {matching.length} services</p>
    {matching.length === 0 ? <section className={styles.panel}><p className={styles.empty}>No services match your search and filters.</p>{search ? <button type="button" className={styles.secondary} onClick={() => changeSearch("")}>Clear search</button> : null}</section> :
      <section className={styles.catalogList} aria-label="Services">
        {visible.map((service) => <article className={styles.catalogCard} key={service.id}>
          <div><p className={styles.catalogCategory}>{service.category.name}</p><h2>{service.name}</h2><p className={styles.muted}>{service.requiresVariant ? "Variant pricing" : dollars(service.priceCents)} · Order {service.sortOrder}</p></div>
          <div className={styles.catalogActions}><span className={styles.badge} data-catalog-state={!service.isActive ? "inactive" : service.priceCents === null && !service.requiresVariant ? "draft" : "active"}>{!service.isActive ? "Inactive" : service.priceCents === null && !service.requiresVariant ? "Draft" : "Active"}</span><Link className={styles.secondary} href={`/admin/services/${service.id}/edit?returnTo=${encodeURIComponent(returnTo)}`}>Edit</Link></div>
        </article>)}
        {visible.length < matching.length ? <button className={`${styles.secondary} ${styles.showMore}`} type="button" onClick={() => setVisibleCount((current) => nextAdminServiceVisibleCount(current, matching.length))}>Show 10 more</button> : null}
      </section>}
  </>;
}
