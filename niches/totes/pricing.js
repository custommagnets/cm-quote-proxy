// Pure pricing maths for Brand My Tote. No network, no Shopify. See CLAUDE.md for the rules and
// the assumptions still to confirm with Midocean.

const config = require('./totes-pricing-config.json');
const oldSite = require('./old-site-prices.json').prices;

// Midocean numbers are strings with comma decimals and dot thousands ("1.000", "2,33").
function num(s) {
  if (s === null || s === undefined || s === '') return 0;
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

// Highest band whose minimum_quantity is not above qty. Below the first band: the first band.
function bandFor(scales, qty) {
  let best = scales[0];
  for (const s of scales) if (num(s.minimum_quantity) <= qty) best = s;
  return best;
}

// var_costs ranges for area-based types: shared boundary goes to the HIGHER range (Midocean docs).
function rangeFor(varCosts, areaCm2) {
  if (varCosts.length === 1) return varCosts[0];
  let best = null;
  for (const r of varCosts) {
    const from = num(r.area_from), to = num(r.area_to);
    if (areaCm2 >= from && (areaCm2 < to || to === 0)) best = r;
  }
  if (!best) {
    // Larger than the largest range: not priceable.
    return null;
  }
  return best;
}

function markupPctFor(qty, tiers = config.markup_tiers) {
  const bands = [...tiers].sort((a, b) => a.min_qty - b.min_qty);
  let pct = bands[0].markup_pct;
  for (const b of bands) if (qty >= b.min_qty) pct = b.markup_pct;
  return pct;
}

function isWhiteVariant(colorCode) {
  return config.white_color_codes.includes(String(colorCode));
}

// Exact price from the old brandmytote.com grids for a master, for the default print, or null if the old site
// did not sell it. The price for a quantity is the price of the band it falls in (highest band at or below qty).
function oldSitePrice(master, qty) {
  const row = oldSite[master];
  if (!row) return null;
  let tier = config.quantity_tiers[0];
  for (const t of config.quantity_tiers) if (t <= qty && row.totals[t] !== undefined) tier = t;
  const total = row.totals[tier];
  return { tier, unit: Math.round((total / tier) * 100) / 100, total };
}

/**
 * Midocean print cost for one print job.
 * tech: entry from printpricelist.print_techniques
 * opts: { qty, colours, positions (count), areaCm2, whiteUnderlay (bool) }
 * returns { perUnit, setup } or null if the technique cannot be priced automatically.
 */
function printCost(tech, opts) {
  const { qty, colours = 1, positions = 1, areaCm2 = 0, whiteUnderlay = false } = opts;
  if (config.unsupported_pricing_types.includes(tech.pricing_type)) return null;

  let perUnit = 0;
  let setupUnits = positions; // setup is one-time per colour/position

  if (tech.pricing_type === 'NumberOfColours') {
    const scale = bandFor(tech.var_costs[0].scales, qty);
    const first = num(scale.price), next = num(scale.next_price);
    const printColours = colours + (whiteUnderlay ? 1 : 0); // extra white layer is billed, setup is not
    const nextFlag = tech.next_colour_cost_indicator === true || tech.next_colour_cost_indicator === 'true' || tech.next_colour_cost_indicator === 'X';
    const perPosition = nextFlag ? first + next * (printColours - 1) : first * printColours;
    perUnit = perPosition * positions;
    setupUnits = colours * positions;
  } else if (tech.pricing_type === 'NumberOfPositions') {
    const scale = bandFor(tech.var_costs[0].scales, qty);
    perUnit = num(scale.price) * positions;
  } else if (tech.pricing_type === 'AreaRange') {
    const range = rangeFor(tech.var_costs, areaCm2);
    if (!range) return null;
    perUnit = num(bandFor(range.scales, qty).price) * positions;
  } else if (tech.pricing_type === 'ColourAreaRange') {
    const range = rangeFor(tech.var_costs, areaCm2);
    if (!range) return null;
    perUnit = num(bandFor(range.scales, qty).price) * colours * positions;
    setupUnits = colours * positions;
  } else {
    return null;
  }

  return { perUnit, setup: num(tech.setup) * setupUnits };
}

/**
 * Full cost and sell price for a configured line.
 * input: { blank, tech, qty, colours, positions, areaCm2, colorCode, manipulationPrice }
 */
function priceLine(input) {
  const { blank, tech, qty, colours = 1, positions = 1, areaCm2 = 0, colorCode, manipulationPrice = 0 } = input;
  const isScreen = config.screen_technique_ids.includes(tech.id);
  const whiteUnderlay = !!(config.screen_underlay_on_non_white && isScreen && !isWhiteVariant(colorCode));
  const print = printCost(tech, { qty, colours, positions, areaCm2, whiteUnderlay });
  if (!print) return null;

  const costTotal = (blank + print.perUnit + manipulationPrice) * qty + print.setup;
  const markup = markupPctFor(qty);
  // Round the unit price to the penny first, then derive the total from it, so the pricing
  // table, the variant price and the checkout charge always agree.
  const unit = Math.round((costTotal / qty) * (1 + markup / 100) * 100) / 100;
  const total = Math.round(unit * qty * 100) / 100;
  return {
    qty, colours, positions, technique: tech.id,
    cost_unit: Math.round((costTotal / qty) * 10000) / 10000,
    markup_pct: markup,
    unit_price: unit,
    total,
    white_underlay: whiteUnderlay,
  };
}

module.exports = { config, num, bandFor, rangeFor, markupPctFor, isWhiteVariant, printCost, priceLine, oldSitePrice };
