import type { ImageValue } from "emdash";

/**
 * Where the plugin's routes live: /_emdash/api/plugins/<plugin id>.
 *
 * - Installed from the EmDash registry: the id is derived from the publisher
 *   DID and slug, "r_iq46b5ezsks5zhaf" for the official Coldtill plugin.
 * - Added to astro.config as a local sandboxed plugin: the id is "coldtill".
 *
 * The plugin's "Coldtill orders" admin page shows the exact value as
 * "Storefront API base"; set COLDTILL_API_BASE if yours differs.
 */
export const COLDTILL_API =
  import.meta.env.COLDTILL_API_BASE ?? "/_emdash/api/plugins/r_iq46b5ezsks5zhaf";

/** Fields the plugin reads from a product entry. */
export interface ProductData {
  /** Content id; the plugin looks the product up by it. */
  id: string;
  slug?: string;
  name?: string;
  title?: string;
  /** USD, for example 25 or 19.99. */
  price: number;
  active?: boolean | number;
  description?: string;
  image?: ImageValue | null;
  [key: string]: unknown;
}

/** Reads the product collection slug from the plugin's public config route. */
export async function getProductCollection(siteOrigin: string): Promise<string> {
  const res = await fetch(`${siteOrigin}${COLDTILL_API}/config`);
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: { productCollection?: string };
  } | null;
  return json?.success && json.data?.productCollection ? json.data.productCollection : "products";
}

export function isBuyable(data: ProductData): boolean {
  return data.active !== false && data.active !== 0 && typeof data.price === "number" && data.price > 0;
}

export const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
