/** Browser-side display helpers for salon-local dates ("YYYY-MM-DD") and times ("HH:mm"). */

export const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** A calendar date, never shifted by the browser's timezone. */
export const dateLabel = (value: string, style: "short" | "long" = "short") => new Intl.DateTimeFormat("en-US", style === "short"
  ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }
  : { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

/** "05:00" → "5:00 AM": a salon wall-clock time, formatted without any timezone conversion. */
export const timeLabel = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
};

/** The generic zone name ("ET") for a location's IANA timezone. */
export const zoneLabel = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? timeZone;

/** The stable error code and fixed message of a public API error response. */
export async function apiError(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  return { code: body?.error?.code ?? "UNKNOWN", message: body?.error?.message ?? "Something went wrong. Please try again." };
}

export const postJson = (url: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
