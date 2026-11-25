// node niches/totes/test-pricing.js  (needs ../../../brand-my-tote/supplier-samples/*.json)
const path = require('path');
const assert = require('assert');
const { num, priceLine, markupPctFor, printCost } = require('./pricing');
const dir = path.join(__dirname, '../../../../brand-my-tote/supplier-samples');
const pl = require(path.join(dir, 'pricelist.json'));
const pp = require(path.join(dir, 'printpricelist.json'));
const price = Object.fromEntries(pl.price.map(p => [p.sku, num(p.price)]));
const tech = Object.fromEntries(pp.print_techniques.map(t => [t.id, t]));

assert.strictEqual(num('1,03'), 1.03);
assert.strictEqual(num('1.000'), 1000);
assert.strictEqual(num('2.500,50'), 2500.5);
assert.strictEqual(markupPctFor(10), 195);
assert.strictEqual(markupPctFor(49), 195);
assert.strictEqual(markupPctFor(50), 105);
assert.strictEqual(markupPctFor(200), 85);
assert.strictEqual(markupPctFor(2500), 55);
assert.strictEqual(markupPctFor(99999), 55);

// COTTONEL+ beige (colour 13, non-white): hand-calculated 24 Nov with S1, no underlay: cost 1.30 @100.
// With the underlay flag on (default) cost counts one extra colour at the first-colour... see below.
const sku = 'MO9267-13';
const a = priceLine({ blank: price[sku], tech: tech.S1, qty: 100, colours: 1, positions: 1, colorCode: '06' });
// white: 0.40 + 0.61 + 29/100 = 1.30 -> x1.45 = 1.885 -> 1.89
assert.strictEqual(a.unit_price, 2.54); // 1.30 x 1.95 at 100 bags (markup 95 percent)
assert.strictEqual(a.total, 254);
assert.strictEqual(a.white_underlay, false);

const b = priceLine({ blank: price[sku], tech: tech.S1, qty: 100, colours: 1, positions: 1, colorCode: '13' });
// beige: print = 0.61 + 0.34 (extra colour) = 0.95 -> cost 0.40+0.95+0.29 = 1.64 -> x1.95 = 3.198 -> 3.20
assert.strictEqual(b.white_underlay, true);
assert.strictEqual(b.unit_price, 3.2);

// Old-site exact prices
const { oldSitePrice } = require('./pricing');
assert.deepStrictEqual(oldSitePrice('MO9595', 100), { tier: 100, unit: 3.55, total: 355 });
assert.deepStrictEqual(oldSitePrice('MO9595', 40), { tier: 10, unit: 15.02, total: 150.2 });
assert.strictEqual(oldSitePrice('MO0000', 100), null);

// Total always equals unit x qty
for (const q of [10, 50, 100, 200, 300, 400, 500, 1000, 2500]) {
  const r = priceLine({ blank: 0.4, tech: tech.S1, qty: q, colorCode: '06' });
  assert.strictEqual(r.total, Math.round(r.unit_price * q * 100) / 100);
}

// More colours cost more, more positions cost more, quantity cuts unit price
const one = priceLine({ blank: 0.4, tech: tech.S1, qty: 250, colours: 1, colorCode: '06' }).unit_price;
const three = priceLine({ blank: 0.4, tech: tech.S1, qty: 250, colours: 3, colorCode: '06' }).unit_price;
const twoPos = priceLine({ blank: 0.4, tech: tech.S1, qty: 250, colours: 1, positions: 2, colorCode: '06' }).unit_price;
assert(three > one && twoPos > one);

// Every technique offered on totes must price or explicitly refuse, never throw or return NaN
for (const id of ['S1', 'S2', 'S3', 'T1', 'TR', 'TD1', 'E', 'B', 'TS3', 'TS4']) {
  const r = priceLine({ blank: 1, tech: tech[id], qty: 250, colours: 1, positions: 1, areaCm2: 20, colorCode: '06' });
  assert(r === null || (Number.isFinite(r.unit_price) && r.unit_price > 0), id + ' produced a bad price');
  console.log(id.padEnd(4), tech[id].pricing_type.padEnd(16), r ? '£' + r.unit_price.toFixed(2) + ' / bag @250 (20 cm2)' : 'not priceable');
}
console.log('pricing tests passed');
