// Shopify Admin access for the Brand My Tote store (Client Credentials Grant, ~24h tokens).

const API_VERSION = '2026-10';
let tokenCache = { token: null, at: 0 };

function store() {
  const s = (process.env.TOTES_SHOPIFY_STORE || '').trim();
  if (!s) throw new Error('TOTES_SHOPIFY_STORE is not set');
  return s;
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() - tokenCache.at < 20 * 60 * 60 * 1000) return tokenCache.token;
  const id = (process.env.TOTES_CLIENT_ID || '').trim();
  const secret = (process.env.TOTES_CLIENT_SECRET || '').trim();
  const res = await fetch(`https://${store()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data.access_token) {
    const title = (text.match(/<title>([^<]*)<\/title>/) || [])[1];
    throw new Error(`Shopify token (HTTP ${res.status}): ${title || data.error_description || data.error || text.slice(0, 200)}`);
  }
  tokenCache = { token: data.access_token, at: Date.now() };
  return data.access_token;
}

async function graphql(query, variables) {
  const token = await getAccessToken();
  const res = await fetch(`https://${store()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

function assertNoUserErrors(userErrors, context) {
  if (userErrors && userErrors.length) throw new Error(`${context}: ${userErrors.map(e => e.message).join('; ')}`);
}

module.exports = { graphql, assertNoUserErrors, getAccessToken };
