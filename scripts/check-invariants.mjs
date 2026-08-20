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
const SNAPSHOT = path.join(ROOT, "src", "data.snapshot.js");
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

/* DATA no longer lives in App.jsx. It is generated from the register into
   src/data.snapshot.js by tools/build_mapper_snapshot.py, precisely so that the
   figure this checker guards cannot be edited by hand into disagreeing with the
   register. Read it from there. */
function extractSnapshot() {
  const text = fs.readFileSync(SNAPSHOT, "utf8");
  const body = text.split("export const DATA = ")[1];
  if (!body) throw new Error("invariant checker: src/data.snapshot.js has no DATA export");
  return JSON.parse(body.replace(/;\s*export default DATA;\s*$/, "").trim());
}

const DATA = extractSnapshot();
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
const actualReady = DATA.records.filter((r) => r.decision_ready === true).length;
const actualStructural = DATA.records.filter((r) => r.structural_candidate === true).length;

if (DATA.meta.record_count !== actualRecords)
  fail(`meta.record_count says ${DATA.meta.record_count}, data holds ${actualRecords}`);
else pass(`record_count matches data (${actualRecords})`);

if (DATA.meta.decision_ready_count !== actualReady)
  fail(`meta.decision_ready_count says ${DATA.meta.decision_ready_count}, data holds ${actualReady}`);
else pass(`decision_ready_count matches data (${actualReady})`);

if (DATA.meta.structural_candidate_count !== actualStructural)
  fail(
    `meta.structural_candidate_count says ${DATA.meta.structural_candidate_count}, ` +
      `data holds ${actualStructural}`
  );
else pass(`structural_candidate_count matches data (${actualStructural})`);

/* ── The invariant this project needed and did not have ──────────────────────
   The mapper shipped `citable_count: 46` for weeks after the register had
   retracted it: 46 is the count of STRUCTURAL CANDIDATES, and the number of
   records the register will project as citable current law was 0. The defect
   was possible because one boolean, `citable`, stood for two different ideas.

   So: the legacy key survives for compatibility, but it must equal the STRICT
   gate. If anyone ever redefines it back to the loose one, the build stops. */
if (DATA.meta.citable_count !== undefined && DATA.meta.citable_count !== actualReady)
  fail(
    `legacy meta.citable_count says ${DATA.meta.citable_count} but the strict gate ` +
      `holds ${actualReady}. That key must mean decision-ready, never structural candidates.`
  );
else pass(`legacy citable_count is pinned to the strict gate (${actualReady})`);

const looseCitable = DATA.records.filter((r) => r.citable === true).length;
if (looseCitable !== actualReady)
  fail(
    `${looseCitable} records carry citable=true but only ${actualReady} are decision-ready`
  );
else pass(`per-record citable matches decision_ready (${actualReady})`);

if (actualStructural < actualReady)
  fail("structural candidates cannot be fewer than decision-ready records");
else pass("structural candidates >= decision-ready (gate ordering holds)");

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

// ── 5. index.html must not ship an ACTIVE placeholder tag ────────────────────
// Same discipline as check 1, applied to the page shell. Both of these actually shipped:
// an analytics beacon with an unreplaced token, firing a failed request on every page load
// and burying the real diagnosis; and the proxy slot, where a half-pasted placeholder URL
// would point every AI call at a host that does not exist. A commented-out template is fine
// — that is the documented off state — so comments are stripped before scanning.
const INDEX = path.join(ROOT, "index.html");
if (fs.existsSync(INDEX)) {
  const live = fs.readFileSync(INDEX, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const shells = [
    [/data-cf-beacon[^>]*PASTE_YOUR|data-cf-beacon[^>]*YOUR_CF_TOKEN/i, "analytics beacon with an unreplaced token"],
    [/__CBSR_LLM_PROXY__\s*=\s*["'][^"']*(YOUR-WORKER|YOUR_PROXY_SECRET)/i, "AI proxy slot with a placeholder URL"],
  ];
  let shellBad = false;
  for (const [re, what] of shells) {
    if (re.test(live)) { fail(`index.html ships an active ${what}`); shellBad = true; }
  }
  if (!shellBad) pass("index.html carries no active placeholder tag");
} else {
  fail("index.html not found next to package.json");
}

// ── 6. The built bundle must not carry a placeholder either ──────────────────
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
