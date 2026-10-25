import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const COLDTILL = "https://pay.example.com";
const PAYMENT_URL = `${COLDTILL}/api/v1/payment`;
const SECRET = "whsec_test_secret";
const SITE = "https://shop.example.com";

interface StoredOrder {
	id: string;
	coldtillReference: string;
	status: string;
	amountCents: number;
	quantity: number;
	productName: string;
	note: string | null;
	paidAt: string | null;
	updatedAt: string;
	txHash: string | null;
	coldtillState: string;
}

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function setup(options: { settings?: boolean } = {}) {
	host = await createPluginRuntimeTestHost({ site: { url: SITE } });
	await host.fixtures.collection({
		slug: "products",
		label: "Products",
		fields: [
			{ slug: "name", label: "Name", type: "string" },
			{ slug: "price", label: "Price", type: "number" },
			{ slug: "active", label: "Active", type: "boolean" },
		],
	});
	const product = await host.fixtures.content("products", {
		slug: "hoodie",
		status: "published",
		data: { name: "Hoodie", price: 25, active: true },
	});
	if (options.settings !== false) {
		await host.fixtures.plugin.setting("coldtillUrl", COLDTILL);
		await host.fixtures.plugin.setting("apiKey", "ct_test_key");
		await host.fixtures.plugin.setting("webhookSecret", SECRET);
	}
	return { host, productId: product.id };
}

async function callJson(h: PluginRuntimeTestHost, route: string, body: unknown, headers?: Record<string, string>) {
	const res = await h.actions.routes.request(route, { method: "POST", body, headers });
	return { status: res.status, json: (await res.json()) as { success: boolean; data: any } };
}

async function startCheckout(h: PluginRuntimeTestHost, productId: string, ref = "ref-1", extra: object = {}) {
	await h.http.respond(PAYMENT_URL, json({ host: COLDTILL, reference_id: ref, url: `${COLDTILL}/pay/${ref}` }));
	const { json: res } = await callJson(h, "checkout", { productId, ...extra });
	expect(res.data.ok).toBe(true);
	return res.data.orderId as string;
}

function hex(buf: ArrayBuffer) {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
	return { signature: `sha256=${hex(mac)}`, timestamp: String(ts) };
}

async function sendWebhook(
	h: PluginRuntimeTestHost,
	body: string,
	sig: { signature: string; timestamp: string },
	prefix = "X-Coldtill",
) {
	const res = await h.actions.routes.request("webhook", {
		method: "POST",
		rawBody: body,
		headers: {
			"Content-Type": "application/json",
			[`${prefix}-Signature-V2`]: sig.signature,
			[`${prefix}-Timestamp`]: sig.timestamp,
			[`${prefix}-Event`]: "payment.filled",
		},
	});
	return { status: res.status, text: await res.text() };
}

const paymentEvent = (orderId: string, status: string, amount = "25.00", ref = "ref-1") =>
	JSON.stringify({
		customer_id: `emdash-${orderId}`,
		invoice_id: orderId,
		reference_id: ref,
		status,
		amount,
		currency: "USD",
		filled_amount: amount,
		filled_amount_in_usd: amount,
		timestamp: Math.floor(Date.now() / 1000),
		payment_info: [{ transaction_hash: "0xabc", network: "BASE", currency: "USDC", amount }],
		confirmation_current: 0,
		confirmation_required: 0,
	});

const getOrder = (h: PluginRuntimeTestHost, id: string) => h.inspect.storage.get<StoredOrder>("orders", id);

