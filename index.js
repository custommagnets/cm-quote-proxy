const express = require('express');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const app = express();

/* ── CORS — restrict to Custom Magnets storefront origins ── */
const ALLOWED_ORIGINS = [
  'https://custommagnets.co.uk',
  'https://www.custommagnets.co.uk',
  'https://custommagnets.myshopify.com'
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'custommagnets.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || '587';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Custom Magnets <sales@custommagnets.co.uk>';
const EMAIL_TO  = process.env.EMAIL_TO  || 'sales@custommagnets.co.uk';
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACE_ID = process.env.GOOGLE_PLACE_ID;

const API_VERSION = '2026-04';
const QTY_TIERS = [25, 50, 100, 250, 500, 1000];
const QTY_MULTS = [1.0, 0.95, 0.88, 0.80, 0.72, 0.64];

/* ── Shopify API helper ── */

async function shopifyFetch(endpoint, options = {}) {
  const res = await fetch(
    'https://' + SHOPIFY_STORE + '/admin/api/' + API_VERSION + endpoint,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        ...options.headers
      }
    }
  );
  const data = await res.json();
  if (!res.ok) throw { status: res.status, data };
  return data;
}

/* ── Price validation ── */

async function validatePrice(handle, variantTitle, quantity) {
  const data = await shopifyFetch(
    '/products.json?handle=' + encodeURIComponent(handle) + '&fields=id,title,variants'
  );
  const product = data.products && data.products[0];
  if (!product) return null;

  const variant = product.variants.find(function(v) { return v.title === variantTitle; });
  if (!variant) return null;

  const basePrice = parseFloat(variant.price);
  const tierIndex = QTY_TIERS.indexOf(quantity);
  const mult = tierIndex >= 0 ? QTY_MULTS[tierIndex] : QTY_MULTS[QTY_MULTS.length - 1];
  const unitPrice = +(basePrice * mult).toFixed(2);
  const total = +(unitPrice * quantity).toFixed(2);
  const saving = Math.round((1 - mult) * 100);

  return { variant_id: variant.id, base_price: basePrice, unit_price: unitPrice, total: total, saving: saving };
}

/* Plain variant price lookup — no tier multiplier applied. Used to work out what the
 * native Shopify cart would charge for a tiered line (variant.price × quantity) so
 * /cart-discount can compute exactly how much to knock off at checkout. */
async function getVariantPrice(handle, variantTitle) {
  const data = await shopifyFetch(
    '/products.json?handle=' + encodeURIComponent(handle) + '&fields=id,title,variants'
  );
  const product = data.products && data.products[0];
  if (!product) return null;
  /*
   * Match on option1, not the full variant title. The pricing_table metafield's
   * size option always encodes Shopify's *first* product option only (cmproduct.liquid's
   * syncVariant() does the same option1 match) — products with a second option (e.g.
   * shape/material) have a variant.title like "Up to 50mm x 50mm / Circle", which never
   * equals the plain size string the client sends.
   */
  const variant = product.variants.find(function(v) { return v.option1 === variantTitle; });
  if (!variant) return null;
  return parseFloat(variant.price);
}

/*
 * Product pages (cmproduct.liquid) quote a per-product tiered price curve stored in the
 * custom_magnets.pricing_table metafield — a different, more granular system than the
 * flat QTY_MULTS table above (which only the configurator uses). This validates against
 * that metafield so a direct product-page purchase is charged exactly what was quoted.
 * Mirrors the tierFor()/priceFor() math in cmproduct.liquid so results match the display.
 */
