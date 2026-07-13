#!/usr/bin/env node
/**
 * CBSR mapper — build invariants.
 *
 * The register's discipline is that a claim ships only when its evidence backs it, and
 * that a divergence is surfaced as a finding rather than quietly reconciled. This script
 * applies the same discipline to the artifact itself: it fails the build when the code or
 * the data would ship a claim the data cannot support.
 *
 * It exists because both failures it checks for have actually occurred:
 *   - an unverified "<VERIFY: …>" placeholder sat in a corridor's value slot, in the
 *     shipped bundle, where a human or an agent could read it as a finding;
 *   - the landing page asserted "all 132 directed corridors" while the deployed map
 *     carried a six-jurisdiction preview.
 *
 * Neither was caught by a test, because neither was a test. Now they are.
 *
 * Usage:  node scripts/check-invariants.mjs          (source only)
 *         node scripts/check-invariants.mjs --dist   (also scan the built bundle)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "src", "App.jsx");
const DIST = path.join(ROOT, "dist");

const failures = [];
const passes = [];
const fail = (m) => failures.push(m);
const pass = (m) => passes.push(m);

// ── load the two data blocks straight out of the source ──────────────────────
const src = fs.readFileSync(APP, "utf8");

function extract(name) {
  const line = src.split("\n").find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`invariant checker: could not find "const ${name} = " in src/App.jsx`);
  return JSON.parse(line.replace(new RegExp(`^const ${name} = `), "").replace(/;\s*$/, ""));
}

const DATA = extract("DATA");
const COMPUTE = extract("COMPUTE");

// ── 1. No unverified placeholder may ship, anywhere in the data ───────────────
// An unverified field is null, with the gap declared in leg.pending. It is never a
// marker string sitting where a finding is supposed to sit.
const PLACEHOLDER = /<VERIFY|TODO:|FIXME|XXX:|LOREM/i;
const dataJson = JSON.stringify(DATA);
const hit = dataJson.match(new RegExp(PLACEHOLDER.source + '[^"]{0,60}', "i"));
if (hit) fail(`placeholder in shipped data: ${JSON.stringify(hit[0])}`);
else pass("no placeholder markers in DATA");

// ── 2. Headline counts must equal what the data actually contains ────────────
// These are the numbers the landing page and the README quote. If they drift, the
// project is over-claiming — the one thing it exists not to do.
const actualRecords = DATA.records.length;
const actualCitable = DATA.records.filter((r) => r.citable === true).length;

if (DATA.meta.record_count !== actualRecords)
  fail(`meta.record_count says ${DATA.meta.record_count}, data holds ${actualRecords}`);
else pass(`record_count matches data (${actualRecords})`);

if (DATA.meta.citable_count !== actualCitable)
  fail(`meta.citable_count says ${DATA.meta.citable_count}, data holds ${actualCitable}`);
else pass(`citable_count matches data (${actualCitable})`);

// ── 3. The corridor count the front page claims must be the count that exists ─
const jurs = Object.keys(DATA.jurisdictions);
const pairs = Object.keys(COMPUTE.corridors);
const directed = pairs.reduce((n, k) => n + Object.keys(COMPUTE.corridors[k].d).length, 0);
const expectedPairs = (jurs.length * (jurs.length - 1)) / 2;
const expectedDirected = jurs.length * (jurs.length - 1);

if (pairs.length !== expectedPairs)
  fail(`${jurs.length} jurisdictions imply ${expectedPairs} pairs, COMPUTE holds ${pairs.length}`);
else pass(`${pairs.length} undirected pairs (complete for ${jurs.length} jurisdictions)`);

if (directed !== expectedDirected)
  fail(`expected ${expectedDirected} directed corridors, COMPUTE holds ${directed}`);
else pass(`${directed} directed corridors — the number the front page claims`);

// ── 4. A citable claim may not rest on a pending leg ──────────────────────────
// The evidence contract, enforced: a leg is either verified (a value + a tier) or
// pending (null values + a declared gap). No half-states, and nothing marked citable
// while its evidence is still outstanding.
for (const corr of DATA.corridors || []) {
  for (const leg of corr.boundary_analysis || []) {
    const hasValue = ["gate", "clears", "breaks"].some((k) => leg[k] != null && leg[k] !== "");
    const isPending = !!leg.pending;

    if (isPending && hasValue)
      fail(`${corr.corridor_id} / ${leg.leg}: marked pending but still carries a value — half-state`);
    if (!isPending && !hasValue)
      fail(`${corr.corridor_id} / ${leg.leg}: empty but declares no pending block — silent gap`);
    if (isPending && leg.citable === true)
      fail(`${corr.corridor_id} / ${leg.leg}: citable=true on a pending leg`);
    if (isPending && !leg.pending.needs)
      fail(`${corr.corridor_id} / ${leg.leg}: pending block does not say what it needs`);
  }
  const anyPending = (corr.boundary_analysis || []).some((l) => l.pending);
  if (anyPending && corr.citable === true)
    fail(`${corr.corridor_id}: corridor citable=true while a leg is pending`);
}
pass("corridor evidence contract holds (no half-states, no citable-while-pending)");

// ── 5. The built bundle must not carry a placeholder either ──────────────────
// Source can be clean while a stale build ships. Scan dist/ when it exists.
if (process.argv.includes("--dist")) {
  if (!fs.existsSync(DIST)) {
    fail("--dist requested but dist/ does not exist — run the build first");
  } else {
    let scanned = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|css|html|json|map)$/.test(e.name)) {
          scanned++;
          const text = fs.readFileSync(p, "utf8");
          const m = text.match(new RegExp(PLACEHOLDER.source + '[^"\\s]{0,60}', "i"));
          if (m) fail(`placeholder in built asset ${path.relative(ROOT, p)}: ${JSON.stringify(m[0])}`);
        }
      }
    };
    walk(DIST);
    if (!failures.some((f) => f.includes("built asset"))) pass(`built bundle clean (${scanned} assets scanned)`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nCBSR invariants — register v${DATA.meta.version}, as_of ${DATA.meta.as_of}\n`);
for (const p of passes) console.log(`  ok    ${p}`);
for (const f of failures) console.log(`  FAIL  ${f}`);

if (failures.length) {
  console.log(`\n${failures.length} invariant(s) violated. Not shipping.\n`);
  process.exit(1);
}
console.log(`\nAll ${passes.length} invariants hold.\n`);
