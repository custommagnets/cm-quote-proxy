# niches/sweets/ — Custom Sweets sync

## What this is
Niche-specific business logic for **Custom Sweets** (`customsweets.myshopify.com`), a
different Shopify store from Custom Magnets. This folder is **not shared infrastructure** —
it exists only because it's deployed via the same proxy process as Magnets (see the repo
root `CLAUDE.md` for why, and for the rule about what may and may not live outside this
folder).

## Status: live, not a draft
This is production code. **As of 17 Nov 2026 it runs daily via GitHub Actions**
(`.github/workflows/sweets-sync.yml`, 05:00 UTC, plus manual "Run workflow"), which runs
`runSync()` directly on GitHub's runners with `SWEETS_CLIENT_ID` / `SWEETS_CLIENT_SECRET` /
`SWEETS_FEED_URL` as repo secrets. The Render Cron Job this doc used to describe no longer
exists (Render project has only the `cm-quote-proxy` web service) — that's why the sync
silently stopped after 11 Sep 2026. `POST /sync/sweets` on the web service still works
for a manual trigger. `diagnose-sync.js` is a read-only health check (credentials, store,
feed) for when a run fails.

## Files
- `sync-sweets.js` — pulls the Sweet People supplier feed (`SWEETS_FEED_URL`), applies
  markup, and upserts products/pricing into Shopify via the Admin GraphQL API. Exports
  `runSync()`, the contract required by the root `NICHE_SYNCS` pattern.
- `sweets-pricing-config.json` — the markup config: `markup_tiers` (sliding markup by tier
  quantity: 60% under 250, 45% 250-999, 35% 1,000-2,499, 25% 2,500+, set 17 Nov 2026 from
  competitor research: Will Smerwagg, Allwag, Kall Kwik, GoPromotional and Fluid Branding
  sell the same Sweet People products at roughly +50-60% on small orders tapering to
  +15-35% on large) and `origination_markup_gbp`. The old flat 100% priced the site at
  1.5-2x competitors. Change prices/margins by editing this file, not the sync logic.
- `sweets-excluded-skus.json` — blocklist of supplier SKUs (`excluded_skus: [...]`) to keep
  out of the store. Everything else in the feed syncs by default (opt-out model, not
  opt-in) — add a SKU here to stop a product being created/updated by the sync. Excluding a
  SKU does **not** remove or archive a product that's already live from a prior sync; it
  only stops future syncs from touching it. Archive/delete those manually in Shopify Admin.

## Tier pricing model (17 Nov 2026)
Each pricing tier is a real Shopify variant (option "Quantity tier", values "250+",
"500+" …) priced at the tier's all-in unit price (marked-up unit + origination spread
over the tier qty, rounded to the penny). The `pricing_table` metafield rows are
`[qty, unit × qty]` so the product page shows exactly what checkout charges. The theme's
`assets/cm-cart-drawer.js` swaps in the right tier variant on add-to-basket. This
replaced the proxy/discount-code correction, which never existed for Sweets: checkout
was blocked on every tiered product until this change. **Supplier shipping is excluded**
from tier prices (`shipping_markup_pct` is now unused); delivery is charged once at
checkout via the store's shipping rates. Variants are matched by title on each run so
variant IDs stay stable. API version bumped 2024-10 → 2026-10 (productByIdentifier,
productUpdate/productCreate `product:` input, media via productUpdate).

**Deploy gotcha found 17 Nov 2026:** the 30 Aug changes (50% markup, excluded-SKUs file,
title/description no longer overwritten) were never committed/pushed — Render was running
the older committed version (100% markup, overwrites title/description/status each run).
The store's last pricing update was 11 Sep 2026, so the daily sync had silently stopped.
Always check `git status` here before assuming the deployed code matches local.

## Tooling charge on moulded chocolate (26 Nov 2026)
`tooling_charge_gbp` in the pricing config maps supplier SKU to a one-off charge per order
(150 pounds on 200142, 100441, 100498, 100306, 100618). The product descriptions state it,
and the feed price does not appear to include it (not confirmed with the supplier). Added once per order without markup,
spread over the tier quantity; skipped if the feed's origination is already that high.
Repeat orders of an existing design are charged it too, so refund or discount if the
supplier does not charge again. A new moulded product needs its SKU added here.

## What gets overwritten on every sync vs. left alone
As of 30 Aug 2026, existing products (matched by handle) have **only the pricing metafield
+ variant price** overwritten on each run — `title`, `handle`, `descriptionHtml`, and
`status` are sent only on first creation, never on subsequent updates. This is deliberate:
the sync's job is price, full stop. It lets manual content optimisation (titles,
descriptions) *and* manual archive/discontinue decisions in Shopify Admin survive the daily
sync instead of being clobbered or auto-hidden by the supplier feed. Previously (until 30
Aug 2026) the feed's `discontinued` flag also drove `status` (ARCHIVED/ACTIVE) on every
sync, auto-hiding products the supplier stopped selling — removed because the business
preference is to keep a product listed and quietly re-source it from elsewhere rather than
have the supplier feed pull it off the store. `discontinued` still sets initial `status` on
first creation only. There is no inventory-quantity/in-stock tracking at all — the feed
sync never touches Shopify inventory levels (variants are created with
`inventoryPolicy: CONTINUE`, `tracked: false`), so "out of stock" isn't a concept this sync
represents; a product with no stock just stays listed and orderable until someone manually
archives it.
Product images follow the same already-existing pattern (only attached if the product
currently has none — see `hasExistingMedia` in `upsertProduct`). If you need feed-driven
copy or status to propagate to an existing product again, that has to be done manually (or
by temporarily removing/re-adding the product so it re-creates).

## Auth
Uses Shopify's Client Credentials Grant (`SWEETS_CLIENT_ID` / `SWEETS_CLIENT_SECRET`) to
fetch a fresh Admin API access token (~24h validity) at the start of each run, rather than a
long-lived static token.

## Env vars this niche needs on Render
- `SWEETS_CLIENT_ID`, `SWEETS_CLIENT_SECRET` — OAuth credentials for the Sweets store
- `SWEETS_FEED_URL` — supplier product feed URL
- `SWEETS_SYNC_SECRET` — shared secret required in the `x-sync-secret` header to trigger
  `POST /sync/sweets` (per-niche, per the `{NICHE}_SYNC_SECRET` convention in the root
  `index.js`)

## History
Originally lived at the repo root, mixed in with Magnets' shared checkout code — moved
here on 26 July 2026 to keep niche-specific business logic separate from shared proxy
infrastructure. The route wiring was made generic the same day so adding a future niche
never requires editing outside its own `niches/{name}/` folder.
