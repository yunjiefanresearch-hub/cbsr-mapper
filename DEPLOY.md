# Deploying the CBSR mapper

## Local

    npm install
    npm run dev        # http://localhost:5173
    npm run check      # invariants + snapshot drift
    npm run build

## The snapshot is generated, not pasted

`src/data.snapshot.js` is produced from the register and must not be hand-edited:

    python3 tools/build_mapper_snapshot.py \
      --register ../cross-border-stablecoin-register \
      --out src/data.snapshot.js

`npm run check` runs the same command with `--check` and exits 3 if the committed
snapshot and the register disagree. That gate is the point: the mapper shipped a
number the register had already retracted, and a generated-plus-verified snapshot
removes that whole class of defect rather than the one instance.

The generator also cross-checks its own gate against the register's reported
counts and aborts with `GATE DRIFT` if they diverge, so silently widening the
filter on either side fails loudly.

## Two numbers, never one

`meta.decision_ready_count` is the public gate (0 on the 2026-08-20 snapshot).
`meta.structural_candidate_count` is an inventory filter (46). The legacy
`citable` key is kept but redefined to the strict gate, so old call sites report
the honest number. Do not reintroduce a single "citable" figure into the UI.

## DEMO_MODE and the AI branch

`DEMO_MODE` should be `false` for a public deployment. The evaluate view is fully
deterministic: `src/policyMirror.js` reproduces the Python engine's gate order and
calls no model and no network. If you keep the AI branch, it must never be able
to write `source`, `pinpoint`, `evidence_tier`, or any gate field — CHARTER.md
commits the project to no tool inferring a citation.

## Pointing at a live register

Set `REGISTER_API` at the top of `src/App.jsx` to a deployed `api/` directory.
Make sure it serves `api/records.json`, which carries `source_disposition`,
`review_status` and `review_stage`; without those three the strict gate reads
undefined and every record is treated as not decision-ready. That failure
direction is safe, but it will hide real state.
