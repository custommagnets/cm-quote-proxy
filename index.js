const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

app.use(cors({
  origin: [
    'https://custommagnets.co.uk',
    'https://c0vrcs-zn.myshopify.com',
    /\.myshopify\.com$/,
    /\.onrender\.com$/
  ],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'Custom Magnets Quote Proxy is running' });
});

app.post('/quote', async (req, res) => {
  const {
    submission_type,
    product_title,
    material,
    shape,
    size,
    quantity,
    unit_price,
    total_price,
    saving,
    artwork_filename,
    artwork_notes,
    customer_name,
    customer_email,
    custom_brief
  } = req.body;

  if (!customer_email) {
    return res.status(400).json({ error: 'Missing required field: customer_email' });
  }

  const note = [
    `CONFIGURATOR QUOTE SUBMISSION`,
    `Type: ${submission_type || 'Standard'}`,
    `Submitted: ${new Date().toISOString()}`,
    ``,
    `--- ORDER DETAILS ---`,
    `Product: ${product_title || 'N/A'}`,
    `Material: ${material || 'N/A'}`,
    `Shape: ${shape || 'N/A'}`,
    `Size: ${size || 'N/A'}`,
    `Quantity: ${quantity || 'N/A'}`,
    `Unit price: ${unit_price || 'N/A'}`,
    `Estimated total: ${total_price || 'N/A'}`,
    `Saving: ${saving || 'N/A'}`,
    ``,
    `--- ARTWORK ---`,
    `File: ${artwork_filename || 'None'}`,
    `Notes: ${artwork_notes || 'None'}`,
    ``,
    `--- CUSTOMER ---`,
    `Name: ${customer_name || 'N/A'}`,
    `Email: ${customer_email}`,
    `Custom brief: ${custom_brief || 'N/A'}`
  ].join('\n');

  const lineItemPrice = unit_price
    ? unit_price.replace('£', '').replace(',', '')
    : '0.00';

  const lineItemQty = quantity
    ? parseInt(String(quantity).replace(',', ''), 10) || 1
    : 1;

  const draftOrder = {
    draft_order: {
      line_items: [{
        title: product_title || 'Custom Magnet Quote',
        quantity: lineItemQty,
        price: lineItemPrice,
        requires_shipping: true
      }],
      customer: {
        email: customer_email
      },
      note,
      tags: 'quote-configurator,needs-review',
      note_attributes: [
        { name: 'Submission Type', value: submission_type || 'Standard' },
        { name: 'Product', value: product_title || '' },
        { name: 'Material', value: material || '' },
        { name: 'Shape', value: shape || '' },
        { name: 'Size', value: size || '' },
        { name: 'Quantity', value: String(quantity || '') },
        { name: 'Unit Price', value: unit_price || '' },
        { name: 'Estimated Total', value: total_price || '' },
        { name: 'Saving', value: saving || '' },
        { name: 'Artwork File', value: artwork_filename || 'None' },
        { name: 'Customer Name', value: customer_name || '' },
        { name: 'Customer Email', value: customer_email || '' }
      ]
    }
  };

  try {
    const shopifyRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN
        },
        body: JSON.stringify(draftOrder)
      }
    );

    const data = await shopifyRes.json();

    if (!shopifyRes.ok) {
      console.error('Shopify error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Shopify draft order creation failed', details: data });
    }

    console.log(`Draft order created: ${data.draft_order?.id} for ${customer_email}`);
    return res.json({
      success: true,
      draft_order_id: data.draft_order?.id,
      draft_order_name: data.draft_order?.name
    });

  } catch (err) {
    console.error('Server error:', err.message);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CM Quote Proxy running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}`);
});
