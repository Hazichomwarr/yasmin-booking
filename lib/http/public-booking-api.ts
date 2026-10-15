import { resolveBookingAccess } from "@/lib/booking/access";
import { getPublicAvailability } from "@/lib/booking/availability";
import { releaseAuthorizedPublicBooking, PublicBookingReleaseConflictError } from "@/lib/booking/public-release";
import { getAuthorizedBookingStatus, type PublicBookingStatus } from "@/lib/booking/booking-status";
import { startAuthorizedBookingCheckout, type CheckoutAmbiguityReason, type CheckoutStartResult } from "@/lib/booking/checkout";
import { isBookingAccessError, isBookingError } from "@/lib/booking/errors";
import {
  createPublicBooking,
  parsePublicBookingInput,
  PublicBookingReplacementConflictError,
  PublicBookingValidationError,
  type PublicBookingCreateOptions,
  type PublicBookingInput,
  type PublicBookingResult,
} from "@/lib/booking/public-booking";

import { bookingCookie, clearedBookingCookie, readBookingCookie } from "./booking-cookie";
import { clientIdentity } from "./client-ip";
import { isPublicBookingEnabled, loadPublicBookingConfig, type Env, type PublicBookingConfig, type RateLimitName } from "./config";
import { BOOKING_ERROR_TO_PUBLIC, publicError, publicJson, type PublicErrorCode } from "./public-responses";
import { consumeRateLimits, type RateLimitCheck, type RateLimitDecision } from "./rate-limit";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

/**
 * The public booking HTTP boundary (YASMIN-1F.4). Route files only bind
 * these handlers; every rule lives in the booking domain services.
 *
 * Pipeline for both POST routes, each step before any domain work:
 *   feature flag → configuration → Origin/Fetch-Metadata → Content-Type →
 *   streamed body limit → shared rate limits (IP first; no credential needed)
 *   → parsing → domain service → allow-listed response.
 *
 * Authorization comes only from the `__Host-yasmin_booking` cookie. No
 * appointment, payment or provider identifier is accepted from, or returned
 * to, the client. Logs carry codes and reasons only — never bodies, cookies,
 * tokens, contact details, provider ids or Checkout URLs.
 */

export const MAX_BOOKING_BODY_BYTES = 8 * 1024;
export const MAX_CHECKOUT_BODY_BYTES = 1024;
const CHECKOUT_RETRY_AFTER_SECONDS = 5;

export type PublicApiRoute = "bookings.create" | "bookings.checkout" | "bookings.status" | "bookings.availability" | "bookings.release";

/** Only enumerable, non-sensitive facts. */
export type PublicApiLogEntry = {
  route: PublicApiRoute;
  status: number;
  code?: PublicErrorCode;
  /** A reason enum (origin rejection, access denial, ambiguity reason, rate-limit scope, error class). */
  detail?: string;
  requestId?: string;
};

export type PublicBookingApiDeps = {
  env: () => Env;
  createBooking: (input: PublicBookingInput, options?: PublicBookingCreateOptions) => Promise<PublicBookingResult>;
  startCheckout: (accessToken: string) => Promise<CheckoutStartResult>;
  getStatus: (accessToken: string) => Promise<PublicBookingStatus>;
  getAvailability: () => ReturnType<typeof getPublicAvailability>;
  releaseBooking: (accessToken: string) => ReturnType<typeof releaseAuthorizedPublicBooking>;
  /** Legacy test seam; replacement safety is now checked transactionally. */
  canReplaceBooking?: (accessToken: string) => Promise<boolean>;
  consumeRateLimits: (checks: readonly RateLimitCheck[], secret: string) => Promise<RateLimitDecision>;
  log: (entry: PublicApiLogEntry) => void;
};

export const defaultPublicBookingApiDeps: PublicBookingApiDeps = {
  env: () => process.env,
  createBooking: createPublicBooking,
  startCheckout: (token) => startAuthorizedBookingCheckout(token),
  getStatus: (token) => getAuthorizedBookingStatus(token),
  getAvailability: getPublicAvailability,
  releaseBooking: releaseAuthorizedPublicBooking,
  consumeRateLimits: (checks, secret) => consumeRateLimits(checks, { secret }),
  log: (entry) => console.info(JSON.stringify({ event: "public-booking-api", ...entry })),
};

/** The only Checkout host a URL returned to the browser may point at. */
export const STRIPE_CHECKOUT_HOST = "checkout.stripe.com";

export function isApprovedCheckoutUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === STRIPE_CHECKOUT_HOST && url.port === "" && !url.username && !url.password;
}

