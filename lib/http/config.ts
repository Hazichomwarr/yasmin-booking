/**
 * Public booking API configuration (YASMIN-1F.4), validated per request from
 * the environment so a misconfiguration fails closed instead of at build.
 *
 * Strict mode (NODE_ENV=production — every Vercel deployment, preview
 * included) additionally requires:
 * - APP_BASE_URL over https;
 * - TRUSTED_CLIENT_IP_SOURCE=vercel on Vercel (VERCEL=1);
 * - no additional trusted origins on the production deployment;
 * - a Stripe test key on anything but VERCEL_ENV=production.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export type ClientIpSource =
  /** Trust only Vercel's `x-vercel-forwarded-for` (Vercel overwrites client-supplied forwarding headers). */
  | "vercel"
  /** Local development/tests: no trustworthy client IP; every request shares one bucket. */
  | "none";

export type RateLimitRule = { scope: string; limit: number; windowMs: number };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Defaults; each `limit` can be overridden via PUBLIC_BOOKING_RATE_LIMITS. Scopes are unique per rule. */
export const DEFAULT_RATE_LIMITS = {
  bookingIp10m: { scope: "booking.ip.10m", limit: 5, windowMs: 10 * MINUTE },
  bookingIpDay: { scope: "booking.ip.1d", limit: 20, windowMs: DAY },
  bookingEmailDay: { scope: "booking.email.1d", limit: 3, windowMs: DAY },
  bookingPhoneDay: { scope: "booking.phone.1d", limit: 3, windowMs: DAY },
  checkoutCredential10m: { scope: "checkout.credential.10m", limit: 10, windowMs: 10 * MINUTE },
  checkoutIp10m: { scope: "checkout.ip.10m", limit: 30, windowMs: 10 * MINUTE },
  statusCredential1m: { scope: "status.credential.1m", limit: 60, windowMs: MINUTE },
  statusIp1m: { scope: "status.ip.1m", limit: 120, windowMs: MINUTE },
  availabilityIp1m: { scope: "availability.ip.1m", limit: 60, windowMs: MINUTE },
  releaseCredential10m: { scope: "release.credential.10m", limit: 10, windowMs: 10 * MINUTE },
  releaseIp10m: { scope: "release.ip.10m", limit: 30, windowMs: 10 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof DEFAULT_RATE_LIMITS;

export type PublicBookingConfig = {
  /** The single authoritative application origin, from APP_BASE_URL. */
  appOrigin: string;
  /** Every origin accepted on mutations: appOrigin plus explicitly configured preview origins. */
  allowedOrigins: ReadonlySet<string>;
  rateLimitSecret: string;
  clientIpSource: ClientIpSource;
  rateLimits: Readonly<Record<RateLimitName, RateLimitRule>>;
};

export type ConfigResult = { ok: true; config: PublicBookingConfig } | { ok: false; problems: string[] };

/** Exactly "true" enables the public endpoints; anything else (including unset) keeps them off. */
export function isPublicBookingEnabled(env: Env): boolean {
  return env.PUBLIC_BOOKING_ENABLED === "true";
}

const MIN_SECRET_LENGTH = 32;

export function loadPublicBookingConfig(env: Env): ConfigResult {
  const problems: string[] = [];
  const strict = env.NODE_ENV === "production";
  const vercelProduction = env.VERCEL_ENV === "production";

  const appOrigin = exactOrigin(env.APP_BASE_URL, { allowPath: true });
  if (!appOrigin) problems.push("APP_BASE_URL must be an absolute http(s) URL without credentials, query or fragment.");
  else if (strict && !appOrigin.startsWith("https://")) problems.push("APP_BASE_URL must use https in production.");
  else if (!strict && appOrigin.startsWith("http://") && !isLocalOrigin(appOrigin)) {
    problems.push("APP_BASE_URL may use http only for localhost.");
  }

  const allowedOrigins = new Set<string>(appOrigin ? [appOrigin] : []);
  const additional = (env.PUBLIC_BOOKING_ADDITIONAL_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (additional.length > 0 && vercelProduction) {
    problems.push("PUBLIC_BOOKING_ADDITIONAL_ORIGINS is not allowed on the production deployment.");
  }
  for (const value of additional) {
    const origin = exactOrigin(value, { allowPath: false });
    if (!origin || value.includes("*")) problems.push("PUBLIC_BOOKING_ADDITIONAL_ORIGINS entries must be exact origins (no wildcard or path).");
    else if (!origin.startsWith("https://") && !(isLocalOrigin(origin) && !strict)) {
      problems.push("PUBLIC_BOOKING_ADDITIONAL_ORIGINS entries must use https.");
    } else allowedOrigins.add(origin);
  }

  const rateLimitSecret = env.RATE_LIMIT_SECRET ?? "";
  if (rateLimitSecret.length < MIN_SECRET_LENGTH) problems.push(`RATE_LIMIT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);

  const clientIpSource = env.TRUSTED_CLIENT_IP_SOURCE;
  if (clientIpSource !== "vercel" && clientIpSource !== "none") {
    problems.push('TRUSTED_CLIENT_IP_SOURCE must be "vercel" or "none".');
  } else if (strict && clientIpSource !== "vercel") {
    problems.push('TRUSTED_CLIENT_IP_SOURCE must be "vercel" in production.');
  } else if (clientIpSource === "vercel" && env.VERCEL !== "1") {
    problems.push('TRUSTED_CLIENT_IP_SOURCE="vercel" requires running on Vercel (VERCEL=1).');
  }

  const stripeKey = env.STRIPE_SECRET_KEY ?? "";
  if (strict) {
    if (!/^sk_(test|live)_\S+$/.test(stripeKey)) problems.push("STRIPE_SECRET_KEY must be a Stripe secret key.");
    else if (stripeKey.startsWith("sk_live_") && !vercelProduction) problems.push("A live Stripe key is only allowed on the production deployment.");
  }

  const rateLimits = rateLimitsFrom(env.PUBLIC_BOOKING_RATE_LIMITS, problems);

  if (problems.length > 0 || !appOrigin || !rateLimits) return { ok: false, problems };
  return {
    ok: true,
    config: { appOrigin, allowedOrigins, rateLimitSecret, clientIpSource: clientIpSource as ClientIpSource, rateLimits },
  };
}

/** `{"bookingIp10m": 10, …}` overrides limits only; windows and scopes are fixed. */
function rateLimitsFrom(raw: string | undefined, problems: string[]): Record<RateLimitName, RateLimitRule> | null {
  const rules: Record<RateLimitName, RateLimitRule> = { ...DEFAULT_RATE_LIMITS };
  if (raw === undefined || raw.trim() === "") return rules;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push("PUBLIC_BOOKING_RATE_LIMITS must be a JSON object.");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("PUBLIC_BOOKING_RATE_LIMITS must be a JSON object.");
    return null;
  }
  for (const [name, limit] of Object.entries(parsed)) {
    if (!(name in DEFAULT_RATE_LIMITS) || !Number.isSafeInteger(limit) || (limit as number) < 1) {
      problems.push(`PUBLIC_BOOKING_RATE_LIMITS.${name} must name a known limit with a positive integer.`);
      return null;
    }
    rules[name as RateLimitName] = { ...rules[name as RateLimitName], limit: limit as number };
  }
  return rules;
}

/** The serialized origin of an absolute http(s) URL, or null. */
function exactOrigin(value: string | undefined, options: { allowPath: boolean }): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!options.allowPath && url.pathname !== "/") return null;
  if (!options.allowPath && value.replace(/\/$/, "") !== url.origin) return null;
  return url.origin;
}

function isLocalOrigin(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
