[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14172/badge)](https://www.bestpractices.dev/projects/14172)

# CBSR mapper — deployment kit

This turns your `stablecoin-dimension-mapper` (already dropped in as `src/App.jsx`)
into a live URL you can visit and embed in the landing page.

The mapper depends **only on React** and ships generated data/compute/MCP snapshots with its CSS, so the
**deterministic core** — the dimension map, corridors, the 12×12 matrix, time-travel, and
exports — runs fully client-side with **zero configuration** and **no model calls**.
The AI features (document / URL import, auto-map, question generation) are optional and
need an authenticated proxy (Tier 2).

```
cbsr-mapper-deploy/
├── index.html               Vite entry (+ optional AI-proxy slot)
├── package.json             React + Vite only
├── vite.config.js           relative base → works on Pages / Netlify / Vercel
├── src/
│   ├── main.jsx             mounts <App/>
│   └── App.jsx              YOUR mapper, unchanged
├── worker/                  optional AI proxy (Tier 2)
│   ├── worker.js
│   └── wrangler.toml
└── .github/workflows/
    └── deploy.yml           optional auto-deploy to GitHub Pages
```

---

## Tier 1 — deploy the map (deterministic, zero config)

Requires Node.js 18+.

```bash
npm ci --ignore-scripts
npm run build      # outputs static files to dist/
npm run preview    # optional: preview the production build locally
```

`dist/` is a static site. Deploy it any way you like:

- **GitHub Pages (automated).** Push this folder to a repo. In the repo, go to
  Settings → Pages → Build and deployment → Source → **GitHub Actions**. The included
  `.github/workflows/deploy.yml` builds and publishes on every push to `main`. Your map
  lands at `https://<username>.github.io/<repo>/`.
- **Netlify.** Drag the `dist/` folder onto app.netlify.com/drop, or connect the repo with
  build command `npm run build` and publish directory `dist`.
- **Vercel.** Import the repo; Vercel detects Vite automatically (build `npm run build`,
  output `dist`).
- **Any static host / local.** Serve `dist/` with anything (`npx serve dist`, S3, nginx…).

That URL is what you paste into the landing page (see "Embed" below). You're done unless
you want the AI features.

---

## Tier 2 — turn on the AI features (optional)

The import / auto-map / question-generation features POST to the Anthropic API. On a static
host those calls have no credentials, so you front them with a tiny proxy that holds your
API key. `worker/` is a ready Cloudflare Worker.

```bash
npm install -g wrangler
cd worker
wrangler login
wrangler secret put ANTHROPIC_API_KEY     # paste your Anthropic API key
wrangler secret put PROXY_SECRET          # paste a long random string (e.g. 32+ chars)
wrangler deploy
```

Wrangler prints a URL like `https://cbsr-ai-proxy.<you>.workers.dev`. Your proxy endpoint is
that URL **plus the secret path**:

```
https://cbsr-ai-proxy.<you>.workers.dev/<PROXY_SECRET>
```

**Verify it before wiring it up.** Open that exact URL in a browser tab. The Worker answers a
`GET` with a JSON health check and spends no tokens:

```json
{ "ok": true, "service": "cbsr-ai-proxy", "secret_path": "matched", "api_key_configured": true }
```

- JSON with `api_key_configured: true` → you are done; paste the same URL into the mapper.
- JSON with `api_key_configured: false` → run `wrangler secret put ANTHROPIC_API_KEY`.
- `503` naming `PROXY_SECRET` → run `wrangler secret put PROXY_SECRET`.
- `not found` (404) → the path segment does not match your secret. Check for a typo, and note
  that a trailing slash is now stripped by both the Worker and the app, so that is no longer it.

Point the mapper at it — pick one:

- **Durable, everyone (recommended):** in `index.html`, uncomment the line and paste the full URL:
  ```html
  <script>window.__CBSR_LLM_PROXY__ = "https://cbsr-ai-proxy.<you>.workers.dev/<PROXY_SECRET>";</script>
  ```
  then rebuild (`npm run build`) and redeploy.
- **Durable, just you, no rebuild:** run the app and paste the URL into the field in the
  "AI features are off" banner. It applies immediately and is remembered in that browser
  (clear the field and Apply to forget it). Good for testing before you commit it, and good
  if you would rather not put the secret in a public repo at all.

### Security — read this before exposing the proxy
An open proxy spends **your** Anthropic credits. This kit gives you three levers:

1. **Secret path (built in).** Requests not hitting `/<PROXY_SECRET>` get a 404. Keep the
   secret out of public places.
2. **Origin lock (optional).** Set `ALLOW_ORIGIN` in `worker/wrangler.toml` `[vars]` to your
   site's origin to stop other web pages from calling it from a browser.
3. **Rate limiting (recommended).** Add a Cloudflare Rate Limiting rule on the Worker route.

Also note: the model string lives in one place — `AI_MODEL` at the top of `src/App.jsx`
(currently `claude-sonnet-4-6`) — and some calls use the `web_search` tool. Both must be
available on your Anthropic account. Verify the model string your account actually serves at
<https://docs.claude.com> before going live: a wrong string returns **HTTP 404**, not a network
error, which is why the app now reports 404 separately. None of this affects the deterministic
core.

---

## Troubleshooting — what each message actually means

The app used to report every failed model call as "network error", which sent people to check
their wifi when the real cause was configuration. Each failure mode is now named separately:

| What you see | What it actually is | Fix |
| --- | --- | --- |
| **No model proxy is configured** | `LLM_PROXY` is `""`, `window.__CBSR_LLM_PROXY__` is still commented out, and nothing was pasted in the UI. The browser POSTs straight to `api.anthropic.com`, which is refused at the CORS preflight and carries no key. | Tier 2 above. Deploy the Worker, paste the URL. |
| **A proxy is configured but the request never left the browser** | Wrong URL, Worker not deployed, `ALLOW_ORIGIN` does not include your site's origin, or DNS. | Open the proxy URL in a tab (health check). If that works but the app does not, it is `ALLOW_ORIGIN`. |
| **The proxy rejected the request (401 / 403)** | The proxy was reached; the API key is missing or invalid. | `wrangler secret put ANTHROPIC_API_KEY` |
| **The proxy returned 404** | Server reached, no route matched: usually a wrong secret path segment, sometimes a model string your account does not serve. | Check the secret segment and `AI_MODEL`. |
| **429 / 529** | Rate limit / upstream overload. Transient. | Wait and retry; the app already backs off. |
| **Question generation failed: N entries have no questions** | Same causes as above — question generation is a model call like any other. The reason is now shown inline with a **Retry only the missing questions** button. | Fix the proxy, then retry. Records, pinpoints, citable flags and every export are model-free and remain valid meanwhile. |

Two things that used to muddy this picture and are now fixed:

- `index.html` shipped a Cloudflare Web Analytics beacon with an unreplaced token, so **every**
  page load logged a failed request in the console that had nothing to do with the app. The tag
  is commented out by default; paste a real token to enable it.
- A trailing slash on the proxy URL turned a correct configuration into a 404. Both the Worker
  and the app now normalise it away.

---

## The two dates: snapshot vs today

### Build security baseline

Use Node.js 22.12 or newer (the exact supported range is in `package.json`). The
reviewed build uses Vite 8.3.0 and React plugin 6.1.1, locked in `package-lock.json`.
`npm ci --ignore-scripts` reproduces that dependency graph. Run `npm audit` for a
fresh advisory check; the 10 September 2026 installation reported no known
vulnerabilities. This is not a claim that the software has no vulnerabilities.

This upgrade addresses the old Vite/esbuild development-server advisory chain,
including [the Windows file-deny bypass](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff).
The production build and bundled snapshot checks are still mandatory before deploy.

The register is a **dated** artifact, and the tool keeps two clocks apart on purpose:

- **`DATA.meta.as_of`** — the published dataset build date, not proof that every provision was verified. Frozen. It is what the citation
  discipline rests on, and it never silently becomes "today". Shown as "data snapshot as of …".
- **The real calendar day** — used by the time engine. The dated commencements baked into
  `COMPUTE` (US GENIUS §18 outer cap `2027-01-18`, UK SI 2026/102 gazetted `2027-10-25`) are
  *published facts*, so once a real day passes one of them the corridor classes recompute on
  their own. Previously they did not: `composeCorridorClasses(null)` skipped every dated
  transition, so on 2027-10-26 the tool would still have drawn the pre-commencement world.

The timeline therefore shows both, and the slider carries a **data snapshot baseline** stop so
you can always see the state the register itself saw. Contingent triggers with no gazetted date
(`kr-daba-enacted`, `tw-vas-act-commencement`) still do **not** auto-apply — that is the register's
scheduled-vs-contingent discipline and it is unchanged.

The public API check never advances this layer independently. Records are loaded only when
`records.json`, `meta.json`, `DATA`, and `COMPUTE` all identify the same version and generated
date. A newer records response therefore cannot be mixed with an older corridor computation.

### Two version numbers, deliberately different

`package.json` versions the **deploy kit** (this build tooling and UI). `DATA.meta.version`
versions the **register snapshot** and is citation-bearing — it appears in the BibTeX and
CITATION.cff exports. Fixing a UI bug bumps the first and must not touch the second.

---

## Tier 3 — verify against the public register API

By default the map checks its generated snapshots against the canonical public endpoint:

```js
https://yunjiefanresearch-hub.github.io/cross-border-stablecoin-register/api
```

Set `window.__CBSR_REGISTER_API__` before the application script to select a mirror. Set it to
the empty string to run fully offline. The response must use the published envelopes
(`records.json.data` is the record array and `meta.json.data` is metadata), contain the complete
record-id set, reproduce the strict six-axis gate counts, and match the bundled register version
and generated date. On any network or contract failure the banner explicitly reports a fallback;
no part of the rejected response is applied.

### Updating the three generated snapshots

Clone the Register as a sibling, then regenerate and verify all three surfaces together:

```bash
python tools/build_mapper_snapshot.py --register ../cross-border-stablecoin-register --out src/data.snapshot.js
python tools/build_mapper_derived.py --register ../cross-border-stablecoin-register --mcp-out src/mcp.snapshot.js --compute-out src/compute.snapshot.js
npm run check:snapshots
```

`data.snapshot.js`, `mcp.snapshot.js`, and `compute.snapshot.js` are one contract unit. The full
Register commit SHA under `SNAPSHOT_CONTRACT_REF` in `.github/workflows/deploy.yml` must be updated
in the same change. Never replace it with `main`: a moving branch would make an otherwise
reproducible mapper build depend on merge timing.

---

## Embed it in the landing page

Once the map has a URL (Tier 1), open the landing page's `index.html`, find the config line
near the bottom of the `<script>`, and paste that URL:

```js
var MAPPER_URL = "https://<username>.github.io/<repo>/";
```

The landing page's "the live register" section switches from the corridor preview to an
iframe of the full map, with an "Open full-screen" link. If the map and the landing page are
on different domains, that's fine — just don't set an `X-Frame-Options: DENY` / CSP
`frame-ancestors` header on the map host (Pages / Netlify / Vercel don't by default).
