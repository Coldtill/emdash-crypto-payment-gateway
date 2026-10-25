import type { PluginContext } from "emdash/plugin";

// Shapes from the Coldtill merchant API (app/sdk/typescript), inlined so the
// sandbox bundle stays self-contained.

export type PaymentState =
	| "OPEN"
	| "PARTIALLY_FILLED"
	| "FILLED"
	| "OVER_FILLED"
	| "CANCELLED"
	| "REPLACED";

export interface CreatePaymentRequest {
	customerID: string;
	customerEmail?: string;
	amountInUSD: string;
	invoiceID: string;
	returnURL?: string;
}

export interface CreatePaymentResponse {
	reference_id: string;
	url: string;
}

/** GET /api/v1/payment/reference/{ref} (only the fields this plugin reads). */
export interface Payment {
	invoiceID?: string;
	amountInUSD?: string;
	paymentState?: PaymentState;
	referenceID?: string;
	deposits?: Array<{ transactionHash?: string }>;
}

/** Signed webhook body for payment.* events. */
export interface PaymentEvent {
	event?: string;
	invoice_id?: string;
	reference_id?: string;
	status?: PaymentState;
	amount?: string;
	payment_info?: Array<{ transaction_hash?: string }>;
}

export class ColdtillError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface ColdtillConfig {
	baseUrl: string;
	apiKey: string;
}

/**
 * Reads the Coldtill URL and API key from settings. Returns null when either is
 * missing or the URL is not https (the API key must not travel in the clear).
 */
export async function getColdtillConfig(ctx: PluginContext): Promise<ColdtillConfig | null> {
	const [url, apiKey] = await Promise.all([
		ctx.settings.get<string>("coldtillUrl"),
		ctx.settings.get<string>("apiKey"),
	]);
	const baseUrl = normalizeBaseUrl(url);
	if (!baseUrl || !apiKey) return null;
	return { baseUrl, apiKey };
}

export function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" || url.username || url.password) return null;
		// Coldtill may run under a path, so keep it; drop query, hash and trailing slash.
		return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	} catch {
		return null;
	}
}

async function request<T>(
	ctx: PluginContext,
	config: ColdtillConfig,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<T> {
	if (!ctx.http) throw new ColdtillError(0, "Network access is not available.");
	const headers: Record<string, string> = { "API-Key": config.apiKey, Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";

	let res: Response;
	try {
		res = await ctx.http.fetch(`${config.baseUrl}/api/v1${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new ColdtillError(0, "Coldtill is unreachable.");
	}

	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Non-JSON error pages (a proxy, for example) fall through to the status.
	}
	if (!res.ok) {
		const message =
			data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
				? (data as { error: string }).error
				: `HTTP ${res.status}`;
		throw new ColdtillError(res.status, `Coldtill: ${message}`);
	}
	return (data ?? {}) as T;
}

/**
 * Creates a payment. A project that limits return hosts rejects other sites
 * with a 400 that names returnURL; then retry once without it, and the
 * checkout uses the project's own Return URL instead.
 */
export async function createPayment(
	ctx: PluginContext,
	config: ColdtillConfig,
	req: CreatePaymentRequest,
): Promise<CreatePaymentResponse> {
	let res: CreatePaymentResponse;
	try {
		res = await request<CreatePaymentResponse>(ctx, config, "POST", "/payment", req);
	} catch (error) {
		if (
			!req.returnURL ||
			!(error instanceof ColdtillError) ||
			error.status !== 400 ||
			!error.message.includes("returnURL")
		) {
			throw error;
		}
		const { returnURL: _dropped, ...withoutReturn } = req;
		res = await request<CreatePaymentResponse>(ctx, config, "POST", "/payment", withoutReturn);
	}
	// The browser is sent to res.url, so only accept an https link.
	if (typeof res.reference_id !== "string" || !res.reference_id || typeof res.url !== "string" || !res.url.startsWith("https://")) {
		throw new ColdtillError(502, "Coldtill returned an unexpected response.");
	}
	return res;
}

export function getPayment(ctx: PluginContext, config: ColdtillConfig, referenceId: string) {
	return request<Payment>(ctx, config, "GET", `/payment/reference/${encodeURIComponent(referenceId)}`);
}

const encoder = new TextEncoder();

/**
 * Verifies X-Coldtill-Signature-V2: "sha256=" + hex(HMAC-SHA256(secret, timestamp + "." + rawBody)).
 * Rejects timestamps more than 300 seconds from now. crypto.subtle.verify
 * compares in constant time.
 */
export async function verifySignature(
	rawBody: Uint8Array,
	signature: string | undefined,
	timestamp: string | undefined,
	secret: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	if (!secret || !signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;

	const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signature.trim());
	if (!match) return false;
	const hex = match[1]!;
	const mac = new Uint8Array(32);
	for (let i = 0; i < 32; i++) mac[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

	const prefix = encoder.encode(`${timestamp}.`);
	const message = new Uint8Array(prefix.length + rawBody.length);
	message.set(prefix);
	message.set(rawBody, prefix.length);

	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, mac, message);
}
