import { isIPv4, isIPv6 } from "node:net";

import type { ClientIpSource } from "./config";

/**
 * Client-IP identity for rate limiting.
 *
 * Deployment contract (Vercel, per its request-header documentation): Vercel
 * overwrites X-Forwarded-For and does not forward client-supplied IPs, and
 * `x-vercel-forwarded-for` carries the same value but cannot be overwritten
 * by a proxy placed in front of Vercel. Only that header is read, only when
 * TRUSTED_CLIENT_IP_SOURCE=vercel. X-Forwarded-For, X-Real-IP and every other
 * client-controllable header are ignored.
 *
 * A missing, multi-valued or invalid value — and every request when no
 * trusted source exists — maps to ONE shared "unidentified" bucket. Garbage
 * therefore never earns a fresh identity: such requests are limited together.
 *
 * IPv4 is canonicalized; IPv6 is grouped by /64 (one subscriber's usual
 * allocation); IPv4-mapped IPv6 counts as its IPv4 address.
 */

export const VERCEL_CLIENT_IP_HEADER = "x-vercel-forwarded-for";
export const UNIDENTIFIED_CLIENT = "unidentified";

export type ClientIdentity = { kind: "ip"; value: string } | { kind: "unidentified"; value: typeof UNIDENTIFIED_CLIENT };

export function clientIdentity(headers: Headers, source: ClientIpSource): ClientIdentity {
  const unidentified = { kind: "unidentified", value: UNIDENTIFIED_CLIENT } as const;
  if (source !== "vercel") return unidentified;
  const raw = headers.get(VERCEL_CLIENT_IP_HEADER)?.trim();
  if (!raw || raw.includes(",")) return unidentified;
  const value = normalizeIp(raw);
  return value ? { kind: "ip", value } : unidentified;
}

/** Canonical rate-limit identity for an IP literal, or null when it is not one. */
export function normalizeIp(raw: string): string | null {
  if (isIPv4(raw)) return raw.split(".").map((octet) => String(Number(octet))).join(".");
  if (!isIPv6(raw) || raw.includes("%")) return null;

  const groups = expandIpv6(raw);
  if (!groups) return null;
  // IPv4-mapped (::ffff:a.b.c.d) is the IPv4 client.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16).padStart(4, "0")).join(":")}::/64`;
}

function expandIpv6(raw: string): number[] | null {
  let text = raw.toLowerCase();
  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) → two hextets.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const octets = tail[1].split(".").map(Number);
    text = `${text.slice(0, -tail[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 1) return null;
  const all = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right];
  const groups = all.map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}
