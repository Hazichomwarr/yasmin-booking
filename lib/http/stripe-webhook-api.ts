import { processSignedStripeWebhookEvent, type StripeWebhookProcessingResult } from "@/lib/booking/stripe-webhook";
import { stripeWebhookGateway, type StripeWebhookGateway } from "@/lib/stripe/webhook";

import { readBodyText } from "./request-guards";

/** Stripe's maximum event payload is far below this; enforce a firm server limit. */
export const MAX_STRIPE_WEBHOOK_BODY_BYTES = 256 * 1024;

export type StripeWebhookApiDeps = {
  env: () => Readonly<Record<string, string | undefined>>;
  gateway: (secretKey: string) => StripeWebhookGateway;
  process: (event: { id: string; type: string; data: { object: { id?: unknown } } }, gateway: StripeWebhookGateway) => Promise<StripeWebhookProcessingResult>;
  log: (entry: { status: number; outcome: string }) => void;
};

export const defaultStripeWebhookApiDeps: StripeWebhookApiDeps = {
  env: () => process.env,
  gateway: stripeWebhookGateway,
  process: processSignedStripeWebhookEvent,
  // Deliberately no event id, Session id, signature, body, or customer facts.
  log: (entry) => console.info(JSON.stringify({ event: "stripe-webhook", ...entry })),
};

function response(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function createStripeWebhookApi(deps: StripeWebhookApiDeps = defaultStripeWebhookApiDeps) {
  return async function post(request: Request): Promise<Response> {
    if (request.method !== "POST") return response(405);

    const body = await readBodyText(request, MAX_STRIPE_WEBHOOK_BODY_BYTES);
    if (!body.ok) {
      const status = body.problem === "TOO_LARGE" ? 413 : 400;
      deps.log({ status, outcome: body.problem.toLowerCase() });
      return response(status);
    }

    const signature = request.headers.get("stripe-signature");
    const env = deps.env();
    const secretKey = env.STRIPE_SECRET_KEY;
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !secretKey || !webhookSecret) {
      // A missing deployment secret fails closed and is indistinguishable from
      // an invalid signature to callers.
      deps.log({ status: 400, outcome: "signature-invalid" });
      return response(400);
    }

    const gateway = deps.gateway(secretKey);
    let event: { id: string; type: string; data: { object: { id?: unknown } } };
    try {
      event = gateway.constructEvent(body.text, signature, webhookSecret) as typeof event;
    } catch {
      deps.log({ status: 400, outcome: "signature-invalid" });
      return response(400);
    }

    try {
      const outcome = await deps.process(event, gateway);
      if (outcome.kind === "busy") {
        deps.log({ status: 500, outcome: "delivery-in-progress" });
        return response(500);
      }
      deps.log({ status: 200, outcome: outcome.kind });
      return response(200);
    } catch (error) {
      // A non-2xx response makes Stripe retry. Never surface provider or
      // database messages because they may contain sensitive identifiers.
      deps.log({ status: 500, outcome: error instanceof Error ? error.name : "processing-failed" });
      return response(500);
    }
  };
}

export const stripeWebhookApi = createStripeWebhookApi();
