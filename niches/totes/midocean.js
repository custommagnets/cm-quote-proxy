// Midocean Brands API client. Key comes from MIDOCEAN_API_KEY, header x-Gateway-APIKey.
// products/2.0 and stock/2.0 answer 303 with a signed S3 URL: follow it WITHOUT the key header.

const BASE = 'https://api.midocean.com/gateway/';

async function getJson(path) {
  const key = (process.env.MIDOCEAN_API_KEY || '').trim();
  if (!key) throw new Error('MIDOCEAN_API_KEY is not set');
  const res = await fetch(BASE + path, {
    headers: { 'x-Gateway-APIKey': key, Accept: 'text/json' },
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`Midocean ${path}: redirect without location`);
    const res2 = await fetch(loc); // signed URL, no API key
    if (!res2.ok) throw new Error(`Midocean ${path}: download HTTP ${res2.status}`);
    return res2.json();
  }
  if (!res.ok) throw new Error(`Midocean ${path}: HTTP ${res.status}`);
  return res.json();
}

const cache = new Map();
async function cached(name, path, ttlMs) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = await getJson(path);
  cache.set(name, { at: Date.now(), data });
  return data;
}

const HOUR = 60 * 60 * 1000;
module.exports = {
  getProducts: () => getJson('products/2.0?language=en'), // ~36 MB, whole catalogue only, not cached here
  getPricelist: (ttl = HOUR) => cached('pricelist', 'pricelist/2.0/', ttl),
  getPrintPricelist: (ttl = HOUR) => cached('printpricelist', 'printpricelist/2.0/', ttl),
  getPrintData: () => getJson('printdata/1.0/'), // ~21 MB
  getStock: () => getJson('stock/2.0'),
};