/** Public JSON of a created booking: explicit allow-list, no identifiers, no token. */
export function publicBookingSummary(result: PublicBookingResult) {
  const { booking } = result;
  return {
    status: "PENDING_PAYMENT" as const,
    locationName: booking.locationName,
    appointmentDate: booking.appointmentDate,
    slotTime: booking.slotTime,
    holdExpiresAt: booking.holdExpiresAt.toISOString(),
    totalPriceCents: booking.totalPriceCents,
    depositAmountCents: booking.depositAmountCents,
    balanceDueCents: booking.balanceDueCents,
  };
}

/** Public JSON of a booking status: explicit allow-list. */
export function publicStatusBody(status: PublicBookingStatus) {
  return {
    state: status.state,
    canStartCheckout: status.canStartCheckout,
    holdExpiresAt: status.holdExpiresAt?.toISOString() ?? null,
    locationName: status.locationName,
    locationAddress: status.locationAddress,
    appointmentDate: status.appointmentDate,
    slotTime: status.slotTime,
    hairstyleName: status.hairstyleName,
    totalPriceCents: status.totalPriceCents,
    depositAmountCents: status.depositAmountCents,
    balanceDueCents: status.balanceDueCents,
    depositPaid: status.depositPaid,
  };
}

/**
 * Public mapping of every ambiguous Checkout reason. Exhaustive, and derived
 * only from the reason — which the domain derives from persisted Payment
 * state — so repeated requests for the same unresolved Payment get the same
 * response. No mapping tells the customer to start over while a Session might
 * still be payable; only an attempt that ended without money does.
 */
export const AMBIGUOUS_CHECKOUT_TO_PUBLIC: Readonly<Record<CheckoutAmbiguityReason, PublicErrorCode>> = {
  "provider-retrieval-failed": "CHECKOUT_TEMPORARILY_UNAVAILABLE",
  "checkout-creation-unconfirmed": "CHECKOUT_OUTCOME_UNCERTAIN",
  "provider-session-unusable": "CHECKOUT_NEEDS_ASSISTANCE",
  "payment-awaiting-confirmation": "PAYMENT_AWAITING_CONFIRMATION",
  "payment-already-received": "PAYMENT_RECEIVED",
  "checkout-attempt-ended": "CHECKOUT_ATTEMPT_ENDED",
  "booking-changed": "BOOKING_STATE_CHANGED",
};

