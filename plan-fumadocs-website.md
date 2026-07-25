# Plan — Fumadocs website (landing + docs + blog) for OurGlass

## Goal

Move the OurGlass public face into a Fumadocs project so we get docs + blog for
free, while keeping the Safe App addable exactly as today.

Target URLs, all on `hourglass.box` (unchanged Safe App registration):

- `/` → landing page (now rendered by Fumadocs, OurGlass branding)
- `/docs` → documentation (Fumadocs docs)
- `/blog` → blog (Fumadocs collection)
- `/safe-app` → the existing Vite Safe App (assets + SPA)
- Safe iframe still loads `/` → detects iframe → redirects to `/safe-app`

## Repo layout (decided) — staged to keep merges easy

Target end state is two workspaces:

```
OurGlass/
  safe-app/      # the Vite + React Safe App (eventual home)
  website/       # new Next.js 16 + Fumadocs 16 site
  Caddyfile      # reverse-proxy routing for both
  Dockerfile     # build both, serve via Caddy
```

**But the physical move is deferred.** More safe-app work merges today; a
whole-tree `git mv src/ → safe-app/src/` would conflict with any concurrent
branch. So we stage it:

- **PR #1 (this work) — additive.** Add the new `website/` folder. The Vite app
  **stays at repo root**, untouched except four small edits: `vite.config.ts`
  (`base: '/safe-app/'`), `main.tsx` (iframe/redirect + move special routes under
  `/safe-app/*`), `Caddyfile`, `Dockerfile`. Big new surface = `website/` only →
  trivial to merge alongside today's safe-app commits.
- **PR #2 (later) — the rename.** Once today's safe-app work is merged, relocate
  the Vite source into `safe-app/`. Pure move, no concurrent edits, clean.

`.claude/`, `spec/`, `FUTURE.md`, `PLAN.md`, `README.md`, `CLAUDE.md` stay at root
throughout.

## Branding (decided)

- **Layout/structure**: copy intuition.box's Fumadocs conventions — `(home)` vs
  `/docs` route groups, `baseOptions()` nav, `source.config.ts` with
  `defineDocs` + `defineCollections`, `lib/source.ts` loaders, RSS, sitemap.
- **Identity**: OurGlass, not intuition.box. Carry over the *current* design
  system from `safe-app/src/index.css` (NOT the stale "blue glass" in CLAUDE.md):
  - base `#0a0a0b`, surfaces `#101012/#161618/#1c1c1f`, hairline lines `#2e2e33`
  - **mint accent `#58e6b8`**, **stream-blue `#3aa3ff`** (the signature gradient)
  - fonts: Inter (sans) + JetBrains Mono (mono/data)
  - the `stream-edge` right-rail animation, `prefers-reduced-motion` gating
  - the sablier `Logo` component + `logo.svg` favicon (ported to the website)
- **intuition.box logo**: NOT the primary mark. Appears only in the footer, e.g.
  "Made by intuition.box contributors" with a small logomark linking to
  intuition.box. Dark-first, `defaultTheme: 'dark'`, no theme switch.

## Architecture: serving both on one domain

### The root-URL conflict (and the fix)

`/` must answer two callers: a human browser (→ landing) and the Safe iframe
(→ boot the app). Today `safe-app/src/main.tsx` already distinguishes them with
`inSafeIframe = window.self !== window.top`. We move that decision up a level:

1. **Caddy** routes by path:
   - `/safe-app/*` → the built Vite SPA (with the existing CORS + cache headers,
     `try_files … /safe-app/index.html` for client routing)
   - `/`, `/docs/*`, `/blog/*`, everything else → the Fumadocs (Next.js) site
   - `/manifest.json`, `/logo.svg` served at root (Safe fetches these)
2. **Fumadocs landing** carries a tiny client guard: if `window.top !== window.self`
   redirect the iframe to `/safe-app`. Normal top-level visitors never trigger it.
3. **Vite app** (`safe-app`) sets Vite `base: '/safe-app/'`; its `main.tsx`
   `!inSafeIframe` branch (the old `<Landing/>`) becomes a redirect to `/` (the
   landing now lives in Fumadocs). `/redeem`, `/pitch`, `/verify` move under
   `/safe-app/redeem` etc. (or stay special-cased — see Open questions).

### Why this keeps the Safe App registration intact

Safe fetches `<url>/manifest.json` (served at root) and frames `<url>` (root).
The landing's iframe guard redirects the framed view to `/safe-app`, where the
SPA boots and the safe-apps-sdk handshake runs over `postMessage` to
`window.parent` — path-independent. **Risk to verify**: confirm Safe tolerates
the iframe navigating to a subpath after load (see Risks).