async function validateTieredPrice(handle, sizeName, quantity) {
  const query = 'query($handle: String!) { productByHandle(handle: $handle) { id title metafield(namespace: "custom_magnets", key: "pricing_table") { value } } }';
  const res = await fetch(
    'https://' + SHOPIFY_STORE + '/admin/api/' + API_VERSION + '/graphql.json',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
      body: JSON.stringify({ query: query, variables: { handle: handle } })
    }
  );
  const json = await res.json();
  if (!res.ok || json.errors) throw { status: res.status, data: json.errors || json };
  const product = json.data && json.data.productByHandle;
  if (!product || !product.metafield) return null;

  var table;
  try { table = JSON.parse(product.metafield.value); } catch (e) { return null; }
  if (!table || !table.options) return null;

  const option = table.options.find(function(o) { return o.name === sizeName; });
  if (!option || !option.rows || !option.rows.length) return null;

  const rows = option.rows;
  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1) return null;

  var tierIdx = 0;
  for (var i = 0; i < rows.length; i++) { if (qty >= rows[i][0]) tierIdx = i; }
  const tierRow = rows[tierIdx];
  const unitPrice = tierRow[1] / tierRow[0];
  const total = +(unitPrice * qty).toFixed(2);
  const baseUnit = rows[0][1] / rows[0][0];
  const saving = Math.round((1 - (unitPrice / baseUnit)) * 100);

  return {
    product_title: product.title,
    size: option.name,
    unit_price: +unitPrice.toFixed(5),
    total: total,
    saving: saving
  };
}

/* ── Google Reviews (GBP, via Places API New) ──
 * Uses the Place Details (New) endpoint with an API key — no OAuth required, intended
 * for exactly this "display reviews on your own site" use case. Google returns at most
 * 5 reviews per place; there's no supported way to request a specific sort order (no
 * reviewsSort/orderBy param exists on this endpoint) — Google picks which 5 to return.
 * Response is cached in-memory to keep Places API usage (and cost) minimal — reviews
 * don't change often enough to justify fetching on every page load. */

const REVIEWS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
var reviewsCache = { data: null, fetchedAt: 0 };

async function fetchGoogleReviews() {
  if (!GOOGLE_PLACES_API_KEY || !GOOGLE_PLACE_ID) return null;

  const url = 'https://places.googleapis.com/v1/places/' + GOOGLE_PLACE_ID;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'rating,userRatingCount,googleMapsUri,reviews.rating,reviews.text,reviews.authorAttribution,reviews.relativePublishTimeDescription,reviews.publishTime'
    }
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, data: data };

  return {
    rating: data.rating || null,
    review_count: data.userRatingCount || 0,
    maps_url: data.googleMapsUri || null,
    reviews: (data.reviews || []).map(function (r) {
      return {
        rating: r.rating || 5,
        text: (r.text && r.text.text) || '',
        author: (r.authorAttribution && r.authorAttribution.displayName) || 'Google user',
        relative_time: r.relativePublishTimeDescription || '',
        published_at: r.publishTime || null
      };
    })
  };
}

/* ── Email ── */

var transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT),
    secure: parseInt(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('SMTP configured: ' + SMTP_HOST);
}

function emailRow(label, value) {
  return '<tr>'
    + '<td style="padding:7px 0;font-size:12px;color:#8A8A8A;border-bottom:1px solid rgba(44,44,44,0.08);width:35%;">' + label + '</td>'
    + '<td style="padding:7px 0;font-size:12px;font-weight:600;color:#2C2C2C;border-bottom:1px solid rgba(44,44,44,0.08);text-align:right;">' + value + '</td>'
    + '</tr>';
}

