import { chromium } from "playwright";   // npx playwright install chromium
import path from "node:path";

const FILE = "file://" + path.resolve(process.argv[2] || "demo/mapper.html");

const b = await chromium.launch();
const ctx = await b.newContext();
// Nothing may leave the machine. Any attempt is a bug in the offline build.
const escaped = [];
await ctx.route("**", (route) => {
  const u = route.request().url();
  if (!u.startsWith("file://") && !u.startsWith("data:") && !u.startsWith("blob:")) {
    escaped.push(u);
    return route.abort();
  }
  return route.continue();
});

const p = await ctx.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));

await p.goto(FILE);
await p.waitForSelector("#root .wrap", { timeout: 10000 });

const out = [];
const check = (n, ok, d) => out.push({ n, ok, d: d || "" });

check("app mounts with no network access", true);
check("nothing requested off the machine", escaped.length === 0, escaped.join(", "));

// ── no AI failure surface anywhere ──────────────────────────────────────────
for (const [label, sel] of [
  ["no 'AI is off' banner", ".aioff"],
  ["no proxy input box", ".aioff-cfg-input"],
  ["no document/URL import block", ".import"],
  ["no degraded run button", ".run-off"],
]) check(label, (await p.locator(sel).count()) === 0);

const bodyText = await p.innerText("#root");
for (const [label, needle] of [
  ["no CORS/proxy wording on screen", "CORS"],
  ["no Cloudflare Worker instructions", "workers.dev"],
  ["no README Tier 2 pointer", "Tier 2"],
]) check(label, !bodyText.includes(needle));

// ── the map flow runs end to end ────────────────────────────────────────────
await p.click(".ex-chip >> nth=0");           // load the first worked example
await p.click(".jur >> nth=0");               // add a second jurisdiction (US)
await p.click(".run");
await p.waitForSelector(".dim-block", { timeout: 8000 });

const dims = await p.locator(".dim-block").count();
check("map produces dimension blocks", dims > 0, `${dims} blocks`);

const restate = await p.textContent(".restate-text");
check("restatement names the detected features", /Features detected|识别到的业务特征/.test(restate), restate.slice(0, 70) + "…");

const qs = await p.locator(".qlist li").count();
check("questions generated for every record", qs > 0, `${qs} questions`);
check("no question left in a pending state", (await p.locator(".q-pending").count()) === 0);
check("no framing failure panel", (await p.locator(".framefail").count()) === 0);
check("no error box", (await p.locator(".err").count()) === 0);

const citable = await p.locator(".citable-badge").count();
check("citable records are badged", citable > 0, `${citable} badged`);

// ── manual override still available and working ─────────────────────────────
await p.click(".refine-toggle");
check("manual feature override opens", (await p.locator(".manual").count()) === 1);
await p.click(".manual-opt input >> nth=0");
await p.click(".manual-btn");
await p.waitForSelector(".dim-block", { timeout: 8000 });
check("manual path also produces a map", (await p.locator(".dim-block").count()) > 0);

// ── every view renders ──────────────────────────────────────────────────────
const navBtns = await p.locator(".nav-btn, nav button").count();
for (let i = 0; i < navBtns; i++) {
  await p.locator(".nav-btn, nav button").nth(i).click();
  await p.waitForTimeout(180);
  const empty = await p.evaluate(() => document.querySelector("#root").innerText.trim().length);
  if (empty < 200) { check(`view ${i} renders`, false, "view came up empty"); break; }
}
check("all views render", navBtns > 0, `${navBtns} views`);

// ── language toggle ─────────────────────────────────────────────────────────
await p.click(".ui-lang-btn >> nth=0");   // 中文
await p.waitForTimeout(250);
const zh = await p.textContent("#root");
check("Chinese UI switches", /[\u4e00-\u9fff]/.test(zh));
await p.click(".ui-lang-btn >> nth=1");   // EN

check("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));

await b.close();

let bad = 0;
console.log("\nOFFLINE MAPPER\n");
for (const r of out) {
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.n}${r.d && !r.ok ? "\n      " + r.d : (r.d ? `  (${r.d})` : "")}`);
  if (!r.ok) bad++;
}
console.log(bad ? `\n${bad} failing\n` : `\nall ${out.length} checks pass\n`);
process.exit(bad ? 1 : 0);
