import { chromium } from "playwright";   // npx playwright install chromium
import path from "node:path";

const FILE = "file://" + path.resolve(process.argv[2] || "demo/cbsr-demo.html");

const b = await chromium.launch();
const ctx = await b.newContext();
const escaped = [];
await ctx.route("**", (route) => {
  const u = route.request().url();
  if (!/^(file|data|blob):/.test(u)) { escaped.push(u); return route.abort(); }
  return route.continue();
});
const p = await ctx.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));

await p.goto(FILE);

const out = [];
const check = (n, ok, d) => out.push({ n, ok, d: d || "" });

// ── the embed must actually take over from the preview ──────────────────────
let revealed = false;
try {
  await p.waitForFunction(() => !document.getElementById("embed").hidden, { timeout: 12000 });
  revealed = true;
} catch (e) { /* falls through to a failed check */ }
check("embedded mapper reveals itself (cbsr-ready received)", revealed);
check("preview stepped aside", await p.evaluate(() => document.getElementById("preview").hidden));

// ── the mapper inside the iframe really rendered ────────────────────────────
const frame = p.frameLocator("#mapframe");
await frame.locator(".wrap").waitFor({ timeout: 10000 });
const dims = await frame.locator(".jur").count();
check("mapper rendered inside the iframe", dims === 12, `${dims} jurisdictions`);

// ── run the whole flow from inside the embed ────────────────────────────────
await frame.locator(".ex-chip").nth(0).click();
await frame.locator(".run").click();
await frame.locator(".dim-block").first().waitFor({ timeout: 10000 });
check("map flow runs inside the embed", (await frame.locator(".dim-block").count()) > 0,
  `${await frame.locator(".dim-block").count()} dimension blocks`);
check("questions present", (await frame.locator(".qlist li").count()) > 0,
  `${await frame.locator(".qlist li").count()} questions`);
check("no error surfaced in the embed", (await frame.locator(".err, .aioff, .framefail").count()) === 0);

// ── language propagates from the landing page into the iframe ───────────────
await p.click('#langtog button[data-lang="zh"]');
await p.waitForTimeout(700);
const frameZh = await frame.locator(".head-title").innerText();
check("language syncs page → iframe", /[\u4e00-\u9fff]/.test(frameZh), frameZh.slice(0, 30));

// ── and back the other way ──────────────────────────────────────────────────
await frame.locator(".ui-lang-btn").nth(1).click();  // EN inside the frame
await p.waitForTimeout(700);
const pageEn = await p.textContent("#status .kick");
check("language syncs iframe → page", /status/i.test(pageEn), pageEn);

// ── hygiene ─────────────────────────────────────────────────────────────────
check("zero network requests", escaped.length === 0, escaped.join(", "));
check("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));

await b.close();

let bad = 0;
console.log("\nMERGED SINGLE FILE (landing + inlined mapper, offline)\n");
for (const r of out) {
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.n}${r.d && !r.ok ? "\n      " + r.d : (r.d ? `  (${r.d})` : "")}`);
  if (!r.ok) bad++;
}
console.log(bad ? `\n${bad} failing\n` : `\nall ${out.length} checks pass\n`);
process.exit(bad ? 1 : 0);
