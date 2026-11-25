// Syncs Midocean "Tote bags" into the Brand My Tote store. Exports runSync() for the generic
// POST /sync/:niche route (and for a GitHub Actions job, like Sweets).
//
// One Shopify product per Midocean master. Options: Colour x Quantity tier. Each variant is
// priced at the default print price (full colour digital transfer, front, logo up to 150 cm2; else 1-colour screen print) for that tier, so the native cart and checkout charge
// exactly what the product page shows. Other print options go through router.js.
// Nothing here has been run against Shopify yet (no store existed on 24 Nov 2026).

const midocean = require('./midocean');
const { graphql, assertNoUserErrors } = require('./shopify');
const { config, num, priceLine, oldSitePrice } = require('./pricing');

const TIER_OPTION = 'Quantity tier';
const COLOUR_OPTION = 'Colour';
const DEFAULT_AREA_CM2 = 100; // assumed logo area when the default technique is area-priced

function titleCase(s) {
  return String(s).toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\s+/g, ' ').trim();
}
const MATERIAL_NAMES = { PP: 'Non-Woven', 'PET-COTTON': 'Poly-Cotton', 'RECYCLED COTTON': 'Recycled Cotton', 'ORGANIC COTTON': 'Organic Cotton' };

// Customer-facing title: "<Name> <Material> Tote Bag, <weight>[, with gusset]". Midocean names carry
// markers like "+", "++" and "COLOUR" that mean nothing to a buyer. "Colour" stays (different bag).
function titleFor(master) {
  let name = titleCase(String(master.product_name || master.master_code).replace(/\++/g, ' ').replace(/\bcoloured\b/i, 'colour'));
  name = name.replace(/\b(Tote|Bag)\b/g, '').replace(/\bOrganic\s+/i, '').replace(/\s+/g, ' ').trim();
  const rawMat = String(master.material || '').toUpperCase();
  const material = MATERIAL_NAMES[rawMat] || (rawMat ? titleCase(rawMat) : '');
  const matWord = /^(PE|PET|RPET)$/.test(rawMat) ? rawMat : material;
  const text = `${master.short_description || ''} ${master.long_description || ''}`;
  const w = text.match(/(\d{2,3})\s*(?:gr?|gsm)\s*(?:\/\s*m\u00b2|\/\s*m2)?/i);
  const parts = String(master.dimensions || '').split(/x/i);
  const gusset = parts.length >= 3;
  const noun = (master.variants || []).some(v => v.category_level3 === 'Beach bags') ? 'Beach Bag' : 'Tote Bag';
  let t = `${name} ${matWord} ${noun}`.replace(/\s+/g, ' ').trim();
  if (w) t += `, ${w[1]}gsm`;
  if (gusset) t += ', with gusset';
  return t;
}
const CATEGORIES = [config.category_level3, ...(config.extra_categories || [])];
const EXCLUDED = new Set(config.exclude_masters || []); // duffles, trolleys, organisers, baskets, cooler and bicycle bags
function isToteVariant(v) { return CATEGORIES.includes(v.category_level3); }
const MATERIAL_TAGS = { 'rpet-recycled cotton': 'recycled cotton' }; // blends group with recycled
function materialTag(m) { const k = String(m || 'other').toLowerCase(); return MATERIAL_TAGS[k] || k; }
function baseTitle(t) { return t.split(',')[0]; }
function dimsText(master) { return String(master.dimensions || '').replace(/\s*cm$/i, '').replace(/x/gi, ' x ').replace(/\s+/g, ' ').trim(); }
function trimTo(s, n) { if (s.length <= n) return s; const cut = s.slice(0, n - 1); return cut.slice(0, cut.lastIndexOf(' ')).replace(/[ ,.;:]+$/, '') + '.'; }