describe("checkout route", () => {
	it("creates an order with the price from content and ignores a client-sent price", async () => {
		const { host: h, productId } = await setup();
		await h.http.respond(PAYMENT_URL, json({ host: COLDTILL, reference_id: "ref-1", url: `${COLDTILL}/pay/ref-1` }));

		const { status, json: res } = await callJson(h, "checkout", {
			productId,
			quantity: 2,
			price: 0.01,
			amountInUSD: "0.01",
			email: "buyer@example.com",
			returnPath: "/products/hoodie",
		});

		expect(status).toBe(200);
		expect(res.success).toBe(true);
		expect(res.data).toMatchObject({ ok: true, checkoutUrl: `${COLDTILL}/pay/ref-1` });
		const orderId = res.data.orderId as string;
		expect(orderId).toMatch(/^ord_[0-9a-f]{32}$/);

		const [req] = h.http.requests();
		expect(req?.url).toBe(PAYMENT_URL);
		expect(req?.method).toBe("POST");
		expect(new Headers(req?.headers).get("API-Key")).toBe("ct_test_key");
		const sent = JSON.parse(new TextDecoder().decode(req?.body));
		expect(sent).toEqual({
			customerID: `emdash-${orderId}`,
			customerEmail: "buyer@example.com",
			amountInUSD: "50.00",
			invoiceID: orderId,
			returnURL: `${SITE}/products/hoodie?coldtill_order=${orderId}`,
		});

		expect(await getOrder(h, orderId)).toMatchObject({
			id: orderId,
			coldtillReference: "ref-1",
			productId,
			productName: "Hoodie",
			quantity: 2,
			unitAmountCents: 2500,
			amountCents: 5000,
			status: "pending",
			customerEmail: "buyer@example.com",
		});
	});

	it("retries once without returnURL when Coldtill rejects it", async () => {
		const { host: h, productId } = await setup();
		await h.http.respond(PAYMENT_URL, json({ error: "returnURL host is not in the allowed return hosts" }, 400));
		await h.http.respond(PAYMENT_URL, json({ host: COLDTILL, reference_id: "ref-2", url: `${COLDTILL}/pay/ref-2` }));

		const { json: res } = await callJson(h, "checkout", { productId });
		expect(res.data).toMatchObject({ ok: true, checkoutUrl: `${COLDTILL}/pay/ref-2` });

		const requests = h.http.requests();
		expect(requests).toHaveLength(2);
		const first = JSON.parse(new TextDecoder().decode(requests[0]?.body));
		const second = JSON.parse(new TextDecoder().decode(requests[1]?.body));
		expect(first.returnURL).toContain("coldtill_order=");
		expect(second).not.toHaveProperty("returnURL");
		expect(second.amountInUSD).toBe("25.00");
	});

	it("does not retry other 400 errors", async () => {
		const { host: h, productId } = await setup();
		await h.http.respond(PAYMENT_URL, json({ error: "amountInUSD must be greater than 0" }, 400));

		const { json: res } = await callJson(h, "checkout", { productId });
		expect(res.data).toMatchObject({ ok: false, code: "PAYMENT_FAILED" });
		expect(h.http.requests()).toHaveLength(1);
		expect(await h.inspect.storage.list("orders")).toHaveLength(0);
	});

	it("refuses unpublished, inactive and unknown products without calling Coldtill", async () => {
		const { host: h } = await setup();
		const draft = await h.fixtures.content("products", { slug: "draft", status: "draft", data: { name: "Draft", price: 5 } });
		const inactive = await h.fixtures.content("products", {
			slug: "off",
			status: "published",
			data: { name: "Off", price: 5, active: false },
		});
		for (const productId of [draft.id, inactive.id, "missing"]) {
			const { json: res } = await callJson(h, "checkout", { productId });
			expect(res.data).toMatchObject({ ok: false, code: "PRODUCT_UNAVAILABLE" });
		}
		expect(h.http.requests()).toHaveLength(0);
	});

	it("rejects bad input and a missing configuration", async () => {
		const { host: h, productId } = await setup({ settings: false });
		for (const body of [{}, { productId, quantity: 0 }, { productId, quantity: 1.5 }, { productId, returnPath: "//evil.com" }]) {
			const { json: res } = await callJson(h, "checkout", body);
			expect(res.data).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
		}
		const { json: res } = await callJson(h, "checkout", { productId });
		expect(res.data).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
	});

	it("reads secrets saved through the generated settings form", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		const { host: h, productId } = await setup({ settings: false });
		const saved = await h.actions.plugin.updateSettings({
			coldtillUrl: `${COLDTILL}/`,
			apiKey: "ct_encrypted_key",
			webhookSecret: SECRET,
		});
		expect(saved).toMatchObject({ success: true });
		expect(JSON.stringify(await h.inspect.settings.raw("apiKey"))).not.toContain("ct_encrypted_key");

		await h.http.respond(PAYMENT_URL, json({ host: COLDTILL, reference_id: "ref-9", url: `${COLDTILL}/pay/ref-9` }));
		const { json: res } = await callJson(h, "checkout", { productId });
		expect(res.data.ok).toBe(true);
		expect(new Headers(h.http.requests()[0]?.headers).get("API-Key")).toBe("ct_encrypted_key");
	});
});

