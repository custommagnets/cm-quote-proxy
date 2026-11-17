// Read-only health check for the Sweets sync. Writes NOTHING to Shopify.
// Checks each thing the sync depends on, in order, and stops at the first failure.
// Never prints secrets.
//
// Usage (from this folder, with the same env vars Render has):
//   SWEETS_CLIENT_ID=... SWEETS_CLIENT_SECRET=... SWEETS_FEED_URL=... node diagnose-sync.js

const STORE = "xxcyzp-vn.myshopify.com";
const API_VERSION = "2026-10";

function ok(msg) { console.log("  OK   " + msg); }
function fail(msg) { console.log("  FAIL " + msg); process.exit(1); }

(async () => {
  console.log("1. Env vars");
  for (const k of ["SWEETS_CLIENT_ID", "SWEETS_CLIENT_SECRET", "SWEETS_FEED_URL"]) {
    if (!process.env[k]) fail(k + " is not set");
  }
  ok("all three set");

  console.log("2. Shopify access token (client credentials)");
  let token;
  try {
    const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.SWEETS_CLIENT_ID,
        client_secret: process.env.SWEETS_CLIENT_SECRET,
      }),
    });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch {}
    if (!res.ok || !data.access_token) {
      fail(`HTTP ${res.status}: ${(data.error_description || data.error || text).toString().slice(0, 200)}`
        + "\n       -> app uninstalled, secret rotated, or client credentials not enabled for this app");
    }
    token = data.access_token;
    ok("token issued, scopes: " + (data.scope || "(not reported)"));
  } catch (e) { fail("network error: " + e.message); }

  console.log("3. Admin API read");
  try {
    const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: "{ shop { name myshopifyDomain } productsCount { count } }" }),
    });
    const data = await res.json();
    if (data.errors) fail(JSON.stringify(data.errors).slice(0, 300));
    ok(`connected to "${data.data.shop.name}" (${data.data.shop.myshopifyDomain}), ${data.data.productsCount.count} products`);
    if (data.data.shop.name !== "Custom Sweets") fail("token is for the WRONG store");
  } catch (e) { fail("error: " + e.message); }

  console.log("4. Supplier feed");
  try {
    const res = await fetch(process.env.SWEETS_FEED_URL);
    const text = await res.text();
    if (!res.ok) fail(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let feed; try { feed = JSON.parse(text); } catch { fail("feed is not JSON: " + text.slice(0, 200)); }
    const products = Object.values(feed);
    if (!products.length) fail("feed parsed but contains 0 products");
    const sample = products[0];
    const hasPricing = Array.isArray(sample.pricing) && sample.pricing.length > 0;
    ok(`${products.length} products in feed; first has sku=${sample.sku}, pricing tiers=${hasPricing ? sample.pricing.length : "MISSING"}`);
    if (!hasPricing) fail("feed shape changed: no pricing array on products");
  } catch (e) { fail("error: " + e.message); }

  console.log("\nAll checks passed: credentials, store and feed are fine.");
  console.log("If the sync still isn't running, the problem is the Render cron job itself (suspended, failing to start, or billing).");
})();
