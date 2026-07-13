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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
        console.error('Price validation failed (using client price):', e.message || e);
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
    console.error('Server error:', err.message);
    res.status(500).json({ error: 'Server error', message: err.message });
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
});