function buildEmailHTML(p) {
  var rows = ''
    + emailRow('Product', p.product_title || '—')
    + emailRow('Material', p.material || '—')
    + emailRow('Shape', p.shape || '—')
    + emailRow('Size', p.size || '—')
    + emailRow('Quantity', p.quantity || '—')
    + emailRow('Per unit', p.unit_price || 'TBC')
    + emailRow('Saving', p.saving || '—')
    + emailRow('Artwork', p.artwork_filename || 'None');
  if (p.artwork_notes && p.artwork_notes !== 'None') rows += emailRow('Notes', p.artwork_notes);
  rows += emailRow('Delivery', '<span style="color:#2E7D32;">Free (UK)</span>');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>'
    + '<body style="margin:0;padding:0;background:#F5F4F1;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F4F1;padding:32px 16px;"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid rgba(44,44,44,0.12);">'
    // Header
    + '<tr><td style="background:#2C2C2C;padding:24px 32px;">'
    + '<span style="color:#C0392B;font-size:18px;font-weight:700;">&#9679;</span>'
    + '<span style="color:#fff;font-size:18px;font-weight:700;margin-left:8px;">Custom Magnets</span>'
    + '<div style="color:rgba(255,255,255,0.5);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-top:4px;">Quote Confirmation</div>'
    + '</td></tr>'
    // Body
    + '<tr><td style="padding:32px;">'
    + '<p style="font-size:15px;color:#2C2C2C;margin:0 0 6px;">Hi ' + (p.customer_name || 'there') + ',</p>'
    + '<p style="font-size:14px;color:#5A5A5A;line-height:1.6;margin:0 0 24px;">Thanks for your quote request. Here\'s a summary of your configuration — we\'ll review and be in touch to confirm.</p>'
    // Quote table
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F4F1;border-radius:8px;margin-bottom:24px;"><tr><td style="padding:20px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0">' + rows + '</table>'
    + '</td></tr></table>'
    // Total block
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#2C2C2C;border-radius:8px;margin-bottom:24px;"><tr>'
    + '<td style="padding:20px 24px;"><div style="color:rgba(255,255,255,0.55);font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">Estimated total</div>'
    + '<div style="color:rgba(255,255,255,0.4);font-size:10px;margin-top:2px;">' + (p.quantity || '—') + ' units · incl. delivery</div></td>'
    + '<td style="padding:20px 24px;text-align:right;"><span style="color:#fff;font-size:28px;font-weight:700;letter-spacing:-0.04em;">' + (p.total_price || 'TBC') + '</span></td>'
    + '</tr></table>'
    // Disclaimer
    + '<p style="font-size:12px;color:#8A8A8A;line-height:1.6;margin:0 0 24px;padding:12px 14px;background:#F5F4F1;border-radius:6px;border-left:3px solid rgba(44,44,44,0.20);">'
    + 'Prices are indicative — your final quote is confirmed after artwork review. Nothing prints without your proof sign-off.</p>'
    // Artwork link
    + (p.artwork_url && p.artwork_url !== 'No file uploaded'
      ? '<p style="font-size:12px;color:#5A5A5A;margin:0 0 24px;">Artwork file: <a href="' + p.artwork_url + '" style="color:#C0392B;">' + (p.artwork_filename || 'Download') + '</a></p>'
      : '')
    + '<p style="font-size:13px;color:#5A5A5A;line-height:1.6;margin:0;">Questions? Reply to this email or call us — we\'re here Mon–Fri, 9am–5pm.</p>'
    + '</td></tr>'
    // Footer
    + '<tr><td style="padding:20px 32px;border-top:1px solid rgba(44,44,44,0.10);text-align:center;">'
    + '<span style="font-size:11px;color:#8A8A8A;">Custom Magnets · sales@custommagnets.co.uk</span>'
    + '</td></tr></table>'
    + '</td></tr></table></body></html>';
}

/* ── Quote endpoint ── */

const quoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests. Please try again later.' }
});

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout requests. Please try again later.' }
});