// Search snippet for the product page: unique per bag, nothing that is not true of every bag.
function seoFor(master) {
  const t = titleFor(master), b = baseTitle(t);
  const long = `${b} with Your Logo | Brand My Tote`;
  const title = long.length <= 62 ? long : `${b} | Brand My Tote`;
  const dims = dimsText(master);
  const description = trimTo(`Custom printed ${b}${dims ? ', ' + dims + ' cm' : ''}. Order from 10 bags, see the price for your quantity, no setup charges and a digital proof before we print.`, 158);
  return { title, description };
}

// Product description: the supplier's own line first, then what is true of every order.
function descriptionFor(master) {
  const src = String(master.long_description || master.short_description || '').replace(/\s+/g, ' ').trim();
  const lead = src ? src.charAt(0).toUpperCase() + src.slice(1) : '';
  const dot = /[.!?]$/.test(lead) ? '' : '.';
  const parts = [];
  if (lead) parts.push(`<p>${lead}${dot}</p>`);
  parts.push('<p>Printed with your logo. A full colour front print is included in the price where the bag supports it, there are no setup charges, and you approve a digital proof before anything is printed. Order from 10 bags, with the price per bag falling as the quantity goes up.</p>');
  return parts.join('');
}

function handleFor(master) { return `tote-${String(master).toLowerCase()}`; }
function tierLabel(q) { return `${q}+`; }

// Prefer the config default (full colour digital transfer TD1) at the default position, then a screen
// technique, then the product's own default technique.
function chooseDefaultPrint(printProduct, techById) {
  if (!printProduct) return null;
  const positions = printProduct.printing_positions || [];
  const techsAt = pos => (pos.printing_techniques || []).filter(t => techById[t.id]);
  const isFront = pos => String(pos.position_id).startsWith(config.default_position); // "FRONT" and "FRONT TD1"
  // 1. The preferred technique (full colour digital transfer, TD1). Midocean lists it under its own
  //    position id, e.g. "FRONT TD1", not under "FRONT".
  for (const pos of positions.filter(isFront)) {
    const t = techsAt(pos).find(x => x.id === config.default_technique);
    if (t) return { position: pos.position_id, techniqueId: t.id };
  }
  // 2. Screen print at the front, 3. the product's own default technique.
  const pos = positions.find(p => p.position_id === config.default_position) || positions[0];
  if (!pos) return null;
  const techs = techsAt(pos);
  const screen = techs.find(t => config.screen_technique_ids.includes(t.id) && !t.id.startsWith('ST'));
  const chosen = screen || techs.find(t => t.default) || techs[0];
  return chosen ? { position: pos.position_id, techniqueId: chosen.id } : null;
}

function printOptionsFor(printProduct, techById = {}) {
  return {
    print_template: printProduct.print_template || null,
    manipulation: printProduct.print_manipulation || null,
    positions: (printProduct.printing_positions || []).map(p => ({
      id: p.position_id,
      w: p.max_print_size_width,
      h: p.max_print_size_height,
      unit: p.print_size_unit,
      techniques: (p.printing_techniques || []).filter(t => techById[t.id]).map(t => ({ id: t.id, name: techById[t.id].description, type: techById[t.id].pricing_type, max_colours: parseInt(t.max_colours, 10) || 0, default: !!t.default })),
    })),
  };
}

function buildVariantPrices(master, printProduct, priceBySku, techById) {
  const def = chooseDefaultPrint(printProduct, techById);
  if (!def) return null;
  const tech = techById[def.techniqueId];
  const rows = []; // [{ variant, curve:[{qty, unit, total}] }]
  for (const v of master.variants) {
    const blank = priceBySku[v.sku];
    if (blank === undefined) continue;
    const curve = [];
    for (const q of config.quantity_tiers) {
      const ov = oldSitePrice(master.master_code, q); // exact old-site price where the old site sold this bag
      if (ov) { curve.push({ qty: q, unit: Math.round((ov.total / q) * 100) / 100, total: ov.total }); continue; }
      const r = priceLine({ blank, tech, qty: q, colours: 1, positions: 1, areaCm2: DEFAULT_AREA_CM2, colorCode: v.color_code });
      if (!r) return null; // cannot price this product automatically
      curve.push({ qty: q, unit: r.unit_price, total: r.total });
    }
    rows.push({ variant: v, curve });
  }
  return rows.length ? { rows, technique: def.techniqueId, position: def.position } : null;
}

