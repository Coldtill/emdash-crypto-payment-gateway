import { pluginResponse, type PluginContext } from "emdash/plugin";

import { verifySignature, type PaymentEvent } from "./coldtill.js";
import { applyPaymentState, type Order } from "./orders.js";

export const WEBHOOK_HEADERS = [
	"x-coldtill-signature-v2",
	"x-coldtill-timestamp",
	"x-keyhold-signature-v2",
	"x-keyhold-timestamp",
	"content-type",
];

const reply = (status: number, value: string) =>
	pluginResponse({ status, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value } });

/**
 * Public route for Coldtill webhooks. Kept lean for Cloudflare's per-request
 * limits: one settings read, one storage query and at most one conditional write.
 */
export async function webhook(
	routeCtx: { input: Uint8Array; request: { headers: Record<string, string> } },
	ctx: PluginContext,
) {
	const secret = await ctx.settings.get<string>("webhookSecret");
	if (!secret) return reply(503, "webhook secret not configured");

	// Coldtill sends every header twice: X-Coldtill-* and the pre-rename X-Keyhold-*.
	const h = routeCtx.request.headers;
	const signature = h["x-coldtill-signature-v2"] ?? h["x-keyhold-signature-v2"];
	const timestamp = h["x-coldtill-timestamp"] ?? h["x-keyhold-timestamp"];
	if (!(await verifySignature(routeCtx.input, signature, timestamp, secret))) {
		return reply(401, "invalid signature");
	}

	let event: PaymentEvent;
	try {
		event = JSON.parse(new TextDecoder().decode(routeCtx.input)) as PaymentEvent;
	} catch {
		return reply(400, "invalid json");
	}

	// The event header is not signed, so decide from the signed body. Test
	// events and payouts carry no payment reference and are acknowledged.
	const reference = typeof event?.reference_id === "string" ? event.reference_id : "";
	if (!reference || typeof event.status !== "string") return reply(200, "ignored");

	const found = await ctx.storage.orders!.query({ where: { coldtillReference: reference }, limit: 1 });
	const order = found.items[0]?.data as Order | undefined;
	// Another integration on the same Coldtill project, or a stale reference: acknowledge and move on.
	if (!order || order.coldtillReference !== reference || (event.invoice_id && event.invoice_id !== order.id)) {
		return reply(200, "unknown payment");
	}

	const status = await applyPaymentState(
		ctx,
		order,
		event.status,
		event.amount,
		event.payment_info?.[0]?.transaction_hash ?? null,
	);
	return reply(200, status);
}
