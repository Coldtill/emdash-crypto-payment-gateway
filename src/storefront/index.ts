/**
 * Browser helpers for the Coldtill EmDash plugin. One file with no
 * dependencies: copy it into your site.
 *
 * apiBase is "/_emdash/api/plugins/<plugin id>". The Coldtill orders admin
 * page shows it as "Storefront API base".
 */

export interface CheckoutOptions {
	apiBase: string;
	productId: string;
	quantity?: number;
	email?: string;
	/** Same-site path the Coldtill "Return to store" button opens. Defaults to the current page. */
	returnPath?: string;
}

export interface VerifyOptions {
	apiBase: string;
	/** Defaults to the coldtill_order query parameter of the current URL. */
	orderId?: string;
}

export interface VerifyResult {
	orderId: string;
	status: "pending" | "partial" | "paid" | "cancelled";
	paid: boolean;
}

// Route results arrive in EmDash's envelope: { success, data } where data is { ok, ... }.
async function callRoute<T>(apiBase: string, route: string, body: unknown): Promise<T> {
	const res = await fetch(`${apiBase.replace(/\/+$/, "")}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json().catch(() => null)) as {
		success?: boolean;
		data?: { ok?: boolean; error?: string } & T;
		error?: string | { message?: string };
	} | null;
	if (!res.ok || !json?.success || !json.data?.ok) {
		const err = json?.data?.error ?? (typeof json?.error === "string" ? json.error : json?.error?.message);
		throw new Error(err || "Request failed.");
	}
	return json.data;
}

/** Creates an order and returns the Coldtill checkout URL to send the buyer to. */
export async function startCheckout(options: CheckoutOptions): Promise<string> {
	const { apiBase, productId, quantity, email, returnPath } = options;
	if (!apiBase || !productId) throw new Error("apiBase and productId are required.");
	const result = await callRoute<{ checkoutUrl: string }>(apiBase, "checkout", {
		productId,
		quantity,
		email,
		returnPath: returnPath ?? window.location.pathname,
	});
	return result.checkoutUrl;
}

/**
 * Wires up every <button data-coldtill-checkout data-product-id="..."
 * data-checkout-api="..."> under root. Optional: data-quantity,
 * data-return-path (defaults to the current page) and
 * data-email-input="#selector" to read an email field.
 */
export function initializeCheckoutButtons(root: ParentNode = document): void {
	for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-coldtill-checkout]")) {
		if (button.dataset.coldtillReady === "true") continue;
		button.dataset.coldtillReady = "true";

		button.addEventListener("click", async () => {
			const { checkoutApi, productId, quantity, emailInput, returnPath } = button.dataset;
			if (!checkoutApi || !productId) {
				console.error("Coldtill: data-checkout-api and data-product-id are required.");
				return;
			}
			const email = emailInput ? root.querySelector<HTMLInputElement>(emailInput)?.value || undefined : undefined;
			const label = button.textContent;
			button.disabled = true;
			button.textContent = "Loading...";
			try {
				const url = await startCheckout({
					apiBase: checkoutApi,
					productId,
					quantity: quantity ? Number(quantity) : undefined,
					email,
					returnPath,
				});
				window.location.assign(url);
			} catch (error) {
				console.error("Coldtill checkout error:", error);
				button.disabled = false;
				button.textContent = label;
				button.dispatchEvent(new CustomEvent("coldtill:error", { detail: error, bubbles: true }));
			}
		});
	}
}

/**
 * Asks the plugin for the order's status, re-checking Coldtill if it's still
 * open. Use it to show a message to the buyer; fulfil orders from the admin
 * page or the plugin's storage, never from the visit to the return page.
 */
export async function verifyCheckout(options: VerifyOptions): Promise<VerifyResult | null> {
	const orderId = options.orderId ?? new URL(window.location.href).searchParams.get("coldtill_order");
	if (!orderId) return null;
	return callRoute<VerifyResult>(options.apiBase, "verify", { orderId });
}
