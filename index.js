const express = require('express');
const app = express();

/* ── CORS — handle all origins including Shopify preview domains ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'custommagnets.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

app.post('/quote', async (req, res) => {
  try {
    const p = req.body;
    if (!p.customer_email || !p.submission_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

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

    const unitPrice = p.unit_price ? parseFloat(p.unit_price.replace('£', '')) : 0;
    const qty = p.quantity ? parseInt(p.quantity.replace(/,/g, ''), 10) : 1;

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
          { name: 'Customer Email', value: p.customer_email || '' }
        ],
        email: p.customer_email || undefined
      }
    };

    const response = await fetch(
      'https://' + SHOPIFY_STORE + '/admin/api/2024-01/draft_orders.json',
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
    res.json({ success: true, draft_order_id: data.draft_order?.id, invoice_url: data.draft_order?.invoice_url });

  } catch (err) {
    console.error('Server error:', err.message);
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

/* Health check */
app.get('/', (req, res) => res.json({ status: 'ok', service: 'cm-quote-proxy' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('cm-quote-proxy running on port ' + PORT));
