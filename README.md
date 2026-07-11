# CBSR mapper — deployment kit

This turns your `stablecoin-dimension-mapper` (already dropped in as `src/App.jsx`)
into a live URL you can visit and embed in the landing page.

The mapper depends **only on React** and ships its data snapshot and CSS inline, so the
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
npm install
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

Point the mapper at it — pick one:

- **Durable (recommended):** in `index.html`, uncomment the line and paste the full URL:
  ```html
  <script>window.__CBSR_LLM_PROXY__ = "https://cbsr-ai-proxy.<you>.workers.dev/<PROXY_SECRET>";</script>
  ```
  then rebuild (`npm run build`) and redeploy.
- **Per session:** run the app, and when the "AI unavailable" banner appears, paste the URL
  into its proxy field. Good for testing before you commit it.

### Security — read this before exposing the proxy
An open proxy spends **your** Anthropic credits. This kit gives you three levers:

1. **Secret path (built in).** Requests not hitting `/<PROXY_SECRET>` get a 404. Keep the
   secret out of public places.
2. **Origin lock (optional).** Set `ALLOW_ORIGIN` in `worker/wrangler.toml` `[vars]` to your
   site's origin to stop other web pages from calling it from a browser.
3. **Rate limiting (recommended).** Add a Cloudflare Rate Limiting rule on the Worker route.

Also note: the model string in the app is `claude-sonnet-4-6`, and some calls use the
`web_search` tool — both must be available on your Anthropic account. If a call returns an
error mentioning the tool, you may need to enable it (or add the relevant `anthropic-beta`
header in `worker.js`). None of this affects the deterministic core.

---

## Tier 3 — sync the live register (optional)

By default the map runs on the data snapshot baked into `src/App.jsx`. To have it pull the
current register instead, set `REGISTER_API` near the top of `src/App.jsx` to your deployed
CBSR `api/` directory (the one that serves `records.json` and `meta.json`), then rebuild:

```js
const REGISTER_API = "https://<username>.github.io/<register-repo>/api";
```

If the fetch fails, the app silently falls back to the bundled snapshot.

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
