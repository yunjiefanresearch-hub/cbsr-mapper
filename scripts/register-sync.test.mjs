import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REGISTER_API,
  configuredRegisterApi,
  prepareRegisterSync,
} from "../src/registerSync.js";
import { DATA } from "../src/data.snapshot.js";
import { COMPUTE } from "../src/compute.snapshot.js";

const VERSION = "0.11.0";
const GENERATED = "2026-08-20";

function fixtures() {
  const bundledData = {
    meta: {
      version: VERSION,
      generated: GENERATED,
      as_of: GENERATED,
      record_count: 2,
      structural_candidate_count: 0,
      decision_ready_count: 0,
      citable_count: 0,
    },
    records: [
      { id: "alpha", jur: "US", dimension: "issuer_pathway", requirement_summary: "old" },
      { id: "beta", jur: "EU", dimension: "redemption", requirement_summary: "old" },
    ],
  };
  const recordsPayload = {
    register: "cross-border-stablecoin-register",
    version: VERSION,
    generated: GENERATED,
    endpoint: "records",
    data: [
      {
        id: "alpha",
        requirement_summary: "current projection",
        status: "in_force",
        claim_class: "tier1_legal",
        binding_status: "in_force_enacted",
        evidence_tier: "resolution_text",
        source_disposition: "official",
        review_status: "current",
        review_stage: "reconciled",
        source: { primary: "Act", pinpoint: "s 1", url: "https://example.test/act" },
      },
      {
        id: "beta",
        status: "in_force",
        claim_class: "tier1_legal",
        binding_status: "in_force_enacted",
        evidence_tier: "resolution_text",
        source_disposition: "official",
        review_stage: "primary_reviewed_second_pending",
        freshness: { review_status: "current" },
        source: { primary: "Regulation", pinpoint: "art 2", url: "https://example.test/reg" },
      },
    ],
  };
  const metaPayload = {
    register: "cross-border-stablecoin-register",
    version: VERSION,
    generated: GENERATED,
    endpoint: "meta",
    data: {
      version: VERSION,
      record_count: 2,
      structural_citable_candidates: 2,
      citable_count: 1,
      review_coverage: { reconciled: 1 },
    },
  };
  const compute = { _artifact: { register_version: VERSION, generated: GENERATED } };
  return { bundledData, recordsPayload, metaPayload, compute };
}

test("uses the public Register API by default and permits an explicit offline override", () => {
  assert.equal(configuredRegisterApi({}), DEFAULT_REGISTER_API);
  assert.equal(configuredRegisterApi({ __CBSR_REGISTER_API__: " https://local.test/api/// " }), "https://local.test/api");
  assert.equal(configuredRegisterApi({ __CBSR_REGISTER_API__: "" }), "");
});

test("unwraps API envelopes and projects all six decision axes", () => {
  const input = fixtures();
  const before = structuredClone(input.bundledData);
  const prepared = prepareRegisterSync(input);

  assert.deepEqual(input.bundledData, before, "validation must not mutate the fallback snapshot");
  assert.equal(prepared.sync.status, "verified");
  assert.equal(prepared.records[0].requirement_summary, "current projection");
  assert.equal(prepared.records[0].source_disposition, "official");
  assert.equal(prepared.records[0].review_status, "current");
  assert.equal(prepared.records[0].review_stage, "reconciled");
  assert.equal(prepared.records[0].structural_candidate, true);
  assert.equal(prepared.records[0].decision_ready, true);
  assert.equal(prepared.records[0].citable, true);
  assert.equal(prepared.records[1].review_status, "current", "freshness fallback is supported");
  assert.equal(prepared.records[1].decision_ready, false, "second review remains a hard gate");
  assert.equal(prepared.meta.structural_candidate_count, 2);
  assert.equal(prepared.meta.decision_ready_count, 1);
});

test("rejects a newer records layer instead of mixing it with bundled computation", () => {
  const input = fixtures();
  input.recordsPayload.version = "0.12.0";
  assert.throws(() => prepareRegisterSync(input), /snapshot_mismatch: version differs/);
});

test("rejects a same-version rebuild with a different generated date", () => {
  const input = fixtures();
  input.recordsPayload.generated = "2026-08-21";
  assert.throws(() => prepareRegisterSync(input), /snapshot_mismatch: generated date differs/);
});

test("rejects invalid date suffixes and impossible calendar dates", () => {
  for (const date of ["2026-08-20junk", "2026-02-30", "not-a-date"]) {
    const input = fixtures();
    input.recordsPayload.generated = date;
    assert.throws(() => prepareRegisterSync(input), /invalid_identity/);
  }
});

test("requires both declared gate counts instead of accepting a partial contract", () => {
  for (const key of ["structural_citable_candidates", "citable_count"]) {
    const input = fixtures();
    delete input.metaPayload.data[key];
    assert.throws(() => prepareRegisterSync(input), /missing_gate_counts/);
  }
});

test("rejects partial projections and declared gate-count drift", () => {
  const partial = fixtures();
  partial.recordsPayload.data.pop();
  partial.metaPayload.data.record_count = 1;
  assert.throws(() => prepareRegisterSync(partial), /remote record count 1 differs from bundled 2/);

  const wrongGate = fixtures();
  wrongGate.metaPayload.data.citable_count = 2;
  assert.throws(() => prepareRegisterSync(wrongGate), /gate_count_mismatch/);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const registerApi = path.join(root, "cross-border-stablecoin-register", "api");
test(
  "accepts the pinned Register's real public API envelopes",
  { skip: !fs.existsSync(path.join(registerApi, "records.json")) },
  () => {
    const recordsPayload = JSON.parse(
      fs.readFileSync(path.join(registerApi, "records.json"), "utf8"),
    );
    const metaPayload = JSON.parse(fs.readFileSync(path.join(registerApi, "meta.json"), "utf8"));
    const prepared = prepareRegisterSync({ recordsPayload, metaPayload, bundledData: DATA, compute: COMPUTE });
    assert.equal(prepared.records.length, DATA.meta.record_count);
    assert.equal(prepared.meta.decision_ready_count, DATA.meta.decision_ready_count);
    assert.equal(prepared.sync.status, "verified");
  },
);
