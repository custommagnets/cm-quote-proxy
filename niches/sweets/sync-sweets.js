// Syncs Sweet People's product feed into the Sweets store, with markup applied.
// Triggered daily by GitHub Actions (.github/workflows/sweets-sync.yml)
//
// As of Jan 2026, Shopify custom apps use Client Credentials Grant instead of a
// static token — this fetches a fresh access token (valid ~24h) at the start of
// each sync run rather than relying on a long-lived SHOPIFY_TOKEN env var.

const SHOPIFY_STORE = "xxcyzp-vn.myshopify.com"; // permanent domain (customsweets.myshopify.com is an alias)
const CLIENT_ID = (process.env.SWEETS_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.SWEETS_CLIENT_SECRET || "").trim();
const FEED_URL = (process.env.SWEETS_FEED_URL || "").trim();
// Was 2024-10, long past Shopify's support window. productSet + productOptions
// and productByIdentifier need a current version.
const API_VERSION = "2026-10";

const pricingConfig = require('./sweets-pricing-config.json');
const { excluded_skus } = require('./sweets-excluded-skus.json');
const excludedSkus = new Set(excluded_skus);

async function getAccessToken() {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });
  // Shopify answers bad credentials with an HTML error page, not JSON, so read
  // text and surface the page title (e.g. "Oauth error application_cannot_be_found").
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data.access_token) {
    const title = (text.match(/<title>([^<]*)<\/title>/) || [])[1];
    throw new Error(`Failed to get access token (HTTP ${res.status}): ${title || data.error_description || data.error || text.slice(0, 200)}`
      + ` [client id length ${CLIENT_ID.length}, expected 32]`);
  }
  return data.access_token;
}

// Tier pricing (17 Nov 2026): each pricing tier becomes its own Shopify variant
// (option "Quantity tier", values like "250+") priced at that tier's all-in unit
// price, so Shopify's native checkout charges the tier price directly — no proxy
// or discount-code correction (the old approach never had a Sweets proxy, so
// checkout was blocked). The theme's cart drawer (assets/cm-cart-drawer.js)
// picks the variant by quantity.
//
// Supplier shipping is NOT included in the tier price: delivery is charged once,
// at checkout, via the store's shipping rates (owner decision, 17 Nov 2026 —
// previously it was baked into the table AND charged at checkout).
const TIER_OPTION = "Quantity tier";

// Sliding markup (owner decision 17 Nov 2026, from competitor research on the same
// Sweet People products): competitors add ~50-60% on small orders tapering to
// ~15-35% on large ones, so a flat markup over-prices big B2B orders. Each tier
// uses the markup of the highest markup_tiers band its quantity reaches.
function markupPctFor(qty) {
  const bands = [...pricingConfig.markup_tiers].sort((a, b) => a.min_qty - b.min_qty);
  let pct = bands[0].markup_pct;
  for (const b of bands) if (qty >= b.min_qty) pct = b.markup_pct;
  return pct;
}

function calculateMarkedUpPricing(supplierPricingArray) {
  return supplierPricingArray.map(tier => {
    const unitPrice = parseFloat(tier.unit_pricing);
    const markedUpUnit = unitPrice * (1 + markupPctFor(tier.value) / 100);
    const finalOrigination = tier.origination + pricingConfig.origination_markup_gbp;
    const rawTotal = (markedUpUnit * tier.value) + finalOrigination;
    // Round the per-unit price to the penny first, then derive the total from it,
    // so table total === variant price x quantity === what checkout charges.
    const tierUnit = Math.round((rawTotal / tier.value) * 100) / 100;
    const total = Math.round(tierUnit * tier.value * 100) / 100;

    return {
      value: tier.value,
      measure: tier.measure,
      currency: tier.currency,
      tier_unit: tierUnit.toFixed(2),
      origination: finalOrigination,
      total,
    };
  });
}

function buildPricingTableMetafield(markedUpPricing) {
  return {
    optionLabel: "Quantity",
    options: [
      {
        name: "Standard",
        rows: markedUpPricing.map(tier => [tier.value, tier.total]),
      },
    ],
  };
}

function tierLabel(tier) {
  return `${tier.value}+`;
}

async function shopifyGraphQL(token, query, variables) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

function assertNoUserErrors(userErrors, context) {
  if (userErrors && userErrors.length > 0) {
    throw new Error(`${context}: ${userErrors.map(e => e.message).join('; ')}`);
  }
}

async function findProductByHandle(token, handle) {
  const query = `
    query($handle: String!) {
      productByIdentifier(identifier: { handle: $handle }) {
        id
        variants(first: 50) { edges { node { id title } } }
        media(first: 1) { edges { node { id } } }
      }
    }`;
  const data = await shopifyGraphQL(token, query, { handle });
  return data.productByIdentifier;
}

function skuToHandle(sku, skuId) {
  return sku ? `sweet-${sku}` : `sweet-id-${skuId}`;
}

function normalizeImageUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function buildMediaInputs(product) {
  const urls = new Set();
  const addImage = (img) => {
    const rawUrl = img && (img.original || img.large || {}).url;
    const url = rawUrl && normalizeImageUrl(rawUrl);
    if (url) urls.add(url);
  };

  addImage(product.featured_image);
  Object.values(product.gallery || {}).forEach(addImage);

  return [...urls].map(url => ({
    originalSource: url,
    alt: product.title,
    mediaContentType: "IMAGE",
  }));
}

