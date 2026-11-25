# niches/totes/ — Brand My Tote sync, pricing and checkout

## What this is
Niche-specific business logic for **Brand My Tote**, a brand new Shopify store (domain TBC, set via
`TOTES_SHOPIFY_STORE`). Custom printed tote bags from the **Midocean Brands** API. Catalogue model B
(supplier sync), like Sweets, but with a second pricing layer because every Midocean print technique
is offered. This folder is NOT shared infrastructure: nothing totes-specific may live at the repo root
except the single `app.use('/totes', ...)` mount line in `index.js`.

## Status: BUILT LOCALLY, NOT DEPLOYED, NOT TESTED AGAINST SHOPIFY (24 Nov 2026)
Written and unit-checked against the live Midocean feeds only. No Shopify store exists yet, so
`sync-totes.js`, `router.js` and `shopify.js` have never run against Shopify. Do not deploy, push or set
Render env vars until the store exists and a dry run has been done.

## Files
- `totes-pricing-config.json` — markup tiers (70/55/45/35/28/22/15 percent at 10/50/100/250/500/1000/2500+,
  approved by Brad 24 Nov 2026, evidence in `brand-my-tote/brain/PRICING-RESEARCH-24NOV2026.md`),
  minimum order 10, default technique/position, quantity tiers, white colour codes.
- `pricing.js` — pure functions, no network. Midocean cost build-up and sell price. Implements all five
  pricing types (NumberOfColours, NumberOfPositions, AreaRange, ColourAreaRange; `Area` returns null, so
  quote by enquiry). Unit tested by `test-pricing.js`.
- `midocean.js` — API client. `products/2.0` and `stock/2.0` answer 303 to a signed S3 URL: follow it
  WITHOUT the API key header. Prices use comma decimals and dot thousands separators (`num()`).
- `shopify.js` — Client Credentials token + Admin GraphQL helper for the totes store.
- `sync-totes.js` — `runSync()`: one Shopify product per Midocean master in category "Tote bags",
  options Colour x Quantity tier, tier variants priced at 1-colour front screenprint (S1), plus
  `custom_totes.pricing_table` and `custom_totes.print_options` metafields.
- `router.js` — mounted at `/totes`. `POST /totes/price` (read-only quote for any technique/colours/
  positions) and `POST /totes/checkout` (server-validated draft order, fails closed).
- `test-pricing.js` — run with `node niches/totes/test-pricing.js`; needs the sample feeds in
  `brand-my-tote/supplier-samples/`.

## Why a draft order and not the Magnets discount code
Magnets' `/cart-discount` can only LOWER a price (a fixed-amount discount code). Non-default print
options (extra colours, other techniques, more positions) cost MORE than the native variant price, which
a discount cannot add. So configured orders go through `/totes/checkout`, which creates a draft order at
the server-computed price and returns the invoice URL. Default orders (1-colour front screenprint) use
the native cart and the tier variants. A mixed basket is not supported: configured lines check out on
their own.

## Pricing model
Cost = (blank price + print price per unit + handling) x qty + setup, per Midocean's rules (see the
research file). Sell = cost x (1 + markup for the quantity band), unit price rounded to the penny, total
= unit x qty so table, variant and checkout agree. Setup is built into the unit price so the site can
say "no setup charges".

**Assumptions to confirm with Midocean before launch** (not stated in their docs):
1. For screen print on non-white bags, print cost counts one extra colour (white underlay). The docs say
   this for "ST" techniques; config flag `screen_underlay_on_non_white` applies it to S1-S3/ST1 too, which
   is the safe (higher) choice. White codes: 06 plus the apparel codes in the config.
2. AreaRange / ColourAreaRange / NumberOfPositions prices are applied per position, and setup is charged
   per position (and per colour where the type counts colours).
3. Pricing below the first quantity band uses the first band. Minimum order is 10 so this should not occur.
4. Midocean delivery cost to us, payment fees and VAT are NOT in these prices. Not yet decided.

## Env vars (none set yet)
- `MIDOCEAN_API_KEY` — supplier key (local copy in `brand-my-tote/.env`, gitignored)
- `TOTES_SHOPIFY_STORE` — myshopify domain of the new store
- `TOTES_CLIENT_ID`, `TOTES_CLIENT_SECRET` — Dev Dashboard app, scopes `read_products`, `write_products`,
  `read_draft_orders`, `write_draft_orders`
- `TOTES_SYNC_SECRET` — header `x-sync-secret` for `POST /sync/totes`
- `TOTES_ALLOWED_ORIGINS` — optional, comma list, default brandmytote.com and www

## Known gaps
- Whole-catalogue sync only (Midocean has no single-SKU fetch): products feed is ~36 MB.
- Stock (`stock/2.0`) is not synced; variants are untracked, same as Sweets.
- Non-sync of delivery cost. No shipping profile logic here.