describe("webhook route", () => {
	it("marks the order paid exactly once, including a duplicate delivery", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const body = paymentEvent(orderId, "FILLED");
		const sig = await sign(body);

		expect(await sendWebhook(h, body, sig)).toEqual({ status: 200, text: "paid" });
		const paid = await getOrder(h, orderId);
		expect(paid).toMatchObject({ status: "paid", coldtillState: "FILLED", txHash: "0xabc", note: null });
		expect(paid?.paidAt).toBeTruthy();

		// Coldtill retries reuse the same body; the order must not change again.
		expect(await sendWebhook(h, body, sig)).toEqual({ status: 200, text: "paid" });
		const again = await getOrder(h, orderId);
		expect(again?.paidAt).toBe(paid?.paidAt);
		expect(again?.updatedAt).toBe(paid?.updatedAt);
	});

	it("accepts the pre-rename X-Keyhold headers", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const body = paymentEvent(orderId, "OVER_FILLED", "25");
		expect(await sendWebhook(h, body, await sign(body), "X-Keyhold")).toEqual({ status: 200, text: "paid" });
		expect(await getOrder(h, orderId)).toMatchObject({ status: "paid", coldtillState: "OVER_FILLED" });
		expect((await getOrder(h, orderId))?.note).toContain("Overpaid");
	});

	it("rejects tampered, stale, wrong-secret and missing signatures", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const body = paymentEvent(orderId, "FILLED");
		const now = Math.floor(Date.now() / 1000);

		const tampered = await sendWebhook(h, body.replace('"25.00"', '"25.01"'), await sign(body));
		const stale = await sendWebhook(h, body, await sign(body, SECRET, now - 301));
		const future = await sendWebhook(h, body, await sign(body, SECRET, now + 301));
		const wrongSecret = await sendWebhook(h, body, await sign(body, "whsec_other"));
		const unsigned = await sendWebhook(h, body, { signature: "", timestamp: String(now) });
		const v1Style = await sendWebhook(h, body, { signature: "sha256=" + "0".repeat(64), timestamp: String(now) });

		for (const res of [tampered, stale, future, wrongSecret, unsigned, v1Style]) {
			expect(res).toEqual({ status: 401, text: "invalid signature" });
		}
		expect(await getOrder(h, orderId)).toMatchObject({ status: "pending" });
	});

	it("does not mark the order paid when the amount is wrong", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);

		for (const amount of ["24.98", "1", "abc"]) {
			const body = paymentEvent(orderId, "FILLED", amount);
			expect(await sendWebhook(h, body, await sign(body))).toEqual({ status: 200, text: "pending" });
		}
		const order = await getOrder(h, orderId);
		expect(order).toMatchObject({ status: "pending", paidAt: null });
		expect(order?.note).toContain("does not match");

		// Within one cent is accepted.
		const close = paymentEvent(orderId, "FILLED", "24.99");
		expect(await sendWebhook(h, close, await sign(close))).toEqual({ status: 200, text: "paid" });
	});

	it("holds partial payments and settles them on a later fill", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const send = async (status: string) => {
			const body = paymentEvent(orderId, status);
			return sendWebhook(h, body, await sign(body));
		};

		expect(await send("PARTIALLY_FILLED")).toEqual({ status: 200, text: "partial" });
		expect(await send("OPEN")).toEqual({ status: 200, text: "partial" });
		expect(await send("CANCELLED")).toEqual({ status: 200, text: "partial" });
		const held = await getOrder(h, orderId);
		expect(held).toMatchObject({ status: "partial", coldtillState: "CANCELLED" });
		expect(held?.note).toContain("settle this order by hand");

		expect(await send("FILLED")).toEqual({ status: 200, text: "paid" });
	});

	it("cancels open orders on cancelled and replaced payments", async () => {
		const { host: h, productId } = await setup();
		const a = await startCheckout(h, productId, "ref-a");
		const b = await startCheckout(h, productId, "ref-b");

		const cancelled = paymentEvent(a, "CANCELLED", "25.00", "ref-a");
		const replaced = paymentEvent(b, "REPLACED", "25.00", "ref-b");
		expect(await sendWebhook(h, cancelled, await sign(cancelled))).toEqual({ status: 200, text: "cancelled" });
		expect(await sendWebhook(h, replaced, await sign(replaced))).toEqual({ status: 200, text: "cancelled" });
		expect(await getOrder(h, a)).toMatchObject({ status: "cancelled", coldtillState: "CANCELLED" });
		expect(await getOrder(h, b)).toMatchObject({ status: "cancelled", coldtillState: "REPLACED" });
	});

	it("acknowledges unknown references, mismatched invoices, test events and payouts", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);

		const unknown = paymentEvent(orderId, "FILLED", "25.00", "ref-other");
		const wrongInvoice = paymentEvent("ord_" + "0".repeat(32), "FILLED");
		const test = JSON.stringify({ event: "test" });
		const payout = JSON.stringify({ id: "p1", status: "sent", amount: "1" });

		expect(await sendWebhook(h, unknown, await sign(unknown))).toEqual({ status: 200, text: "unknown payment" });
		expect(await sendWebhook(h, wrongInvoice, await sign(wrongInvoice))).toEqual({ status: 200, text: "unknown payment" });
		expect(await sendWebhook(h, test, await sign(test))).toEqual({ status: 200, text: "ignored" });
		expect(await sendWebhook(h, payout, await sign(payout))).toEqual({ status: 200, text: "ignored" });
		expect(await getOrder(h, orderId)).toMatchObject({ status: "pending" });
	});

	it("returns 503 until the webhook secret is set", async () => {
		const { host: h } = await setup({ settings: false });
		const body = JSON.stringify({ event: "test" });
		expect(await sendWebhook(h, body, await sign(body))).toEqual({ status: 503, text: "webhook secret not configured" });
	});
});