## Fumadocs site setup (mirrors intuition.box)

- **Stack**: Next.js 16, `fumadocs-core`/`fumadocs-ui` 16.x, `fumadocs-mdx` 14.x,
  Tailwind v4 (`@tailwindcss/postcss`, no config file), npm. Scripts:
  `dev`/`build`/`start`, `postinstall: fumadocs-mdx`.
- **`source.config.ts`**: `defineDocs({ dir: 'content/docs' })` +
  `defineCollections({ type:'doc', dir:'content/blog', schema: pageSchema.extend({author,date,tags?,description,cover_image?}) })`.
- **`src/lib/`**: `source.ts` (docs loader, lucide icons plugin), `blog-source.ts`,
  `shared.ts` (appName 'OurGlass', siteUrl, routes, github/X/discord links),
  `layout.shared.tsx` (`baseOptions()` nav: Docs, Blog, GitHub, "Open the app" →
  `/safe-app`).
- **`src/app/`**: root `layout.tsx` (RootProvider dark, Inter font, OurGlass
  tokens in `global.css`), `(home)/layout.tsx` (HomeLayout + Footer),
  `(home)/page.tsx` (the ported landing), `(home)/blog/*`, `docs/layout.tsx`,
  `docs/[[...slug]]/page.tsx`, `sitemap.ts`, `robots.ts`.
- **`public/`**: `logo.svg`, `manifest.json` (the Safe manifest — served at root),
  `hero.mp4` (landing video), favicon.

## Landing port

Reproduce `safe-app/src/pages/Landing.tsx` as `(home)/page.tsx`:

- Same hero copy ("Recurring payments for DAO treasuries."), the five
  Sign-once/Capped/Non-custodial/Charged/Revocable feature lines.
- The `stream-edge` right rail + `hero.mp4` right-half video, reduced-motion gated.
- Nav CTAs: "Add to your Safe" → `https://app.safe.global`; "Claim your payment"
  → `/safe-app/redeem`; "GitHub" → repo. "Docs" and "Blog" added to nav.
- Replace hard-coded design values with the shared OurGlass tokens in `global.css`.

## Documentation content (draft now)

`content/docs/` initial tree (with `meta.json` ordering):

1. `index.mdx` — What OurGlass is: one signature, capped on-chain, non-custodial,
   revocable. The two products: **subscriptions** (per-period cap, resets) and
   **streams** (linear accrual, claim anytime).
2. `concepts/delegation.mdx` — the single EIP-712 delegation, terms pinned to
   IPFS, salt = `keccak256(terms)`, the DelegationManager, redeem vs revoke.
3. `concepts/subscriptions.mdx` — `erc20PeriodTransfer` caveat: periodAmount,
   periodDuration, startDate, per-period reset, charge-twice no-op.
4. `concepts/streams.mdx` — **NEW**: `erc20Streaming` caveat
   (`ERC20StreamingEnforcer`): initialAmount, **maxAmount** (cumulative lifetime
   cap, neutralized to `type(uint256).max`), amountPerSecond, startTime;
   `available(t) = min(maxAmount, initialAmount + amountPerSecond·(t−startTime))`;
   contrast with subscriptions (accrues vs resets).
5. `guides/create.mdx`, `guides/charge-claim.mdx`, `guides/revoke.mdx` — the flows.
6. `guides/safe-app.mdx` — add OurGlass to your Safe (the registration URL).
7. `security.mdx` — see rework below.
8. `analytics.mdx` — see rework below.

`content/blog/`: one launch post (`hello-ourglass.mdx`) as the seed.

### Rework analytics + security for the stream enforcer (do this FIRST)

Source material: `spec/plan-analytics.md`, `spec/plan-fee-collector.md` (the
"Trust model" / "Risks" sections). Both predate the streaming enforcer and only
cover `ERC20PeriodTransferEnforcer`. Rework into doc pages:

- **`analytics.mdx`** — generalize the "redeploy the audited enforcer as the
  attribution marker" approach to **both** enforcers:
  - subscriptions → `ERC20PeriodTransferEnforcer.TransferredInPeriod`
  - streams → the streaming enforcer's transfer/redeem event (confirm exact event
    name + fields against `@metamask/delegation-abis`; streams are claim-based, so
    per-claim amount, not per-period delta).
  - One attribution story: index events whose emitter = our deployed enforcer
    instance(s). Note we now maintain **two** self-deployed enforcer instances.
