# Deploying the CBSR mapper

## Build

Use Node.js 20.19 or later within the 20.x line, or Node.js 22.12 or later, and Python 3 on your PATH. CI uses Node.js 22 and Python 3.12. Vite and its React plugin are pinned in `package-lock.json`.

Keep the register checkout in a directory named `cross-border-stablecoin-register` beside this repository. Use the full commit SHA marked `SNAPSHOT_CONTRACT_REF` in [.github/workflows/deploy.yml](.github/workflows/deploy.yml). The build compares the mapper's three bundled snapshots with the outputs from that checkout.

```sh
git clone https://github.com/yunjiefanresearch-hub/cross-border-stablecoin-register.git
git clone https://github.com/yunjiefanresearch-hub/cbsr-mapper.git
git -C cross-border-stablecoin-register checkout --detach SNAPSHOT_CONTRACT_REF
cd cbsr-mapper
npm ci --ignore-scripts
npm run build
npm run preview
```

Replace `SNAPSHOT_CONTRACT_REF` with the SHA from the workflow. `npm run build` runs the API synchronization tests, data and snapshot checks, the production build and the bundled-asset checks. CI also runs `npm audit --audit-level=moderate`.

## Host the static site

- **GitHub Pages.** Under Settings → Pages → Build and deployment, set Source to GitHub Actions. The deployment workflow checks out both repositories, builds the mapper and publishes `dist/` on pushes to `main`.
- **Other static hosts.** Run the build with the sibling register checkout in place, then upload `dist/`. If the host builds from Git, configure its build environment to provide the same pinned register checkout.

For a site that embeds the mapper, set its `MAPPER_URL` to the deployed URL. The host must allow framing from the embedding site's origin.

## Configure an optional model proxy

The mapper defaults to deterministic mapping. For an individual self-hosted browser, set `window.__CBSR_DEMO__ = false` before the app's module script and rebuild. Document or URL import, automatic mapping and model-generated questions can then use an authenticated Anthropic Messages API proxy.

To deploy the example Cloudflare Worker in [worker/](worker/), use the Wrangler CLI:

```sh
cd worker
wrangler login
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put PROXY_SECRET
wrangler deploy
```

Use a long random value for `PROXY_SECRET`. A request to `https://cbsr-ai-proxy.<subdomain>.workers.dev/<PROXY_SECRET>` with `GET` returns a health check with `api_key_configured`. Paste the full endpoint into the mapper's proxy field for that browser. The mapper stores it in browser local storage and clears it when you apply an empty value. For a public deployment, keep the example Worker's credential-bearing endpoint private and use an authenticated proxy if enabling model features for visitors. Configure the Worker's `ALLOW_ORIGIN` for the mapper origin and rate-limit the route.

| Symptom | What to check |
| --- | --- |
| The proxy field is hidden | Set `window.__CBSR_DEMO__ = false` before the app script in your self-hosted build. |
| Health check reports `api_key_configured: false` | Set `ANTHROPIC_API_KEY` in the Worker. |
| Health check returns 503 or 404 | Check that `PROXY_SECRET` is set and that the URL's path matches it. |
| The browser cannot reach the proxy | Check the endpoint and the Worker's `ALLOW_ORIGIN`. |
| A model call returns 404 | Check the secret path and the `AI_MODEL` value in `src/App.jsx`. Some calls also require `web_search` access. |
| A model call returns 429 or 529 | Retry when the limit or upstream overload clears. |

## Regenerate the snapshots

With the register cloned beside this repository, generate the three modules from the same register commit:

```sh
python tools/build_mapper_snapshot.py --register ../cross-border-stablecoin-register --out src/data.snapshot.js
python tools/build_mapper_derived.py --register ../cross-border-stablecoin-register --mcp-out src/mcp.snapshot.js --compute-out src/compute.snapshot.js
npm run check:snapshots
```

Update the pinned register commit SHA in [.github/workflows/deploy.yml](.github/workflows/deploy.yml) and [.github/workflows/verify.yml](.github/workflows/verify.yml) in the same change. A full SHA makes the snapshot check reproducible across builds.
