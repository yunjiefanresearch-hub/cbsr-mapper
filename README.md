[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14172/badge)](https://www.bestpractices.dev/projects/14172)

# CBSR mapper

The interactive corridor map for the [Cross-Border Stablecoin Register](https://github.com/yunjiefanresearch-hub/cross-border-stablecoin-register) (CBSR), an independent research project maintained by Yunjie Fan. Visit the [project website](https://cbsr.site/) for the data and research.

The mapper shows the register's dimension map for twelve jurisdictions, its 132 directed corridors and the 12 × 12 corridor matrix. The timeline recomputes corridor classes as dated events in the register take effect. The map, matrix, timeline and dataset exports run in the browser and can use the bundled register snapshot.

The optional document or URL import, automatic mapping and question generation features use a separate model proxy. The public build uses deterministic mapping. A self-hosted build with a proxy can include model-generated questions in a research briefing. Citations, evidence flags and dataset exports come from the register.

## Data and versions

- **Snapshot date.** `DATA.meta.as_of` identifies the dated register snapshot. Source checks and review status are tracked per record. In v0.11.0 (20 August 2026), 46 of 152 records meet the structural filter and zero are decision-ready.
- **Timeline.** The timeline applies scheduled events in the register when their date is reached. Contingent events stay pending until a date is recorded. The snapshot baseline shows the state at the time of the dataset build.
- **Versions.** `package.json` versions the mapper build and interface. `DATA.meta.version` versions the register snapshot and appears in the BibTeX and CITATION.cff exports.
- **Public register API.** The mapper compares the bundled snapshot with the [public register API](https://yunjiefanresearch-hub.github.io/cross-border-stablecoin-register/api/meta.json). An accepted response must match the bundled version and generation date, cover the complete record-ID set and reconcile its gate counts. The mapper retains the bundled snapshot if a check fails. Set `window.__CBSR_REGISTER_API__` to an empty string to disable the API check.

## Run locally

Use Node.js 20.19 or later within the 20.x line, or Node.js 22.12 or later. The build also requires Python 3 and a sibling checkout of the register at the commit pinned by CI. Follow the [checkout instructions](DEPLOY.md#build), then run:

```sh
npm ci --ignore-scripts
npm run build
npm run preview
```

See [DEPLOY.md](DEPLOY.md) for hosting, snapshot regeneration and optional proxy configuration.

## How it was built

The code was written with AI coding assistants. The legal records come from the register, where the maintainer records their sources and review states. See the [register's methodology](https://cbsr.site/method.html).
