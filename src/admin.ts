import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { normalizeBaseUrl } from "./coldtill.js";
import { getProductCollection } from "./checkout.js";
import { formatUsd, type Order } from "./orders.js";

const PAGE_SIZE = 25;

/** Private route that renders the "Coldtill orders" page. */
export async function admin(routeCtx: { input: unknown }, ctx: PluginContext): Promise<BlockResponse> {
	const interaction = routeCtx.input as { type?: unknown; action_id?: unknown; value?: unknown } | null;
	let cursor: string | undefined;
	if (interaction?.type === "block_action" && interaction.action_id === "orders_page") {
		const value = interaction.value as { cursor?: unknown } | undefined;
		if (typeof value?.cursor === "string") cursor = value.cursor;
	}
	return renderOrdersPage(ctx, cursor);
}

async function renderOrdersPage(ctx: PluginContext, cursor?: string): Promise<BlockResponse> {
	const orders = ctx.storage.orders!;
	const [rawUrl, apiKey, webhookSecret, collection, page, paid, open] = await Promise.all([
		ctx.settings.get<string>("coldtillUrl"),
		ctx.settings.get<string>("apiKey"),
		ctx.settings.get<string>("webhookSecret"),
		getProductCollection(ctx),
		orders.query({ orderBy: { createdAt: "desc" }, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
		orders.count({ status: "paid" }),
		orders.count({ status: { in: ["pending", "partial"] } }),
	]);
	const baseUrl = normalizeBaseUrl(rawUrl);
	const apiBase = ctx.url(`/_emdash/api/plugins/${ctx.plugin.id}`);

	const missing: string[] = [];
	if (!rawUrl) missing.push("the Coldtill URL");
	else if (!baseUrl) missing.push("an https Coldtill URL");
	if (!apiKey) missing.push("the API key");
	if (!webhookSecret) missing.push("the webhook signing secret");

	const blocks: Block[] = [{ type: "header", text: "Coldtill orders" }];

	if (missing.length > 0) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Finish setting up Coldtill",
			description: `Add ${missing.join(", ")} in the plugin settings. In Coldtill → Webhooks, add the webhook URL below and paste its signing secret.`,
		});
	}

	blocks.push(
		{
			type: "fields",
			fields: [
				{ label: "Coldtill URL", value: baseUrl ?? "Not set" },
				{ label: "API key", value: apiKey ? "Saved" : "Not set" },
				{ label: "Webhook secret", value: webhookSecret ? "Saved" : "Not set" },
				{ label: "Product collection", value: collection },
				{ label: "Webhook URL", value: `${apiBase}/webhook` },
				{ label: "Storefront API base", value: apiBase },
			],
		},
		{
			type: "actions",
			elements: [
				{ type: "link", label: "Plugin settings", target: { kind: "plugin-settings" }, appearance: "primary" },
				...(baseUrl
					? [{ type: "link" as const, label: "Open Coldtill", target: { kind: "external" as const, url: baseUrl } }]
					: []),
				{
					type: "link",
					label: "Setup guide",
					target: { kind: "external", url: "https://github.com/Coldtill/emdash-crypto-payment-gateway#readme" },
				},
			],
		},
		{
			type: "stats",
			items: [
				{ label: "Paid orders", value: paid },
				{ label: "Awaiting payment", value: open },
			],
		},
		{ type: "divider" },
		{
			type: "table",
			block_id: "orders",
			page_action_id: "orders_page",
			empty_text: "No orders yet.",
			columns: [
				{ key: "order", label: "Order", format: "code" },
				{ key: "product", label: "Product" },
				{ key: "quantity", label: "Qty", format: "number" },
				{ key: "amount", label: "Amount" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "customer", label: "Customer" },
				{ key: "created", label: "Created", format: "relative_time" },
				{ key: "reference", label: "Coldtill reference", format: "code" },
				{ key: "note", label: "Note" },
			],
			rows: page.items.map(({ data }) => {
				const order = data as Order;
				return {
					order: order.id,
					product: order.productName,
					quantity: order.quantity,
					amount: formatUsd(order.amountCents),
					status: order.status,
					customer: order.customerEmail ?? "",
					created: order.createdAt,
					reference: order.coldtillReference,
					note: order.note ?? "",
				};
			}),
			...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
		},
		{
			type: "context",
			text: "Orders update from Coldtill webhooks and when the buyer returns to your site. Refunds are sent from your own wallet.",
		},
	);

	return { blocks };
}
