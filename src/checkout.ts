import type { PluginContext } from "emdash/plugin";

import { ColdtillError, createPayment, getColdtillConfig, getPayment } from "./coldtill.js";
import { applyPaymentState, type Order } from "./orders.js";

const MAX_QUANTITY = 100;
// Coldtill accepts at most 10,000,000 USD per payment.
const MAX_AMOUNT_CENTS = 10_000_000 * 100;

type Result<T> = ({ ok: true } & T) | { ok: false; code: string; error: string };

const fail = (code: string, error: string) => ({ ok: false as const, code, error });

export async function getProductCollection(ctx: PluginContext): Promise<string> {
	const slug = await ctx.settings.get<string>("productCollection");
	return typeof slug === "string" && slug.trim() ? slug.trim() : "products";
}

interface CheckoutInput {
	productId: string;
	quantity: number;
	email?: string;
	returnPath: string;
}

function parseCheckoutInput(input: unknown): CheckoutInput | null {
	if (typeof input !== "object" || input === null) return null;
	const data = input as Record<string, unknown>;

	const productId = typeof data.productId === "string" ? data.productId.trim() : "";
	if (!productId || productId.length > 128) return null;

	const quantity = data.quantity === undefined ? 1 : data.quantity;
	if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
		return null;
	}

	let email: string | undefined;
	if (data.email !== undefined && data.email !== "") {
		if (typeof data.email !== "string" || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
			return null;
		}
		email = data.email.trim();
	}

	// Same-site path only, so the return link can't point somewhere else.
	const returnPath = data.returnPath === undefined ? "/" : data.returnPath;
	if (typeof returnPath !== "string" || !returnPath.startsWith("/") || returnPath.startsWith("//") || returnPath.length > 1024) {
		return null;
	}

	// Anything else the client sends (a price, an amount) is ignored on purpose.
	return { productId, quantity, email, returnPath };
}

/**
 * Public route: starts a checkout for one product. The price always comes from
 * the product entry, never from the request.
 */
export async function checkout(
	routeCtx: { input: unknown },
	ctx: PluginContext,
): Promise<Result<{ orderId: string; checkoutUrl: string }>> {
	const input = parseCheckoutInput(routeCtx.input);
	if (!input) return fail("INVALID_REQUEST", "Invalid checkout request.");

	const config = await getColdtillConfig(ctx);
	if (!config) return fail("NOT_CONFIGURED", "Crypto payments are not set up yet.");
	if (!ctx.content) return fail("NOT_CONFIGURED", "Content access is not available.");

	const product = await ctx.content.get(await getProductCollection(ctx), input.productId);
	const data = product?.data ?? {};
	if (!product || product.status !== "published" || data.active === false || data.active === 0) {
		return fail("PRODUCT_UNAVAILABLE", "This product is not available.");
	}
	if (typeof data.currency === "string" && data.currency.trim().toUpperCase() !== "USD") {
		return fail("PRODUCT_UNAVAILABLE", "This product is not priced in USD.");
	}
	const price = data.price;
	if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
		return fail("PRODUCT_UNAVAILABLE", "This product has no valid USD price.");
	}
	const unitAmountCents = Math.round(price * 100);
	const amountCents = unitAmountCents * input.quantity;
	if (unitAmountCents < 1 || amountCents > MAX_AMOUNT_CENTS) {
		return fail("PRODUCT_UNAVAILABLE", "This product's price is out of range.");
	}
	const productName =
		[data.name, data.title, product.slug].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ??
		product.id;

	const orderId = `ord_${crypto.randomUUID().replace(/-/g, "")}`;

	// The checkout's "Return to store" button brings the buyer back here; the
	// storefront then calls verify with this order id.
	const siteUrl = new URL(ctx.site.url);
	const returnUrl = new URL(input.returnPath, siteUrl);
	returnUrl.searchParams.set("coldtill_order", orderId);
	const sameSiteHttps = returnUrl.origin === siteUrl.origin && returnUrl.protocol === "https:";

	let payment;
	try {
		payment = await createPayment(ctx, config, {
			// Coldtill keeps one open payment per customer, so each order gets its own id.
			customerID: `emdash-${orderId}`,
			customerEmail: input.email,
			amountInUSD: (amountCents / 100).toFixed(2),
			invoiceID: orderId,
			returnURL: sameSiteHttps ? returnUrl.toString() : undefined,
		});
	} catch (error) {
		ctx.log.error("Coldtill payment creation failed", {
			status: error instanceof ColdtillError ? error.status : 0,
			message: error instanceof Error ? error.message : String(error),
		});
		return fail("PAYMENT_FAILED", "Crypto payment is unavailable right now. Please try again later.");
	}

	const now = new Date().toISOString();
	const order: Order = {
		id: orderId,
		coldtillReference: payment.reference_id,
		checkoutUrl: payment.url,
		productId: product.id,
		productName,
		quantity: input.quantity,
		unitAmountCents,
		amountCents,
		currency: "USD",
		status: "pending",
		coldtillState: "OPEN",
		customerEmail: input.email ?? null,
		txHash: null,
		note: null,
		createdAt: now,
		updatedAt: now,
		paidAt: null,
	};
	await ctx.storage.orders!.put(orderId, order);
	ctx.log.info("Coldtill checkout started", { orderId, reference: payment.reference_id });

	return { ok: true, orderId, checkoutUrl: payment.url };
}

/**
 * Public route: re-checks an order with Coldtill when the buyer comes back,
 * in case a webhook was missed. Only reads Coldtill while the order is open.
 */
export async function verify(
	routeCtx: { input: unknown },
	ctx: PluginContext,
): Promise<Result<{ orderId: string; status: Order["status"]; paid: boolean }>> {
	const input = routeCtx.input as { orderId?: unknown } | null;
	const orderId = typeof input?.orderId === "string" ? input.orderId : "";
	if (!/^ord_[0-9a-f]{32}$/.test(orderId)) return fail("INVALID_REQUEST", "Invalid order id.");

	const order = (await ctx.storage.orders!.get(orderId)) as Order | null;
	if (!order) return fail("NOT_FOUND", "Order not found.");

	let status = order.status;
	if (status === "pending" || status === "partial") {
		const config = await getColdtillConfig(ctx);
		if (!config) return fail("NOT_CONFIGURED", "Crypto payments are not set up yet.");
		try {
			const payment = await getPayment(ctx, config, order.coldtillReference);
			if (payment.referenceID === order.coldtillReference && (!payment.invoiceID || payment.invoiceID === order.id)) {
				status = await applyPaymentState(
					ctx,
					order,
					payment.paymentState,
					payment.amountInUSD,
					payment.deposits?.[0]?.transactionHash ?? null,
				);
			}
		} catch (error) {
			// Report the stored status; the webhook can still arrive later.
			ctx.log.warn("Coldtill payment check failed", {
				orderId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { ok: true, orderId, status, paid: status === "paid" };
}
