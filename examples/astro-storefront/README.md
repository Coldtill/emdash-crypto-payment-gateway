# Astro storefront example

Two pages for an Astro-based EmDash site that sell products through the Coldtill plugin:

- `/products/` lists published products, each with a **Buy with crypto** button.
- `/products/[slug]` shows one product with quantity and email fields, and checks the payment when the buyer
  comes back from Coldtill.

## Files

- `src/lib/coldtill.ts`: the plugin's API base, the product fields, and a helper that reads the product
  collection from the plugin.
- `src/pages/products/index.astro`
- `src/pages/products/[slug].astro`

## Install

1. Install the Coldtill plugin and finish its setup (see the main [README](../../README.md)).
2. Copy `src/lib/coldtill.ts` and the two pages into your site.
3. Copy the plugin's [`src/storefront/index.ts`](../../src/storefront/index.ts) to
   `src/lib/coldtill-storefront.ts`. It is one file with no dependencies.
4. Check the **Storefront API base** on the plugin's **Coldtill orders** page. If it isn't
   `/_emdash/api/plugins/r_iq46b5ezsks5zhaf`, set `COLDTILL_API_BASE` to it (or edit `COLDTILL_API`).
5. Start your dev server and open `/products/`.

Products need a number field named `price` (USD). Optional fields the pages use: `name` or `title`, `slug`,
`description`, `image`, and a boolean `active` (a product with `active` off can't be bought).

## How the buyer's return works

The checkout route stores an order and returns the Coldtill checkout URL; the button sends the buyer there.
After paying, Coldtill's **Return to store** button opens the product page with `?coldtill_order=<id>`, and the
page calls `verifyCheckout`, which re-checks the payment with Coldtill if the webhook hasn't arrived yet.

The message on that page is for the buyer only. Fulfil orders from the **Coldtill orders** admin page (or the
plugin's order storage), which only changes on a verified webhook or a server-side check with Coldtill.

The return button needs your site on `https`. If your Coldtill project limits **Allowed return hosts**, add your
site's host there, or the checkout falls back to the project's own Return URL.