async function findProduct(handle) {
  const data = await graphql(`
    query($handle: String!) {
      productByIdentifier(identifier: { handle: $handle }) {
        id
        variants(first: 250) { edges { node { id title } } }
        media(first: 1) { edges { node { id } } }
      }
    }`, { handle });
  return data.productByIdentifier;
}

function imageInputs(master, rows) {
  const seen = new Set();
  const out = [];
  for (const { variant } of rows) {
    const img = (variant.digital_assets || []).find(a => a.type === 'image' && a.subtype === 'item_picture_front');
    if (img && !seen.has(img.url) && out.length < 12) {
      seen.add(img.url);
      out.push({ originalSource: img.url, alt: `${baseTitle(titleFor(master))} in ${variant.color_description}`, mediaContentType: 'IMAGE' });
    }
  }
  return out;
}

async function upsert(master, printProduct, priceBySku, techById, refreshCopy = false) {
  const priced = buildVariantPrices(master, printProduct, priceBySku, techById);
  if (!priced) return 'unpriceable';
  const handle = handleFor(master.master_code);
  const existing = await findProduct(handle);

  const pricingTable = {
    optionLabel: 'Quantity',
    printSpec: `${priced.technique} ${priced.position} ${techById[priced.technique].pricing_type === 'NumberOfColours' ? '1 colour' : 'logo up to 150 cm2'}`,
    options: priced.rows.map(r => ({ name: r.variant.color_description, rows: r.curve.map(c => [c.qty, c.total]) })),
  };
  const metafields = [
    { namespace: 'custom_totes', key: 'pricing_table', type: 'json', value: JSON.stringify(pricingTable) },
    { namespace: 'custom_totes', key: 'print_options', type: 'json', value: JSON.stringify(printOptionsFor(printProduct, techById)) },
    { namespace: 'custom_totes', key: 'specs', type: 'json', value: JSON.stringify({
        dimensions: master.dimensions || null, material: master.material || null,
        colours: priced.rows.length, sku_prefix: master.master_code }) },
  ];
  const sel = 'product { id variants(first: 250) { edges { node { id title } } } }';

  let productId, existingVariants, result;
  if (existing) {
    // Only pricing and print options are supplier-driven after creation; title, description,
    // status and images stay under manual control (same rule as Sweets).
    const data = await graphql(`mutation($input: ProductUpdateInput!) { productUpdate(product: $input) { ${sel} userErrors { message } } }`,
      { input: refreshCopy ? { id: existing.id, metafields, title: titleFor(master), descriptionHtml: descriptionFor(master), seo: seoFor(master) } : { id: existing.id, metafields } });
    assertNoUserErrors(data.productUpdate.userErrors, 'productUpdate');
    productId = data.productUpdate.product.id;
    existingVariants = data.productUpdate.product.variants.edges.map(e => e.node);
    result = 'updated';
  } else {
    const material = master.material ? titleCase(master.material) : '';
    const input = {
      title: titleFor(master),
      handle,
      descriptionHtml: descriptionFor(master),
      seo: seoFor(master),
      vendor: config.vendor,
      productType: 'Tote bag',
      tags: ['tote', `material:${materialTag(master.material)}`],
      status: 'DRAFT', // go live deliberately, after review, not by sync
      metafields,
    };
    const data = await graphql(`mutation($input: ProductCreateInput!) { productCreate(product: $input) { ${sel} userErrors { message } } }`, { input });
    assertNoUserErrors(data.productCreate.userErrors, 'productCreate');
    productId = data.productCreate.product.id;
    existingVariants = data.productCreate.product.variants.edges.map(e => e.node);
    result = 'created';
  }

  // Variants: Colour x Quantity tier. Match by title so variant IDs stay stable across runs.
  const idByTitle = {};
  existingVariants.forEach(v => { idByTitle[v.title] = v.id; });
  const colours = [...new Set(priced.rows.map(r => r.variant.color_description))];
  const variants = [];
  let position = 1;
  for (const r of priced.rows) {
    for (const c of r.curve) {
      const title = `${r.variant.color_description} / ${tierLabel(c.qty)}`;
      const v = {
        optionValues: [
          { optionName: COLOUR_OPTION, name: r.variant.color_description },
          { optionName: TIER_OPTION, name: tierLabel(c.qty) },
        ],
        price: c.unit.toFixed(2),
        inventoryPolicy: 'CONTINUE',
        inventoryItem: { tracked: false, sku: `${r.variant.sku}-Q${c.qty}` },
        taxable: true,
        position: position++,
      };
      if (idByTitle[title]) v.id = idByTitle[title];
      variants.push(v);
    }
  }
  const setData = await graphql(`mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) { product { id } userErrors { field message } } }`, {
    input: {
      id: productId,
      productOptions: [
        { name: COLOUR_OPTION, values: colours.map(name => ({ name })) },
        { name: TIER_OPTION, values: config.quantity_tiers.map(q => ({ name: tierLabel(q) })) },
      ],
      variants,
    },
  });
  assertNoUserErrors(setData.productSet.userErrors, 'productSet');

  if (!(existing && existing.media.edges.length)) {
    const media = imageInputs(master, priced.rows);
    if (media.length) {
      const m = await graphql('mutation($productId: ID!, $media: [CreateMediaInput!]!) { productUpdate(product: { id: $productId }, media: $media) { userErrors { message } } }', { productId, media });
      assertNoUserErrors(m.productUpdate.userErrors, 'productUpdate (media)');
    }
  }
  return result;
}

