import { revokeAdminSession, signInAdmin, normalizeAdminEmail, type SignInResult } from "@/lib/admin/auth";
import { adminSessionCookie, clearedAdminSessionCookie, readAdminSessionCookie } from "@/lib/admin/session-cookie";

import { clientIdentity } from "./client-ip";
import { exactOrigin, isLocalOrigin, type ClientIpSource, type Env, type RateLimitRule } from "./config";
import { publicJson } from "./public-responses";
import { consumeRateLimits, type RateLimitCheck, type RateLimitDecision } from "./rate-limit";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "./request-guards";

/**
 * Admin sign-in / sign-out HTTP boundary (YASMIN-2A).
 *
 * Independent of the public-booking flag and Stripe: it needs only the
 * canonical origin (APP_BASE_URL), RATE_LIMIT_SECRET and the client-IP
 * source, validated per request so misconfiguration fails closed (503).
 *
 * Pipeline: configuration → exact Origin / Fetch-Metadata → JSON content type
 * → streamed body limit → IP rate limit → parsing → per-email rate limit →
 * credential check. Every credential failure (unknown email, wrong password,
 * disabled or unprovisioned admin) gets the same 401 body. Logs carry
 * outcome codes only — never emails, passwords, tokens or cookies.
 */

const MINUTE = 60_000;
export const ADMIN_RATE_LIMITS = {
  loginIp15m: { scope: "admin.login.ip.15m", limit: 10, windowMs: 15 * MINUTE },
  loginEmail15m: { scope: "admin.login.email.15m", limit: 5, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;
export const MAX_ADMIN_LOGIN_BODY_BYTES = 2 * 1024;

export type AdminConfig = { appOrigin: string; rateLimitSecret: string; clientIpSource: ClientIpSource };

/** Mirrors the public-booking rules for the same variables (lib/http/config.ts). */
export function loadAdminConfig(env: Env): AdminConfig | null {
  const strict = env.NODE_ENV === "production";
  const appOrigin = exactOrigin(env.APP_BASE_URL, { allowPath: true });
  if (!appOrigin) return null;
  if (!appOrigin.startsWith("https://") && (strict || !isLocalOrigin(appOrigin))) return null;
  const rateLimitSecret = env.RATE_LIMIT_SECRET ?? "";
  if (rateLimitSecret.length < 32) return null;
  const source = env.TRUSTED_CLIENT_IP_SOURCE;
  if (source !== "vercel" && source !== "none") return null;
  if (strict && source !== "vercel") return null;
  if (source === "vercel" && env.VERCEL !== "1") return null;
  return { appOrigin, rateLimitSecret, clientIpSource: source };
}

export type AdminAuthLogEntry = { route: "admin.login" | "admin.logout"; status: number; outcome: string };

export type AdminAuthApiDeps = {
  env: () => Env;
  signIn: (email: unknown, password: unknown) => Promise<SignInResult>;
  revoke: (token: unknown) => Promise<void>;
  consumeRateLimits: (checks: readonly RateLimitCheck[], secret: string) => Promise<RateLimitDecision>;
  log: (entry: AdminAuthLogEntry) => void;
};

export const defaultAdminAuthApiDeps: AdminAuthApiDeps = {
  env: () => process.env,
  signIn: signInAdmin,
  revoke: revokeAdminSession,
  consumeRateLimits: (checks, secret) => consumeRateLimits(checks, { secret }),
  log: (entry) => console.info(JSON.stringify({ event: "admin-auth", ...entry })),
};

const ERRORS = {
  SERVICE_UNAVAILABLE: [503, "Sign-in is temporarily unavailable."],
  REQUEST_ORIGIN_REJECTED: [403, "This request was not accepted."],
  UNSUPPORTED_CONTENT_TYPE: [415, "Send the request as application/json."],
  REQUEST_TOO_LARGE: [413, "The request is too large."],
  INVALID_REQUEST: [400, "The request is not valid."],
  RATE_LIMITED: [429, "Too many sign-in attempts. Please wait and try again."],
  INVALID_CREDENTIALS: [401, "The email or password is incorrect."],
} as const;
type ErrorCode = keyof typeof ERRORS;

export function createAdminAuthApi(deps: AdminAuthApiDeps = defaultAdminAuthApiDeps) {
  function fail(route: AdminAuthLogEntry["route"], code: ErrorCode, extra: { setCookie?: string; headers?: Record<string, string> } = {}): Response {
    const [status, message] = ERRORS[code];
    deps.log({ route, status, outcome: code });
    return publicJson(status, { error: { code, message } }, extra);
  }

  async function guard(route: AdminAuthLogEntry["route"], request: Request): Promise<{ cfg: AdminConfig; text: string } | Response> {
    const cfg = loadAdminConfig(deps.env());
    if (!cfg) return fail(route, "SERVICE_UNAVAILABLE");
    if (checkMutationOrigin(request.headers, new Set([cfg.appOrigin]))) return fail(route, "REQUEST_ORIGIN_REJECTED");
    if (!isJsonContentType(request.headers.get("content-type"))) return fail(route, "UNSUPPORTED_CONTENT_TYPE");
    const body = await readBodyText(request, MAX_ADMIN_LOGIN_BODY_BYTES);
    if (!body.ok) return fail(route, body.problem === "TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST");
    return { cfg, text: body.text };
  }

  async function limited(cfg: AdminConfig, checks: RateLimitCheck[]): Promise<Response | null> {
    let decision: RateLimitDecision;
    try {
      decision = await deps.consumeRateLimits(checks, cfg.rateLimitSecret);
    } catch {
      return fail("admin.login", "SERVICE_UNAVAILABLE");
    }
    return decision.allowed ? null : fail("admin.login", "RATE_LIMITED", { headers: { "Retry-After": String(decision.retryAfterSeconds) } });
  }

  /** POST /api/admin/login — { email, password } → session cookie. */
  async function login(request: Request): Promise<Response> {
    const pre = await guard("admin.login", request);
    if (pre instanceof Response) return pre;
    const { cfg, text } = pre;

    const ip = clientIdentity(request.headers, cfg.clientIpSource);
    const ipLimited = await limited(cfg, [{ rule: ADMIN_RATE_LIMITS.loginIp15m, identity: ip.value }]);
    if (ipLimited) return ipLimited;

    const json = parseJsonObject(text);
    if (!json.ok || Object.keys(json.value).some((key) => key !== "email" && key !== "password")) return fail("admin.login", "INVALID_REQUEST");
    const { email, password } = json.value;
    if (typeof email !== "string" || typeof password !== "string") return fail("admin.login", "INVALID_REQUEST");

    // Count every attempt against the (normalized) account, known or not.
    const emailLimited = await limited(cfg, [{ rule: ADMIN_RATE_LIMITS.loginEmail15m, identity: normalizeAdminEmail(email) ?? email.trim().toLowerCase() }]);
    if (emailLimited) return emailLimited;

    let result: SignInResult;
    try {
      result = await deps.signIn(email, password);
    } catch {
      return fail("admin.login", "SERVICE_UNAVAILABLE");
    }
    if (!result.ok) return fail("admin.login", "INVALID_CREDENTIALS");

    // A previous session in this browser is ended rather than left valid.
    const previous = readAdminSessionCookie(request.headers);
    if (previous) await deps.revoke(previous).catch(() => {});
    deps.log({ route: "admin.login", status: 200, outcome: "signed-in" });
    return publicJson(200, { ok: true }, { setCookie: adminSessionCookie(result.token, result.expiresAt) });
  }

  /** POST /api/admin/logout — revokes the cookie's session and clears the cookie. Idempotent. */
  async function logout(request: Request): Promise<Response> {
    const pre = await guard("admin.logout", request);
    if (pre instanceof Response) return pre;
    const token = readAdminSessionCookie(request.headers);
    try {
      if (token) await deps.revoke(token);
    } catch {
      return fail("admin.logout", "SERVICE_UNAVAILABLE");
    }
    deps.log({ route: "admin.logout", status: 200, outcome: token ? "revoked" : "no-session" });
    return publicJson(200, { ok: true }, { setCookie: clearedAdminSessionCookie() });
  }

  return { login, logout };
}

export const adminAuthApi = createAdminAuthApi();
