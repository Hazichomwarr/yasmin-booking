import Stripe from "stripe";

/**
 * The one place a Stripe API client is constructed.
 *
 * STRIPE_LOCAL_TEST_API_URL points the SDK at a loopback Stripe test double
 * for local browser acceptance only. It is refused — the request fails
 * instead of silently reaching Stripe — unless NODE_ENV is not "production",
 * the key is a test key, and the URL is plain http on localhost/127.0.0.1.
 */
export function stripeClient(secretKey: string, env: Readonly<Record<string, string | undefined>> = process.env): Stripe {
  const local = env.STRIPE_LOCAL_TEST_API_URL;
  if (!local) return new Stripe(secretKey);
  if (env.NODE_ENV === "production") throw new Error("STRIPE_LOCAL_TEST_API_URL is not allowed in production.");
  if (!secretKey.startsWith("sk_test_")) throw new Error("STRIPE_LOCAL_TEST_API_URL requires a Stripe test key.");
  let url: URL;
  try {
    url = new URL(local);
  } catch {
    throw new Error("STRIPE_LOCAL_TEST_API_URL must be an absolute URL.");
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !url.port) {
    throw new Error("STRIPE_LOCAL_TEST_API_URL must be http://localhost:<port> or http://127.0.0.1:<port>.");
  }
  return new Stripe(secretKey, { host: url.hostname, port: url.port, protocol: "http" });
}
