import { pluginRoute, type SandboxedPlugin } from "emdash/plugin";

import { admin } from "./admin.js";
import { checkout, getProductCollection, verify } from "./checkout.js";
import { WEBHOOK_HEADERS, webhook } from "./webhook.js";

const plugin: SandboxedPlugin = {
	routes: {
		/** Block Kit handler for the "Coldtill orders" admin page. */
		admin: pluginRoute({
			methods: ["POST"],
			request: { body: "json" },
			handler: admin,
		}),

		/** Storefront: tells the site which collection holds products. */
		config: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			handler: async (_routeCtx, ctx) => ({ productCollection: await getProductCollection(ctx) }),
		}),

		/** Storefront: { productId, quantity?, email?, returnPath? } -> { ok, orderId, checkoutUrl }. */
		checkout: pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 4096 },
			handler: checkout,
		}),

		/** Storefront: { orderId } -> { ok, status, paid }, re-checking Coldtill if the order is open. */
		verify: pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 1024 },
			handler: verify,
		}),

		/** Coldtill webhook endpoint. */
		webhook: pluginRoute({
			public: true,
			methods: ["POST"],
			response: "raw",
			request: { body: "bytes", maxBytes: 65536, headers: WEBHOOK_HEADERS },
			handler: webhook,
		}),
	},
};

export default plugin;
