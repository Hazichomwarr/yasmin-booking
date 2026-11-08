export type StripeServerKeyClass = "standard" | "restricted";
export type StripeServerKeyMode = "test" | "live";

export type StripeServerKeyIdentity = Readonly<{
  keyClass: StripeServerKeyClass;
  mode: StripeServerKeyMode;
}>;

/**
 * Classifies a Stripe server key without retaining or returning credential
 * material. Stripe server keys have an sk/rk class, a test/live mode, and a
 * non-empty alphanumeric secret suffix. Any quoting or whitespace fails.
 */
export function parseStripeServerKey(value: string | undefined): StripeServerKeyIdentity | null {
  if (!value) return null;
  const match = /^(sk|rk)_(test|live)_([A-Za-z0-9]+)$/.exec(value);
  if (!match) return null;
  return {
    keyClass: match[1] === "sk" ? "standard" : "restricted",
    mode: match[2] as StripeServerKeyMode,
  };
}
