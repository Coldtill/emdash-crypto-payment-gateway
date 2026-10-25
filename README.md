# EmDash crypto payment gateway: Coldtill for EmDash

**Sell products from your EmDash site for USDT, USDC, Bitcoin, Ethereum, Solana, Tron and 200+ coins, straight to
your own wallets.** No sign-up, no KYB, no custody and no processor that can freeze your money.

This sandboxed plugin connects your [EmDash](https://emdashcms.com) site to [Coldtill](https://coldtill.com), a
[self-hosted crypto payment gateway](https://github.com/Coldtill/self-hosted-crypto-payment-gateway) that runs on
your own server.

[Coldtill](https://coldtill.com) · [Docs](https://coldtill.com/docs/) · [Live demo dashboard](https://demo.coldtill.com/)

![Coldtill checkout: choose a network and coin, then scan the QR code](https://coldtill.com/img/checkout-pay.webp)

## Features

- **200+ coins on 35+ chains.** BTC, ETH, SOL, TRX, BNB, POL, USDT and USDC directly, and XRP, TON, Sui, Cardano,
  Dogecoin and more through auto-convert, settled to you as USDC or USDT.
- **Self-custody.** On Ethereum, Base, Polygon, BNB Chain, Tron and Solana each customer pays into a deposit contract
  that can only send to your cold wallet. Bitcoin goes to your own wallet's addresses.
- **Products from your content.** Products are entries in an EmDash collection with a USD `price` field. The plugin
  reads the price on the server; a price sent by the browser is ignored.
- **Signed webhooks** (HMAC-SHA256 with a timestamp and a five-minute replay window). Orders update automatically,
  a repeated delivery never changes an order twice, and orders are re-checked when the buyer returns to your site
  if a webhook is missed.
- **Safe by default.** An order only changes when the Coldtill reference and amount match; partial payments are held
  for you to settle and overpayments are noted.
- **Orders page** in the EmDash admin, plus storefront helpers and an [Astro example](examples/astro-storefront).

## Requirements

- EmDash with sandboxed plugins enabled, and `EMDASH_ENCRYPTION_KEY` set so the API key and webhook secret are stored
  encrypted.
- Prices in USD.
- A running Coldtill server reachable over **public `https`**. The Free edition installs with one command:

```bash
curl -fsSL https://coldtill.com/install.sh | sudo bash -s -- --edition free
```

## Install

In the EmDash admin, open **Plugins**, search the registry for **Coldtill Crypto Payments** and install it. EmDash
asks you to approve its access:

- **Read content**, to read product names and prices.
- **Network access to any host**, because every merchant's Coldtill runs on a different domain. The plugin only
  calls the Coldtill URL you enter.
- **Public routes** for checkout, payment checks and the Coldtill webhook.

## Setup

1. In Coldtill, create a project API key under **API keys** and copy it.
2. In EmDash, open the plugin's settings and enter:
   - **Coldtill URL**, for example `https://pay.example.com` (include the path if Coldtill runs under one);
   - **API key**;
   - **Product collection**, if your products aren't in a collection called `products`.
3. Open **Coldtill orders** in the admin sidebar and copy the **Webhook URL**
   (`https://your-site/_emdash/api/plugins/<plugin id>/webhook`).
4. In Coldtill → **Webhooks**, add that URL and paste its signing secret into the plugin's **Webhook signing secret**
   setting. Use **Send test** in Coldtill to check delivery.
5. Make sure each product has a number field named `price` holding the USD price. Optional fields: `name` or
   `title`, and a boolean `active` (products with `active` off can't be bought). If a product has a `currency` field,
   it must be `USD`.

## Storefront usage

The plugin's routes live under `/_emdash/api/plugins/<plugin id>/`. For a registry install the plugin id is
`r_iq46b5ezsks5zhaf`; the **Coldtill orders** page shows the exact **Storefront API base** for your site.

The helpers are one file with no dependencies, [`src/storefront/index.ts`](src/storefront/index.ts). Copy it into
your site (the [Astro example](examples/astro-storefront) uses `src/lib/coldtill-storefront.ts`).

A Buy button:

```html
<button
  data-coldtill-checkout
  data-product-id="PRODUCT_CONTENT_ID"
  data-checkout-api="/_emdash/api/plugins/r_iq46b5ezsks5zhaf"
>Buy with crypto</button>

<script type="module">
  import { initializeCheckoutButtons } from "./coldtill-storefront.js";
  initializeCheckoutButtons();
</script>
```

Optional attributes: `data-quantity`, `data-return-path` (the page the buyer comes back to; defaults to the current
page) and `data-email-input="#email"` to send the buyer's email to Coldtill.

Or call the helpers yourself:

```ts
import { startCheckout, verifyCheckout } from "./coldtill-storefront";

const apiBase = "/_emdash/api/plugins/r_iq46b5ezsks5zhaf";
window.location.assign(await startCheckout({ apiBase, productId, quantity: 2 }));

// On the page the buyer returns to (it carries ?coldtill_order=...):
const result = await verifyCheckout({ apiBase }); // { orderId, status, paid } or null
```

After paying, Coldtill's **Return to store** button opens your page with `?coldtill_order=<id>`; `verifyCheckout`
re-checks the payment with Coldtill if the webhook hasn't arrived yet. Use it for the message you show the buyer.
Fulfil orders from the **Coldtill orders** page, never from a visit to the return page, which anyone can open.

### Routes

| Route | Access | Purpose |
|---|---|---|
| `POST checkout` | public | `{ productId, quantity?, email?, returnPath? }` → `{ ok, orderId, checkoutUrl }` |
| `POST verify` | public | `{ orderId }` → `{ ok, orderId, status, paid }` |
| `GET config` | public | `{ productCollection }` |
| `POST webhook` | public | Coldtill webhooks (signature checked) |
| `POST admin` | admin | The **Coldtill orders** page |

JSON routes answer in EmDash's envelope, `{ "success": true, "data": { ... } }`. Expected errors come back as
`data: { ok: false, code, error }`.

## Order statuses

| Coldtill payment | Order |
|---|---|
| Filled or overpaid, for the order amount (within 1 cent) | Paid |
| Partially paid | Partial (held) |
| Cancelled or replaced, nothing received | Cancelled |
| Cancelled or replaced after a partial payment | Partial, with a note to settle by hand |
| Amount doesn't match the order | Unchanged, with a note |

A full payment that arrives after a cancellation still marks the order paid, since the money is in your wallet.

## Limits

- **USD only.** Product prices are read as US dollars.
- **No automatic refunds.** Coldtill has no refund API; send refunds from your own wallet.
- **Coldtill must be reachable over public `https`.** EmDash's sandbox blocks requests to `localhost` and private
  addresses even with unrestricted network access, so a Coldtill on your laptop or LAN won't work. Put it on a public
  host name with a TLS certificate.
- **The return button needs your site on `https`.** If your Coldtill project limits **Allowed return hosts**, add
  your site's host; otherwise the plugin falls back to the project's own Return URL.
- One product per order, quantity 1 to 100.

## Security

- The API key and webhook secret are `secret` settings, encrypted by EmDash and never shown in the admin.
- Webhooks are verified with `X-Coldtill-Signature-V2` (or the older `X-Keyhold-*` headers), rejected if older than
  five minutes, and compared in constant time.
- Order changes are conditional writes, so duplicate or concurrent deliveries apply once.

Report vulnerabilities to [security@coldtill.com](mailto:security@coldtill.com). See
[coldtill.com/security](https://coldtill.com/security).

## Development

```bash
pnpm install
pnpm test        # validate the manifest and run the sandbox tests
pnpm typecheck
pnpm build
pnpm bundle      # dist/coldtill-<version>.tar.gz
```

Publishing steps are in [PUBLISHING.md](PUBLISHING.md).

## Licence

MIT. See [LICENSE](LICENSE).