describe("verify route", () => {
	it("re-checks an open order with Coldtill and stops once it is paid", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const lookup = `${COLDTILL}/api/v1/payment/reference/ref-1`;

		await h.http.respond(lookup, json({ referenceID: "ref-1", invoiceID: orderId, amountInUSD: "25", paymentState: "OPEN", deposits: [] }));
		expect((await callJson(h, "verify", { orderId })).json.data).toEqual({ ok: true, orderId, status: "pending", paid: false });

		await h.http.respond(
			lookup,
			json({ referenceID: "ref-1", invoiceID: orderId, amountInUSD: "25", paymentState: "FILLED", deposits: [{ transactionHash: "0xdef" }] }),
		);
		expect((await callJson(h, "verify", { orderId })).json.data).toEqual({ ok: true, orderId, status: "paid", paid: true });
		expect(await getOrder(h, orderId)).toMatchObject({ status: "paid", txHash: "0xdef" });

		// Paid orders answer from storage without another Coldtill request.
		const before = h.http.requests().length;
		expect((await callJson(h, "verify", { orderId })).json.data).toMatchObject({ paid: true });
		expect(h.http.requests()).toHaveLength(before);
		expect(h.http.requests().at(-1)?.method).toBe("GET");
	});

	it("ignores a Coldtill payment for a different reference or amount", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const lookup = `${COLDTILL}/api/v1/payment/reference/ref-1`;

		await h.http.respond(lookup, json({ referenceID: "ref-x", invoiceID: orderId, amountInUSD: "25", paymentState: "FILLED" }));
		expect((await callJson(h, "verify", { orderId })).json.data).toMatchObject({ status: "pending", paid: false });

		await h.http.respond(lookup, json({ referenceID: "ref-1", invoiceID: orderId, amountInUSD: "5", paymentState: "FILLED" }));
		expect((await callJson(h, "verify", { orderId })).json.data).toMatchObject({ status: "pending", paid: false });
	});

	it("rejects malformed and unknown order ids", async () => {
		const { host: h } = await setup();
		expect((await callJson(h, "verify", { orderId: "../x" })).json.data).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
		expect((await callJson(h, "verify", { orderId: "ord_" + "a".repeat(32) })).json.data).toMatchObject({
			ok: false,
			code: "NOT_FOUND",
		});
	});
});

describe("config route", () => {
	it("returns the product collection", async () => {
		const { host: h } = await setup();
		const res = await h.actions.routes.request("config", { method: "GET" });
		expect(await res.json()).toEqual({ success: true, data: { productCollection: "products" } });
	});
});

describe("admin page", () => {
	it("loads with setup guidance on a fresh install", async () => {
		host = await createPluginRuntimeTestHost();
		const page = JSON.stringify(await host.admin.loadPage("/orders"));
		expect(page).toContain("Finish setting up Coldtill");
		expect(page).toContain("/_emdash/api/plugins/coldtill/webhook");
		expect(page).toContain("No orders yet.");
	});

	it("lists orders", async () => {
		const { host: h, productId } = await setup();
		const orderId = await startCheckout(h, productId);
		const page = await h.admin.loadPage("/orders");
		const text = JSON.stringify(page);
		expect(text).not.toContain("Finish setting up Coldtill");
		expect(text).toContain(orderId);
		expect(text).toContain("Hoodie");
		expect(text).toContain("$25.00");
	});
});