async function attachMedia(token, productId, media) {
  const mutation = `
    mutation($productId: ID!, $media: [CreateMediaInput!]!) {
      productUpdate(product: { id: $productId }, media: $media) {
        userErrors { message }
      }
    }`;
  const data = await shopifyGraphQL(token, mutation, { productId, media });
  assertNoUserErrors(data.productUpdate.userErrors, 'productUpdate (media)');
}

// Sets the product's options/variants to exactly one variant per pricing tier.
// productSet replaces the variant list wholesale, so existing tier variants are
// matched by title and passed with their id — that keeps variant IDs stable
// across daily runs (customers' carts don't break) instead of delete/recreate.
// Only productOptions + variants are sent: productSet deletes list entries that
// are omitted *from an included list*, so metafields/collections are left out
// entirely and untouched.
async function setTierVariants(token, productId, existingVariants, markedUpPricing) {
  const idByTitle = {};
  (existingVariants || []).forEach(v => { idByTitle[v.title] = v.id; });

  const input = {
    id: productId,
    productOptions: [{
      name: TIER_OPTION,
      values: markedUpPricing.map(tier => ({ name: tierLabel(tier) })),
    }],
    variants: markedUpPricing.map((tier, i) => {
      const label = tierLabel(tier);
      const variant = {
        optionValues: [{ optionName: TIER_OPTION, name: label }],
        price: tier.tier_unit,
        inventoryPolicy: "CONTINUE",
        inventoryItem: { tracked: false },
        taxable: true,
        position: i + 1,
      };
      if (idByTitle[label]) variant.id = idByTitle[label];
      return variant;
    }),
  };

  const mutation = `
    mutation($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id }
        userErrors { field message }
      }
    }`;
  const data = await shopifyGraphQL(token, mutation, { input });
  assertNoUserErrors(data.productSet.userErrors, 'productSet');
}

async function upsertProduct(token, product) {
  const handle = skuToHandle(product.sku, product.sku_id);
  const existing = await findProductByHandle(token, handle);
  const markedUpPricing = calculateMarkedUpPricing(product.pricing)
    .sort((a, b) => a.value - b.value);
  if (!markedUpPricing.length) throw new Error('no pricing tiers in feed');

  const pricingMetafield = {
    namespace: "custom_sweets",
    key: "pricing_table",
    type: "json",
    value: JSON.stringify(buildPricingTableMetafield(markedUpPricing)),
  };
  const productSelection = `product { id variants(first: 50) { edges { node { id title } } } }`;

  let productId, existingVariants, result;
  if (existing) {
    // Only pricing is supplier-driven after creation. Title, handle,
    // description, and status are left alone here so manual content
    // optimisations and manual archive/discontinue decisions in Shopify
    // Admin survive future syncs — the supplier feed no longer gets to
    // hide a product; that's a human call.
    const input = { id: existing.id, metafields: [pricingMetafield] };
    const mutation = `
      mutation($input: ProductUpdateInput!) {
        productUpdate(product: $input) { ${productSelection} userErrors { message } }
      }`;
    const data = await shopifyGraphQL(token, mutation, { input });
    assertNoUserErrors(data.productUpdate.userErrors, 'productUpdate');
    productId = data.productUpdate.product.id;
    existingVariants = data.productUpdate.product.variants.edges.map(e => e.node);
    result = "updated";
  } else {
    const input = {
      title: product.title,
      handle,
      descriptionHtml: product.description.replace(/\n/g, "<br>"),
      status: product.discontinued ? "ARCHIVED" : "ACTIVE",
      metafields: [pricingMetafield],
    };
    const mutation = `
      mutation($input: ProductCreateInput!) {
        productCreate(product: $input) { ${productSelection} userErrors { message } }
      }`;
    const data = await shopifyGraphQL(token, mutation, { input });
    assertNoUserErrors(data.productCreate.userErrors, 'productCreate');
    productId = data.productCreate.product.id;
    existingVariants = data.productCreate.product.variants.edges.map(e => e.node);
    result = "created";
  }

  await setTierVariants(token, productId, existingVariants, markedUpPricing);

  const hasExistingMedia = existing && existing.media.edges.length > 0;
  if (!hasExistingMedia) {
    const mediaInputs = buildMediaInputs(product);
    if (mediaInputs.length > 0) {
      await attachMedia(token, productId, mediaInputs);
    }
  }

  return result;
}

async function runSync() {
  const token = await getAccessToken();

  const res = await fetch(FEED_URL);
  const feed = await res.json();
  const products = Object.values(feed).filter(product => !excludedSkus.has(product.sku));
  const skipped = Object.values(feed).length - products.length;

  let created = 0, updated = 0, failed = 0;

  for (const product of products) {
    try {
      const result = await upsertProduct(token, product);
      if (result === "created") created++;
      else updated++;
    } catch (err) {
      failed++;
      console.error(`Sync failed for SKU ${product.sku}:`, err.message);
    }
  }

  console.log(`Sweets sync complete: ${created} created, ${updated} updated, ${failed} failed, ${skipped} excluded`);
  return { created, updated, failed, skipped, total: products.length };
}

module.exports = { runSync };
