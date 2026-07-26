# cm-quote-proxy — SHARED infrastructure

This repo is a single Node/Express proxy server (`index.js`), deployed as one process on
Render, that serves **multiple, unrelated Shopify stores**:

- **Custom Magnets** (`custommagnets.myshopify.com` / `custommagnets.co.uk`) — live.
  Handles configurator quotes/draft orders (`/quote`, `/price-checkout`) and product-page
  checkout price correction (`/cart-discount`).
- **Custom Sweets** (`customsweets.myshopify.com`) — live. Handled entirely by
  `niches/sweets/` and the generic sync route below.

## ⚠️ This file, and everything else at the repo root, is shared infrastructure

**Niche-specific business logic must never be added directly at the repo root.** It
belongs inside `niches/{name}/` only. This includes (but isn't limited to): supplier-specific
markup/pricing rules, feed-parsing logic, per-store credentials handling beyond generic env
var lookups, or anything that only makes sense for one store.

This isn't a style preference — it happened once already. Sweets-specific sync logic
(`sync-sweets.js`, `sweets-pricing-config.json`) was originally committed at the repo root
alongside Magnets' checkout code, then had to be carefully extracted into `niches/sweets/`
on 26 July 2026. Keep new niche logic out of the root from the start instead of repeating
that cleanup.

## The `NICHE_SYNCS` pattern — adding a new niche

`index.js` exposes one generic route, `POST /sync/:niche`, instead of a hardcoded route per
niche. To add a new niche's product sync:

1. Create `niches/{name}/` containing a module that exports an async `runSync()` function
   (see `niches/sweets/sync-sweets.js` for the reference implementation) plus any
   niche-specific config it needs (e.g. a pricing config JSON) — all scoped to that folder.
2. Add one line to the `NICHE_SYNCS` map in `index.js`:
   ```js
   const NICHE_SYNCS = {
     sweets: './niches/sweets/sync-sweets',
     yourniche: './niches/yourniche/sync-yourniche',
   };
   ```
3. Set a `{NAME}_SYNC_SECRET` env var on Render (e.g. `YOURNICHE_SYNC_SECRET`) — this is
   the value expected in the `x-sync-secret` header when calling
   `POST /sync/yourniche`. Each niche has its own secret; there is no shared/global sync
   secret.
4. Add a `niches/{name}/CLAUDE.md` documenting that niche the same way
   `niches/sweets/CLAUDE.md` does.

No other changes to `index.js` are needed — the route, auth, and error handling are fully
generic.

## Working on this repo

- Magnets' checkout-critical endpoints (`/quote`, `/price-checkout`, `/cart-discount`) live
  at the repo root alongside shared Express setup (CORS, rate limiting, health checks).
  Changes here can affect Magnets' live checkout — treat root-level `index.js` edits with
  the same caution regardless of which niche prompted the change.
- See `niches/sweets/CLAUDE.md` for Sweets-specific details.
