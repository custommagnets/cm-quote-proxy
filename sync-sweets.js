// Syncs Sweet People's product feed into the Sweets store, with markup applied.
// Triggered daily via a Render Cron Job hitting POST /sync/sweets
//
// As of Jan 2026, Shopify custom apps use Client Credentials Grant instead of a
// static token — this fetches a fresh access token (valid ~24h) at the start of
// each sync run rather than relying on a long-lived SHOPIFY_TOKEN env var.

const SHOPIFY_STORE = "customsweets.myshopify.com";
const CLIENT_ID = process.env.SWEETS_CLIENT_ID;
const CLIENT_SECRET = process.env.SWEETS_CLIENT_SECRET;
const FEED_URL = process.env.SWEETS_FEED_URL;

const pricingConfig = require('./sweets-pricing-config.json');

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
  const data = await res.json();
  if (!res.ok) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

function calculateMarkedUpPricing(supplierPricingArray) {
  return supplierPricingArray.map(tier => {
    const unitPrice = parseFloat(tier.unit_pricing);
    const markedUpUnit = unitPrice * (1 + pricingConfig.flat_markup_pct / 100);
    const markedUpShipping = tier.shipping * (1 + pricingConfig.shipping_markup_pct / 100);
    const finalOrigination = tier.origination + pricingConfig.origination_markup_gbp;
    const finalTotal = (markedUpUnit * tier.value) + markedUpShipping + finalOrigination;

    return {
      value: tier.value,
      measure: tier.measure,
      currency: tier.currency,
      unit_pricing: markedUpUnit.toFixed(2),
      shipping: parseFloat(markedUpShipping.toFixed(2)),
      origination: finalOrigination,
      total: parseFloat(finalTotal.toFixed(2)),
    };
  });
}

async function shopifyGraphQL(token, query, variables) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/graphql.json`, {
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

async function findProductByHandle(token, handle) {
  const query = `
    query($handle: String!) {
      productByHandle(handle: $handle) { id }
    }`;
  const data = await shopifyGraphQL(token, query, { handle });
  return data.productByHandle;
}

function skuToHandle(sku) {
  return `sweet-${sku}`;
}

async function upsertProduct(token, product) {
  const handle = skuToHandle(product.sku);
  const existing = await findProductByHandle(token, handle);
  const markedUpPricing = calculateMarkedUpPricing(product.pricing);

  const input = {
    title: product.title,
    handle,
    descriptionHtml: product.description.replace(/\n/g, "<br>"),
    status: product.discontinued ? "ARCHIVED" : "ACTIVE",
    metafields: [
      {
        namespace: "custom_magnets",
        key: "pricing_table",
        type: "json",
        value: JSON.stringify(markedUpPricing),
      },
    ],
  };

  if (existing) {
    const mutation = `
      mutation($input: ProductInput!) {
        productUpdate(input: $input) { product { id } userErrors { message } }
      }`;
    await shopifyGraphQL(token, mutation, { input: { id: existing.id, ...input } });
    return "updated";
  } else {
    const mutation = `
      mutation($input: ProductInput!) {
        productCreate(input: $input) { product { id } userErrors { message } }
      }`;
    await shopifyGraphQL(token, mutation, { input });
    return "created";
  }
}

async function runSweetsSync() {
  const token = await getAccessToken();

  const res = await fetch(FEED_URL);
  const feed = await res.json();
  const products = Object.values(feed);

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

  console.log(`Sweets sync complete: ${created} created, ${updated} updated, ${failed} failed`);
  return { created, updated, failed, total: products.length };
}

module.exports = { runSweetsSync };