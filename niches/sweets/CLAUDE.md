# niches/sweets/ — Custom Sweets sync

## What this is
Niche-specific business logic for **Custom Sweets** (`customsweets.myshopify.com`), a
different Shopify store from Custom Magnets. This folder is **not shared infrastructure** —
it exists only because it's deployed via the same proxy process as Magnets (see the repo
root `CLAUDE.md` for why, and for the rule about what may and may not live outside this
folder).

## Status: live, not a draft
This is production code. It runs daily via a Render Cron Job hitting `POST /sync/sweets`
(routed generically through `NICHE_SYNCS` in the repo root `index.js`), and has been
confirmed working end-to-end as of 26 July 2026 — correct images, prices, and markup
syncing into the live Custom Sweets store.

## Files
- `sync-sweets.js` — pulls the Sweet People supplier feed (`SWEETS_FEED_URL`), applies
  markup, and upserts products/pricing into Shopify via the Admin GraphQL API. Exports
  `runSync()`, the contract required by the root `NICHE_SYNCS` pattern.
- `sweets-pricing-config.json` — the markup config: `flat_markup_pct`, `shipping_markup_pct`,
  `origination_markup_gbp`. Change prices/margins by editing this file, not the sync logic.

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