app.post('/quote', quoteLimiter, async (req, res) => {
  try {
    const p = req.body;
    if (!p.customer_email || !p.submission_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    /* 1. Validate price server-side if product_handle is provided */
    var validated = null;
    if (p.product_handle && p.product_handle !== 'custom' && p.variant_title && p.quantity_raw) {
      try {
        validated = await validatePrice(p.product_handle, p.variant_title, p.quantity_raw);
        if (validated) {
          p.unit_price = '£' + validated.unit_price.toFixed(2);
          p.total_price = '£' + validated.total.toFixed(2);
          p.saving = validated.saving > 0 ? '-' + validated.saving + '%' : '—';
          console.log('Price validated: ' + p.product_handle + ' @ £' + validated.unit_price + '/unit × ' + p.quantity_raw);
        }
      } catch (e) {
        console.error('Price validation failed (using client price):', (e && e.status) || '', JSON.stringify((e && e.data) || (e && e.message) || e));
      }
    }

    /* 2. Build draft order */
    const noteLines = [
      '═══ QUOTE SUBMISSION ═══',
      'Type: ' + p.submission_type,
      '',
      '── Product ──',
      'Product: ' + (p.product_title || 'N/A'),
      'Material: ' + (p.material || 'N/A'),
      'Shape: ' + (p.shape || 'N/A'),
      'Size: ' + (p.size || 'N/A'),
      'Quantity: ' + (p.quantity || 'N/A'),
      'Unit price: ' + (p.unit_price || 'N/A'),
      'Total: ' + (p.total_price || 'N/A'),
      'Saving: ' + (p.saving || 'N/A'),
      '',
      '── Artwork ──',
      'Filename: ' + (p.artwork_filename || 'None'),
      'Download: ' + (p.artwork_url || 'No file uploaded'),
      'Notes: ' + (p.artwork_notes || 'None'),
      '',
      '── Customer ──',
      'Name: ' + (p.customer_name || 'N/A'),
      'Email: ' + (p.customer_email || 'N/A'),
    ];

    if (p.custom_brief) {
      noteLines.push('', '── Custom Brief ──', p.custom_brief);
    }

    if (validated) {
      noteLines.push('', '── Price Validation ──',
        'Server-validated: YES',
        'Base price: £' + validated.base_price.toFixed(2),
        'Tier discount: -' + validated.saving + '%',
        'Validated unit: £' + validated.unit_price.toFixed(2),
        'Validated total: £' + validated.total.toFixed(2));
    }

    const unitPrice = validated
      ? validated.unit_price
      : (p.unit_price ? parseFloat(p.unit_price.replace('£', '')) : 0);
    const qty = p.quantity_raw || (p.quantity ? parseInt(p.quantity.replace(/,/g, ''), 10) : 1);

    const draftOrder = {
      draft_order: {
        line_items: [{
          title: p.product_title || 'Custom Quote',
          quantity: qty || 1,
          price: unitPrice.toFixed(2),
          requires_shipping: true
        }],
        note: noteLines.join('\n'),
        tags: 'quote-configurator,needs-review',
        note_attributes: [
          { name: 'Submission Type', value: p.submission_type || '' },
          { name: 'Product', value: p.product_title || '' },
          { name: 'Material', value: p.material || '' },
          { name: 'Shape', value: p.shape || '' },
          { name: 'Size', value: p.size || '' },
          { name: 'Quantity', value: p.quantity || '' },
          { name: 'Unit Price', value: p.unit_price || '' },
          { name: 'Estimated Total', value: p.total_price || '' },
          { name: 'Artwork File', value: p.artwork_filename || '' },
          { name: 'Artwork URL', value: p.artwork_url || '' },
          { name: 'Artwork Notes', value: p.artwork_notes || '' },
          { name: 'Customer Name', value: p.customer_name || '' },
          { name: 'Customer Email', value: p.customer_email || '' },
          { name: 'Price Validated', value: validated ? 'Yes' : 'No' }
        ],
        email: p.customer_email || undefined
      }
    };

    const response = await fetch(
      'https://' + SHOPIFY_STORE + '/admin/api/' + API_VERSION + '/draft_orders.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN
        },
        body: JSON.stringify(draftOrder)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Shopify error:', JSON.stringify(data));
      return res.status(response.status).json({ error: 'Shopify API error', details: data });
    }

    console.log('Draft order created:', data.draft_order?.id);

    /* 3. Send confirmation email if requested */
    var emailSent = false;
    if (p.send_email && p.customer_email && transporter) {
      try {
        await transporter.sendMail({
          from: EMAIL_FROM,
          to: p.customer_email,
          bcc: EMAIL_TO,
          replyTo: EMAIL_TO,
          subject: 'Quote received — ' + (p.product_title || 'Custom Magnets'),
          html: buildEmailHTML(p)
        });
        emailSent = true;
        console.log('Email sent to:', p.customer_email);
      } catch (e) {
        console.error('Email failed:', e.message);
      }
    }

    res.json({
      success: true,
      draft_order_id: data.draft_order?.id,
      invoice_url: data.draft_order?.invoice_url,
      email_sent: emailSent
    });

  } catch (err) {
    console.error('Server error:', (err && err.status) || '', JSON.stringify((err && err.data) || (err && err.message) || err));
    const status = (err && err.status) || 500;
    res.status(status).json({ error: 'Server error', message: (err && err.message) || 'Unexpected error' });
  }
});

/*
 * Direct product-page "Add to basket" purchases. Unlike /quote, this is a real checkout —
 * so it fails closed: if the tiered price can't be validated server-side against the
 * pricing_table metafield, no draft order is created and the client price is never trusted.
 */
