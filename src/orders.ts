import type { PluginContext } from "emdash/plugin";

import type { PaymentState } from "./coldtill.js";

/**
 * pending: waiting for payment.
 * partial: part of the money arrived; waiting for the rest.
 * paid: Coldtill reported FILLED or OVER_FILLED for the right amount.
 * cancelled: the payment expired or was replaced before anything arrived.
 */
export type OrderStatus = "pending" | "partial" | "paid" | "cancelled";

export interface Order {
	id: string;
	coldtillReference: string;
	checkoutUrl: string;
	productId: string;
	productName: string;
	quantity: number;
	unitAmountCents: number;
	amountCents: number;
	currency: "USD";
	status: OrderStatus;
	/** Last Coldtill payment state seen. */
	coldtillState: PaymentState;
	customerEmail: string | null;
	txHash: string | null;
	/** Something the merchant should look at, such as an amount mismatch. */
	note: string | null;
	createdAt: string;
	updatedAt: string;
	paidAt: string | null;
}

/** Parses a USD decimal string ("25", "25.00000000") into whole cents. */
export function toCents(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) return null;
	return Math.round(n * 100);
}

export function formatUsd(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Applies a Coldtill payment state to an order, following the WooCommerce
 * gateway: only a matching amount can mark it paid, a partial payment holds
 * it, and a cancelled or replaced payment cancels it unless money arrived.
 * A full payment wins over an earlier cancellation, since the money is real.
 *
 * Each branch makes at most one conditional write, guarded on the status the
 * transition starts from, so duplicate or concurrent deliveries apply once.
 * Returns the order's status afterwards (as far as this call knows).
 */
export async function applyPaymentState(
	ctx: PluginContext,
	order: Order,
	state: PaymentState | undefined,
	amount: unknown,
	txHash: string | null,
): Promise<OrderStatus> {
	if (order.status === "paid") return "paid";
	const now = new Date().toISOString();

	// Compared in cents with a one-cent tolerance; floats make 25.00 - 24.99 a hair over 0.01.
	const cents = toCents(amount);
	if (cents === null || Math.abs(cents - order.amountCents) > 1) {
		const note = `Coldtill amount ${typeof amount === "string" ? amount : "(missing)"} USD does not match the order total of ${formatUsd(order.amountCents)}; status not changed.`;
		ctx.log.warn("Coldtill amount does not match the order", { orderId: order.id, amount: String(amount) });
		if (order.note !== note) {
			await ctx.storage.orders!.updateIf(order.id, {
				where: { status: order.status },
				set: { note, updatedAt: now },
			});
		}
		return order.status;
	}

	switch (state) {
		case "FILLED":
		case "OVER_FILLED": {
			const result = await ctx.storage.orders!.updateIf(order.id, {
				where: { status: { in: ["pending", "partial", "cancelled"] }, coldtillReference: order.coldtillReference },
				set: {
					status: "paid",
					coldtillState: state,
					paidAt: now,
					updatedAt: now,
					txHash: txHash || order.txHash,
					note: state === "OVER_FILLED" ? "Overpaid; refund the difference from your wallet if needed." : null,
				},
			});
			if (result.applied) {
				ctx.log.info("Coldtill order paid", { orderId: order.id });
				return "paid";
			}
			// Another delivery changed the order first; report what it is now.
			const current = (await ctx.storage.orders!.get(order.id)) as Order | null;
			return current?.status ?? order.status;
		}
		case "PARTIALLY_FILLED": {
			if (order.status !== "pending") return order.status;
			const result = await ctx.storage.orders!.updateIf(order.id, {
				where: { status: "pending" },
				set: { status: "partial", coldtillState: state, updatedAt: now },
			});
			return result.applied ? "partial" : order.status;
		}
		case "CANCELLED":
		case "REPLACED": {
			if (order.status === "partial") {
				// Part of the money arrived, so a person has to settle this order.
				const note = `Coldtill payment ${state.toLowerCase()} after a partial payment; check the amount received in Coldtill and settle this order by hand.`;
				if (order.note !== note) {
					await ctx.storage.orders!.updateIf(order.id, {
						where: { status: "partial" },
						set: { coldtillState: state, note, updatedAt: now },
					});
				}
				return "partial";
			}
			const result = await ctx.storage.orders!.updateIf(order.id, {
				where: { status: "pending" },
				set: { status: "cancelled", coldtillState: state, updatedAt: now },
			});
			return result.applied ? "cancelled" : order.status;
		}
		default:
			// OPEN or unknown: nothing to do yet.
			return order.status;
	}
}