export function createPublicBookingApi(deps: PublicBookingApiDeps = defaultPublicBookingApiDeps) {
  function fail(route: PublicApiRoute, request: Request, code: PublicErrorCode, detail?: string, extra: { setCookie?: string; headers?: Record<string, string> } = {}): Response {
    const response = publicError(code, extra);
    deps.log({ route, status: response.status, code, detail, requestId: requestId(request) });
    return response;
  }

  function config(route: PublicApiRoute, request: Request): PublicBookingConfig | Response {
    const env = deps.env();
    if (!isPublicBookingEnabled(env)) return publicError("NOT_FOUND");
    const loaded = loadPublicBookingConfig(env);
    if (!loaded.ok) return fail(route, request, "SERVICE_UNAVAILABLE", "configuration-invalid");
    return loaded.config;
  }

  async function limited(route: PublicApiRoute, request: Request, cfg: PublicBookingConfig, checks: [RateLimitName, string][]): Promise<Response | null> {
    let decision: RateLimitDecision;
    try {
      decision = await deps.consumeRateLimits(checks.map(([name, identity]) => ({ rule: cfg.rateLimits[name], identity })), cfg.rateLimitSecret);
    } catch {
      return fail(route, request, "SERVICE_UNAVAILABLE", "rate-limit-store-unavailable");
    }
    if (decision.allowed) return null;
    return fail(route, request, "RATE_LIMITED", decision.scope, { headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }

  async function mutationPreamble(route: PublicApiRoute, request: Request, maxBytes: number): Promise<{ cfg: PublicBookingConfig; text: string } | Response> {
    const cfg = config(route, request);
    if (cfg instanceof Response) return cfg;
    const rejection = checkMutationOrigin(request.headers, cfg.allowedOrigins);
    if (rejection) return fail(route, request, "REQUEST_ORIGIN_REJECTED", rejection);
    if (!isJsonContentType(request.headers.get("content-type"))) return fail(route, request, "UNSUPPORTED_CONTENT_TYPE");
    const body = await readBodyText(request, maxBytes);
    if (!body.ok) return body.problem === "TOO_LARGE" ? fail(route, request, "REQUEST_TOO_LARGE") : fail(route, request, "INVALID_JSON", "not-utf8");
    return { cfg, text: body.text };
  }

  function unexpected(route: PublicApiRoute, request: Request, error: unknown): Response {
    if (isBookingError(error)) return fail(route, request, BOOKING_ERROR_TO_PUBLIC[error.code], error.code);
    // Only the class name: messages may carry query parameters or identifiers.
    return fail(route, request, "INTERNAL_ERROR", error instanceof Error ? error.name : "non-error-thrown");
  }

  /** POST /api/bookings — anonymous booking creation. */
  async function createBooking(request: Request): Promise<Response> {
    const route = "bookings.create";
    const pre = await mutationPreamble(route, request, MAX_BOOKING_BODY_BYTES);
    if (pre instanceof Response) return pre;
    const { cfg, text } = pre;

    const ip = clientIdentity(request.headers, cfg.clientIpSource);
    const ipLimited = await limited(route, request, cfg, [["bookingIp10m", ip.value], ["bookingIpDay", ip.value]]);
    if (ipLimited) return ipLimited;

    const json = parseJsonObject(text);
    if (!json.ok) return fail(route, request, "INVALID_JSON");
    let input: PublicBookingInput;
    try {
      input = parsePublicBookingInput(json.value);
    } catch (error) {
      if (error instanceof PublicBookingValidationError) return fail(route, request, "INVALID_BOOKING_INPUT");
      return unexpected(route, request, error);
    }

    const contactLimited = await limited(route, request, cfg, [
      ["bookingEmailDay", input.email],
      ["bookingPhoneDay", input.phone.replace(/\D/g, "")],
    ]);
    if (contactLimited) return contactLimited;

    // Resolve a supplied credential before the write, then consume/re-check it
    // inside createPublicBooking's transaction. This avoids a read-then-write
    // replacement race between two browser requests.
    const cookie = readBookingCookie(request.headers);
    let replacementAccessToken: string | undefined;
    if (cookie.kind === "present") {
      try {
        await resolveBookingAccess(cookie.token);
        replacementAccessToken = cookie.token;
      } catch (error) {
        // An unusable credential is replaced; any infrastructure failure fails closed.
        if (!isBookingAccessError(error)) return fail(route, request, "SERVICE_UNAVAILABLE", "existing-booking-check-failed");
      }
    }

    let result: PublicBookingResult;
    try {
      result = await deps.createBooking(input, { replacementAccessToken });
    } catch (error) {
      if (error instanceof PublicBookingValidationError) return fail(route, request, "INVALID_BOOKING_INPUT");
      if (error instanceof PublicBookingReplacementConflictError || (replacementAccessToken && isBookingAccessError(error))) {
        return fail(route, request, "ACTIVE_BOOKING_EXISTS");
      }
      return unexpected(route, request, error);
    }

    deps.log({ route, status: 201, requestId: requestId(request) });
    return publicJson(201, { booking: publicBookingSummary(result) }, { setCookie: bookingCookie(result.accessToken, result.accessExpiresAt) });
  }

  /** POST /api/bookings/checkout — start or resume Stripe Checkout for the cookie's booking. */
  async function startCheckout(request: Request): Promise<Response> {
    const route = "bookings.checkout";
    const pre = await mutationPreamble(route, request, MAX_CHECKOUT_BODY_BYTES);
    if (pre instanceof Response) return pre;
    const { cfg, text } = pre;

    const cookie = readBookingCookie(request.headers);
    const ip = clientIdentity(request.headers, cfg.clientIpSource);
    const checks: [RateLimitName, string][] = [["checkoutIp10m", ip.value]];
    if (cookie.kind === "present") checks.push(["checkoutCredential10m", cookie.token]);
    const rateLimited = await limited(route, request, cfg, checks);
    if (rateLimited) return rateLimited;

    const json = parseJsonObject(text);
    if (!json.ok) return fail(route, request, "INVALID_JSON");
    if (Object.keys(json.value).length > 0) return fail(route, request, "INVALID_REQUEST", "unexpected-fields");

    if (cookie.kind === "absent") return fail(route, request, "BOOKING_ACCESS_DENIED", "MISSING");
    if (cookie.kind === "ambiguous") return fail(route, request, "BOOKING_ACCESS_DENIED", "AMBIGUOUS", { setCookie: clearedBookingCookie() });

    let result: CheckoutStartResult;
    try {
      result = await deps.startCheckout(cookie.token);
    } catch (error) {
      if (isBookingAccessError(error)) return fail(route, request, "BOOKING_ACCESS_DENIED", error.reason, { setCookie: clearedBookingCookie() });
      return unexpected(route, request, error);
    }

    switch (result.kind) {
      case "ready":
        if (!isApprovedCheckoutUrl(result.checkoutUrl)) return fail(route, request, "CHECKOUT_PROVIDER_ERROR", "unapproved-checkout-url");
        deps.log({ route, status: 200, requestId: requestId(request) });
        return publicJson(200, { checkout: { url: result.checkoutUrl, expiresAt: result.expiresAt.toISOString() } });
      case "ambiguous":
        // Never a reason to create another Session: the domain keeps one Payment per booking.
        return fail(route, request, AMBIGUOUS_CHECKOUT_TO_PUBLIC[result.reason], result.reason, result.retryable ? { headers: { "Retry-After": String(CHECKOUT_RETRY_AFTER_SECONDS) } } : {});
      case "retry-window-expired":
        // Its Payment has no recorded Session, so every later request reports
        // checkout-creation-unconfirmed; answer the same way now.
        return fail(route, request, "CHECKOUT_OUTCOME_UNCERTAIN", "retry-window-expired");
    }
  }

  /** GET /api/bookings/status — the cookie's booking, allow-listed. No mutations. */
  async function getStatus(request: Request): Promise<Response> {
    const route = "bookings.status";
    const cfg = config(route, request);
    if (cfg instanceof Response) return cfg;

    const cookie = readBookingCookie(request.headers);
    const ip = clientIdentity(request.headers, cfg.clientIpSource);
    const checks: [RateLimitName, string][] = [["statusIp1m", ip.value]];
    if (cookie.kind === "present") checks.push(["statusCredential1m", cookie.token]);
    const rateLimited = await limited(route, request, cfg, checks);
    if (rateLimited) return rateLimited;

    if (cookie.kind === "absent") return fail(route, request, "BOOKING_ACCESS_DENIED", "MISSING");
    if (cookie.kind === "ambiguous") return fail(route, request, "BOOKING_ACCESS_DENIED", "AMBIGUOUS", { setCookie: clearedBookingCookie() });

    try {
      const status = await deps.getStatus(cookie.token);
      return publicJson(200, { booking: publicStatusBody(status) });
    } catch (error) {
      if (isBookingAccessError(error)) return fail(route, request, "BOOKING_ACCESS_DENIED", error.reason, { setCookie: clearedBookingCookie() });
      return unexpected(route, request, error);
    }
  }

  /** GET /api/bookings/availability — informational, no customer or reservation data. */
  async function getAvailability(request: Request): Promise<Response> {
    const route = "bookings.availability";
    const cfg = config(route, request);
    if (cfg instanceof Response) return cfg;
    const ip = clientIdentity(request.headers, cfg.clientIpSource);
    const rateLimited = await limited(route, request, cfg, [["availabilityIp1m", ip.value]]);
    if (rateLimited) return rateLimited;
    try {
      const availability = await deps.getAvailability();
      return publicJson(200, { availability });
    } catch (error) {
      return unexpected(route, request, error);
    }
  }

  /** POST /api/bookings/release — cancel only a provably unpaid cookie booking. */
  async function releaseBooking(request: Request): Promise<Response> {
    const route = "bookings.release";
    const pre = await mutationPreamble(route, request, MAX_CHECKOUT_BODY_BYTES);
    if (pre instanceof Response) return pre;
    const { cfg, text } = pre;
    const body = parseJsonObject(text);
    if (!body.ok || Object.keys(body.value).length > 0) return fail(route, request, "INVALID_REQUEST");
    const cookie = readBookingCookie(request.headers);
    const ip = clientIdentity(request.headers, cfg.clientIpSource);
    const checks: [RateLimitName, string][] = [["releaseIp10m", ip.value]];
    if (cookie.kind === "present") checks.push(["releaseCredential10m", cookie.token]);
    const rateLimited = await limited(route, request, cfg, checks);
    if (rateLimited) return rateLimited;
    if (cookie.kind !== "present") return fail(route, request, "BOOKING_ACCESS_DENIED", cookie.kind.toUpperCase(), { setCookie: cookie.kind === "ambiguous" ? clearedBookingCookie() : undefined });
    try {
      const result = await deps.releaseBooking(cookie.token);
      return publicJson(200, { released: result.released }, { setCookie: clearedBookingCookie() });
    } catch (error) {
      if (error instanceof PublicBookingReleaseConflictError) return fail(route, request, "BOOKING_RELEASE_UNSAFE");
      if (isBookingAccessError(error)) return fail(route, request, "BOOKING_ACCESS_DENIED", error.reason, { setCookie: clearedBookingCookie() });
      return unexpected(route, request, error);
    }
  }

  return { createBooking, startCheckout, getStatus, getAvailability, releaseBooking };
}

/** Vercel's request id, when well-formed; for log correlation only. */
function requestId(request: Request): string | undefined {
  const id = request.headers.get("x-vercel-id");
  return id && /^[A-Za-z0-9:_-]{1,128}$/.test(id) ? id : undefined;
}

export const publicBookingApi = createPublicBookingApi();