app.post('/price-checkout', checkoutLimiter, async (req, res) => {
  try {
    const p = req.body;
    const quantity = parseInt(p.quantity, 10);
    if (!p.product_handle || !p.size || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validated = await validateTieredPrice(p.product_handle, p.size, quantity);
    if (!validated) {
      return res.status(422).json({ error: 'Could not validate price for this product, size, and quantity' });
    }

    /*
     * Charge quantity 1 at the exact validated total, rather than the rounded
     * per-unit price times quantity. Shopify's checkout multiplies price × quantity
     * itself, so sending a rounded unit price (e.g. £1.39767 -> "1.40") at qty 300
     * would let a fraction-of-a-penny rounding error compound into a real
     * overcharge (£420.00 vs the £419.30 actually quoted). The true quantity is
     * still recorded in the title, note, and note_attributes for the order record.
     */
    const draftOrder = {
      draft_order: {
        line_items: [{
          title: validated.product_title + ' (' + quantity + ' units, ' + validated.size + ')',
          quantity: 1,
          price: validated.total.toFixed(2),
          requires_shipping: true
        }],
        note: [
          '═══ DIRECT PRODUCT PURCHASE ═══',
          'Product: ' + validated.product_title,
          'Size: ' + validated.size,
          'Quantity: ' + quantity,
          'Validated unit price: £' + validated.unit_price.toFixed(2),
          'Validated total: £' + validated.total.toFixed(2)
        ].join('\n'),
        tags: 'product-page-purchase',
        note_attributes: [
          { name: 'Product', value: validated.product_title },
          { name: 'Size', value: validated.size },
          { name: 'Quantity', value: String(quantity) },
          { name: 'Unit Price', value: '£' + validated.unit_price.toFixed(2) },
          { name: 'Total', value: '£' + validated.total.toFixed(2) },
          { name: 'Price Validated', value: 'Yes' }
        ]
      }
    };

    const response = await fetch(
      'https://' + SHOPIFY_STORE + '/admin/api/' + API_VERSION + '/draft_orders.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN
        },
        body: JSON.stringify(draftOrder)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Shopify error:', JSON.stringify(data));
      return res.status(response.status).json({ error: 'Shopify API error', details: data });
    }

    console.log('Direct purchase draft order created:', data.draft_order?.id, '@ £' + validated.total.toFixed(2));

    res.json({
      success: true,
      draft_order_id: data.draft_order?.id,
      invoice_url: data.draft_order?.invoice_url,
      total: validated.total
    });

  } catch (err) {
    console.error('Server error:', (err && err.status) || '', JSON.stringify((err && err.data) || (err && err.message) || err));
    const status = (err && err.status) || 500;
    res.status(status).json({ error: 'Shopify API error', message: (err && err.message) || 'Unexpected error' });
  }
});

const cartDiscountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' }
});

