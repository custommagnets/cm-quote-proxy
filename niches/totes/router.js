// Brand My Tote pricing + checkout endpoints, mounted at /totes (one line in index.js).
//
//   POST /totes/price     read-only quote for any technique / colours / positions
//   POST /totes/checkout  server-priced draft order, returns the invoice (pay) URL. Fails closed.
//
// Why a draft order and not a discount code: configured prints cost MORE than the native variant
// price, and a discount code can only lower a price. See CLAUDE.md in this folder.
// Nothing here has been run against Shopify yet (no store existed on 24 Nov 2026).

const express = require('express');
const rateLimit = require('express-rate-limit');
const midocean = require('./midocean');
const { graphql, assertNoUserErrors } = require('./shopify');
const { config, num, priceLine, oldSitePrice } = require('./pricing');

const router = express.Router();

const ORIGINS = (process.env.TOTES_ALLOWED_ORIGINS || 'https://brandmytote.com,https://www.brandmytote.com')
  .split(',').map(s => s.trim()).filter(Boolean);
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
router.use(express.json({ limit: '100kb' }));

const limiter = (max) => rateLimit({
  windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

class Refusal extends Error { constructor(status, message) { super(message); this.status = status; } }

async function loadProduct(handle) {
  const data = await graphql(`
    query($handle: String!) {
      productByIdentifier(identifier: { handle: $handle }) {
        title
        status
        printOptions: metafield(namespace: "custom_totes", key: "print_options") { value }
        variants(first: 250) { edges { node { sku title } } }
      }
    }`, { handle });
  const p = data.productByIdentifier;
  if (!p || !p.printOptions) throw new Refusal(404, 'Unknown product');
  const baseSkus = new Set(p.variants.edges.map(e => String(e.node.sku || '').replace(/-Q\d+$/, '')).filter(Boolean));
  return { title: p.title, print: JSON.parse(p.printOptions.value), baseSkus };
}

// The default print for a product, from its stored print_options (same rule as the sync): full colour digital
// transfer at a FRONT position, else screen print at FRONT, else the product's own default technique.
function defaultOption(print) {
  const ps = print.positions || [];
  for (const p of ps.filter(x => String(x.id).startsWith(config.default_position))) {
    if (p.techniques.some(t => t.id === config.default_technique)) return { pos: p.id, tech: config.default_technique };
  }
  const p = ps.find(x => x.id === config.default_position) || ps[0];
  if (!p) return null;
  const t = p.techniques.find(x => config.screen_technique_ids.includes(x.id) && !x.id.startsWith('ST')) || p.techniques.find(x => x.default) || p.techniques[0];
  return t ? { pos: p.id, tech: t.id } : null;
}

// Validates one requested line against what the product really offers and prices it.
async function priceRequestedLine(line) {
  const qty = parseInt(line.quantity, 10);
  if (!line.handle || !line.sku || !qty) throw new Refusal(400, 'handle, sku and quantity are required');
  if (qty < config.min_order_qty) throw new Refusal(422, `Minimum order is ${config.min_order_qty}`);
  if (qty > config.max_order_qty) throw new Refusal(422, 'Quantity too large for online pricing, please enquire');

  const product = await loadProduct(String(line.handle));
  if (!product.baseSkus.has(line.sku)) throw new Refusal(422, 'That colour is not available for this product');

  const wanted = Array.isArray(line.positions) && line.positions.length ? line.positions : [config.default_position];
  const positions = [...new Set(wanted.map(String))];
  const techId = String(line.technique || config.default_technique);
  const colours = parseInt(line.colours || config.default_colours, 10);
  if (!(colours >= 1)) throw new Refusal(422, 'Invalid colour count');

  let maxColours = Infinity, maxAreaCm2 = Infinity;
  for (const pid of positions) {
    const pos = product.print.positions.find(p => p.id === pid);
    if (!pos) throw new Refusal(422, `Print position ${pid} is not available`);
    const t = pos.techniques.find(x => x.id === techId);
    if (!t) throw new Refusal(422, `${techId} is not available at position ${pid}`);
    if (t.max_colours) maxColours = Math.min(maxColours, t.max_colours);
    if (pos.w && pos.h) maxAreaCm2 = Math.min(maxAreaCm2, (pos.unit === 'mm' ? (pos.w * pos.h) / 100 : pos.w * pos.h));
  }
  if (colours > maxColours) throw new Refusal(422, `This print option allows up to ${maxColours} colours`);
  const areaCm2 = Number(line.area_cm2) || 0;
  if (areaCm2 > maxAreaCm2) throw new Refusal(422, 'Logo area is larger than the print area');

  const [pricelist, printPricelist] = await Promise.all([midocean.getPricelist(), midocean.getPrintPricelist()]);
  const blankRow = pricelist.price.find(p => p.sku === line.sku);
  const tech = printPricelist.print_techniques.find(t => t.id === techId);
  if (!blankRow || !tech) throw new Refusal(422, 'Could not find supplier pricing for this option');
  if (['AreaRange', 'ColourAreaRange'].includes(tech.pricing_type) && !(areaCm2 > 0)) {
    throw new Refusal(422, 'Please give the logo area in cm2 for this print option');
  }
  const manip = product.print.manipulation
    ? num((printPricelist.print_manipulations.find(m => m.code === product.print.manipulation) || {}).price)
    : 0;
  const colorCode = String(line.sku).split('-')[1] || '';

  const r = priceLine({ blank: num(blankRow.price), tech, qty, colours, positions: positions.length, areaCm2, colorCode, manipulationPrice: manip });
  if (!r) throw new Refusal(422, 'This option needs a manual quote, please enquire');

  // Bags the old site sold keep the old site's exact price for the default print. Other options are priced as the
  // default price plus the model's difference between the requested option and the default option.
  const ov = oldSitePrice(String(line.sku).split('-')[0], qty);
  if (ov) {
    const def = defaultOption(product.print);
    const defTech = def && printPricelist.print_techniques.find(t => t.id === def.tech);
    const d = defTech && priceLine({ blank: num(blankRow.price), tech: defTech, qty, colours: 1, positions: 1, areaCm2: 100, colorCode, manipulationPrice: manip });
    if (d) {
      const unit = Math.max(0.01, Math.round((ov.unit + (r.unit_price - d.unit_price)) * 100) / 100);
      r.unit_price = unit; r.total = Math.round(unit * qty * 100) / 100;
    }
  }
  return { product, tech, positions, areaCm2, result: r };
}

router.post('/price', limiter(120), async (req, res) => {
  try {
    const { result, positions } = await priceRequestedLine(req.body || {});
    res.json({ success: true, quantity: result.qty, unit_price: result.unit_price, total: result.total, colours: result.colours, positions, technique: result.technique, currency: config.currency });
  } catch (err) { fail(res, err, 'totes /price'); }
});

router.post('/checkout', limiter(20), async (req, res) => {
  try {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines.slice(0, 10) : [];
    if (!lines.length) throw new Refusal(400, 'No lines');
    const priced = [];
    for (const line of lines) priced.push({ line, ...(await priceRequestedLine(line)) }); // any failure aborts everything

    const lineItems = priced.map(({ line, product, tech, positions, areaCm2, result }) => ({
      title: `${product.title} (${line.colour || line.sku}), ${tech.description}, ${result.colours} colour${result.colours > 1 ? 's' : ''}, ${positions.join(' + ')}`,
      originalUnitPrice: result.unit_price.toFixed(2),
      quantity: result.qty,
      requiresShipping: true,
      taxable: true,
      customAttributes: [
        { key: 'Supplier SKU', value: String(line.sku) },
        { key: 'Technique', value: `${tech.id} ${tech.description}` },
        { key: 'Colours', value: String(result.colours) },
        { key: 'Positions', value: positions.join(', ') },
        ...(areaCm2 ? [{ key: 'Logo area cm2', value: String(areaCm2) }] : []),
        ...(typeof line.artwork_url === 'string' && /^https:\/\//.test(line.artwork_url) ? [{ key: 'Artwork URL', value: line.artwork_url.slice(0, 500) }] : []),
      ],
    }));
    const data = await graphql(`mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } } }`, {
      input: { lineItems, tags: ['configured-print', 'needs-review'], note: 'Server-priced configured print order (totes proxy).' },
    });
    assertNoUserErrors(data.draftOrderCreate.userErrors, 'draftOrderCreate');
    const d = data.draftOrderCreate.draftOrder;
    res.json({ success: true, invoice_url: d.invoiceUrl, draft_order_id: d.id, total: +priced.reduce((s, p) => s + p.result.total, 0).toFixed(2) });
  } catch (err) { fail(res, err, 'totes /checkout'); }
});

function fail(res, err, where) {
  if (err instanceof Refusal) return res.status(err.status).json({ error: err.message });
  console.error(`${where} error:`, err && err.message);
  res.status(500).json({ error: 'Could not price this order, please try again or enquire' });
}

module.exports = router;