- **`security.mdx`** — consolidate the trust model:
  - on-chain enforcement is the only guarantee; caveat = cap not meter.
  - subscriptions: per-period cap; streams: rate + `maxAmount` cap, and the
    explicit decision that `maxAmount` is neutralized to uint256.max so the
    *rate* is the binding limit — state the exposure that creates and that revoke
    (`disableDelegation`) is the off-ramp.
  - signature/replay protection (EIP-712 domain + salt), bytecode-integrity
    requirement for any self-deployed enforcer instance, non-custodial posture,
    IPFS-pinned terms bound by salt.

Keep these as living docs; the `spec/*.md` files remain the internal planning
source. Record any non-obvious doc decision per `.claude/rules/workflow.md`.

## Deployment (Caddy + Docker) — static, single process, no Coolify change

**Decided: Next.js static export (`output: 'export'`).** The site is landing +
docs + blog with no dynamic data, so static export is the right fit and keeps the
container model identical to today (Caddy serving static files on `:80`, single
process, no Node runtime). This is what lets the **Coolify config stay unchanged**
— same exposed port, same container shape — so the **auto preview deploy on the
PR works without any Coolify interface change**. (RSS/sitemap become static build
outputs; Fumadocs search uses its static index. We forgo only server-only
features we don't need: ISR, runtime OG generation, API routes.)

- **Dockerfile** → multi-stage: (a) `npm run build` the Vite app with
  `base:/safe-app/` → `dist/`; (b) `next build` (export) the website →
  `website/out/`; (c) final Caddy image serves `website/out` at `/` and the Vite
  `dist` under `/safe-app`.
- **Caddyfile** → extend the current one: keep CORS + cache + `-X-Frame-Options`
  for `/safe-app/*` and `/manifest.json`; serve the static export for everything
  else; SPA fallback to `/safe-app/index.html` under `/safe-app/*`, Fumadocs
  static routing elsewhere. Still one site block on `:80`.
- **Coolify caveat**: if anything here turns out to need a Coolify *interface*
  change (exposed port, build command, env), it can NOT be validated on the prod
  preview — flag it and test on a separate env first. The static-export design is
  chosen specifically to avoid this.

## Execution order

**PR #1 (this work):**

1. **Scaffold `website/`** mirroring intuition.box (Next 16 + Fumadocs 16, static
   export). Port OurGlass tokens (mint + stream-blue, Inter/JetBrains) + Logo.
   Get `npm run dev` and `next build` green.
2. **Port the landing** into `(home)/page.tsx`; wire nav/footer (footer carries
   "Made by intuition.box contributors").
3. **Docs**: rework `analytics.mdx` / `security.mdx` FIRST (stream enforcer), then
   concept/guide pages incl. `streams.mdx`. Seed one blog post.
4. **Wire routing without moving the Vite source**: `vite.config.ts`
   `base:'/safe-app/'`; `main.tsx` move `/redeem|/pitch|/verify` under
   `/safe-app/*` and redirect top-level `/safe-app` → `/`; add the iframe guard on
   the Fumadocs landing → `/safe-app`.
5. **Deployment**: update Dockerfile (build both) + Caddyfile (serve export at `/`,
   SPA under `/safe-app`, manifest at root). Verify locally that `/`, `/docs`,
   `/safe-app` and the iframe path resolve. Keep Caddy on a single `:80`.
6. **Open PR → Coolify preview deploy**; validate the Safe-iframe→`/safe-app`
   handshake on the preview.

**PR #2 (after today's safe-app work merges):** relocate the Vite source into
`safe-app/` (pure move).

## Risks

- **Safe iframe subpath redirect** — the core assumption. Verify the apps-sdk
  handshake survives the iframe navigating `/` → `/safe-app`. Fallback if not:
  register the Safe App at `/safe-app` directly (requires re-adding the app in
  Safe — avoid if possible) or serve the SPA at root and the landing at a path.
- **Two runtimes, one container** — Next server + static SPA behind Caddy adds
  deploy complexity vs today's single Caddy static serve.
- **Stale CLAUDE.md branding** — it says "blue glass"; the real system is mint +
  stream-blue. Use `index.css`, and update CLAUDE.md afterward.
- **Streaming enforcer event shape** — analytics rework must confirm the exact
  event/fields from `@metamask/delegation-abis`, not assume.

## Open questions — RESOLVED

1. `/redeem`, `/pitch`, `/verify` → **move under `/safe-app/*`** (`/safe-app/redeem`,
   `/safe-app/pitch`, `/safe-app/verify`).
2. Next.js delivery → **static export (`output:'export'`)**, served by Caddy.
3. Testing → **Coolify auto preview deploy on the PR**. Caveat: if a Coolify
   interface config change is required, validate on a separate env, not the prod
   preview.