async function runSync(opts = {}) {
  const dryRun = !!opts.dryRun; // dry run: price everything, write nothing
  const [products, pricelist, printPricelist, printData] = await Promise.all([
    midocean.getProducts(), midocean.getPricelist(0), midocean.getPrintPricelist(0), midocean.getPrintData(),
  ]);
  const priceBySku = Object.fromEntries(pricelist.price.map(p => [p.sku, num(p.price)]));
  const techById = Object.fromEntries(printPricelist.print_techniques.map(t => [t.id, t]));
  const printByMaster = Object.fromEntries(printData.products.map(p => [p.master_code, p]));

  const only = opts.only ? new Set(opts.only) : null; // e.g. { only: ['MO9267'] } to sync chosen masters
  const totes = products.filter(p => (p.variants || []).some(isToteVariant) && !EXCLUDED.has(p.master_code))
    .filter(p => !only || only.has(p.master_code));
  let created = 0, updated = 0, unpriceable = 0, failed = 0;
  for (const master of totes) {
    master.variants = master.variants.filter(isToteVariant);
    const printProduct = printByMaster[master.master_code];
    try {
      if (dryRun) {
        const priced = printProduct && buildVariantPrices(master, printProduct, priceBySku, techById);
        if (priced) updated++; else unpriceable++;
        continue;
      }
      const r = await upsert(master, printProduct, priceBySku, techById, !!opts.refreshCopy);
      if (r === 'created') created++; else if (r === 'updated') updated++; else unpriceable++;
    } catch (err) {
      failed++;
      console.error(`Totes sync failed for ${master.master_code}:`, err.message);
    }
  }
  const summary = { dryRun, created, updated, unpriceable, failed, total: totes.length };
  console.log('Totes sync complete:', JSON.stringify(summary));
  return summary;
}

module.exports = { seoFor, descriptionFor, baseTitle, titleFor, runSync, buildVariantPrices, chooseDefaultPrint, printOptionsFor };