function generateDiscountCode() {
  return 'CM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

/*
 * POST /cart-discount — the native-cart counterpart to /price-checkout.
 *
 * Product pages now add tiered-priced lines straight to Shopify's real cart via
 * /cart/add.js (so multiple products/items accumulate normally in one basket instead
 * of each purchase spawning its own draft order). But the native cart can only charge
 * variant.price × quantity, which is always the UNDISCOUNTED base price for a tiered
 * line — so before the customer reaches checkout, the storefront calls this endpoint
 * with the tiered lines currently in their cart ({handle, size, quantity} — the same
 * identifiers /price-checkout uses, read off each line's item properties). For each
 * one it re-validates the true tiered total against the pricing_table metafield
 * (server-side, never trusting a client-sent price) and compares it against what the
 * live variant price would charge, then creates a single one-time discount code for
 * the exact difference. The storefront applies it via /checkout?discount=CODE.
 *
 * Fails closed like /price-checkout: if any tiered line can't be validated, no
 * discount code is created and checkout is blocked with an error rather than letting
 * the customer be overcharged the undiscounted price.
 */
app.post('/cart-discount', cartDiscountLimiter, async (req, res) => {
  try {
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length) {
      return res.json({ success: true, discount_code: null, discount_amount: 0 });
    }

    var totalDiscount = 0;
    var breakdown = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var quantity = parseInt(line.quantity, 10);
      if (!line.handle || !line.size || !quantity || quantity < 1) {
        return res.status(400).json({ error: 'Missing required fields on cart line ' + i });
      }

      var validated = await validateTieredPrice(line.handle, line.size, quantity);
      if (!validated) {
        return res.status(422).json({ error: 'Could not validate price for "' + line.handle + '" (' + line.size + ')' });
      }

      var nativePrice = await getVariantPrice(line.handle, line.size);
      if (nativePrice === null) {
        return res.status(422).json({ error: 'Could not look up native price for "' + line.handle + '" (' + line.size + ')' });
      }

      var nativeTotal = +(nativePrice * quantity).toFixed(2);
      var lineDiscount = Math.max(0, +(nativeTotal - validated.total).toFixed(2));
      totalDiscount = +(totalDiscount + lineDiscount).toFixed(2);
      breakdown.push({ handle: line.handle, size: line.size, quantity: quantity, native_total: nativeTotal, validated_total: validated.total, discount: lineDiscount });
    }

    if (totalDiscount <= 0) {
      return res.json({ success: true, discount_code: null, discount_amount: 0 });
    }

    const code = generateDiscountCode();
    const priceRule = {
      price_rule: {
        title: 'CM Tiered Price Correction — ' + code,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'fixed_amount',
        value: '-' + totalDiscount.toFixed(2),
        customer_selection: 'all',
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        usage_limit: 1
      }
    };

    const ruleData = await shopifyFetch('/price_rules.json', {
      method: 'POST',
      body: JSON.stringify(priceRule)
    });

    const ruleId = ruleData.price_rule && ruleData.price_rule.id;
    if (!ruleId) throw { status: 502, data: ruleData };

    await shopifyFetch('/price_rules/' + ruleId + '/discount_codes.json', {
      method: 'POST',
      body: JSON.stringify({ discount_code: { code: code } })
    });

    console.log('Cart discount code created:', code, '-£' + totalDiscount.toFixed(2), JSON.stringify(breakdown));

    res.json({ success: true, discount_code: code, discount_amount: totalDiscount });

  } catch (err) {
    console.error('Cart discount error:', (err && err.status) || '', JSON.stringify((err && err.data) || (err && err.message) || err));
    const status = (err && err.status) || 500;
    res.status(status).json({ error: 'Could not prepare checkout pricing', message: (err && err.message) || 'Unexpected error' });
  }
});

/*
 * GET /reviews — live Google Business Profile reviews for the homepage.
 * Read-only, cached, no rate limiting needed beyond what caching already provides
 * (at most one real Google API call every REVIEWS_CACHE_TTL_MS regardless of traffic).
 */
app.get('/reviews', async (req, res) => {
  try {
    const now = Date.now();
    if (reviewsCache.data && (now - reviewsCache.fetchedAt) < REVIEWS_CACHE_TTL_MS) {
      return res.json(reviewsCache.data);
    }

    const fresh = await fetchGoogleReviews();
    if (!fresh) {
      return res.status(503).json({ error: 'Google Reviews not configured' });
    }

    reviewsCache = { data: fresh, fetchedAt: now };
    res.json(fresh);

  } catch (err) {
    console.error('Reviews fetch failed:', err && (err.message || JSON.stringify(err.data || err)));
    /* Serve stale cache rather than a hard failure if Google is briefly unavailable */
    if (reviewsCache.data) return res.json(reviewsCache.data);
    res.status(502).json({ error: 'Could not fetch reviews' });
  }
});

/* Health check */
app.get('/', (req, res) => res.json({ status: 'ok', service: 'cm-quote-proxy' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('cm-quote-proxy running on port ' + PORT);
  if (!SHOPIFY_TOKEN) console.warn('WARNING: SHOPIFY_TOKEN not set');
  if (!transporter) console.warn('WARNING: SMTP not configured — emails will be skipped');
  if (!GOOGLE_PLACES_API_KEY || !GOOGLE_PLACE_ID) console.warn('WARNING: Google Places API key/Place ID not set — /reviews will return 503');
});
