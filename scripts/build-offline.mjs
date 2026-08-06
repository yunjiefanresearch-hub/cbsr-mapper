#!/usr/bin/env node
/**
 * Offline demo builder for the CBSR mapper.
 *
 * Vite cannot run here (no registry access), and a demo laptop should not depend on one
 * either. This does the same two jobs Vite does, with what is already on disk:
 *
 *   1. transpile the JSX to plain JS with the TypeScript compiler;
 *   2. bundle React, ReactDOM and the scheduler from node_modules into one classic
 *      <script> — no ES modules, no import maps, no CDN.
 *
 * The output is a SINGLE .html file with every byte inlined, so it runs from file://
 * by double-clicking, with the network cable pulled out. That last part matters: an
 * ES-module build cannot be opened from file:// at all (module scripts are blocked by
 * CORS on that scheme), which is why this emits a classic script instead.
 *
 * This is a presentation artifact. `npm run build` remains the real build.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const SRC = process.argv[2] || ".";
const OUT = process.argv[3] || path.join(SRC, "dist-offline", "mapper.html");

// Resolve every dependency the way Node does, starting from the project being built.
// Nothing is hard-coded to a machine: run `npm install` in the project (or have react,
// react-dom and typescript available anywhere up the tree) and this finds them.
const req = createRequire(path.resolve(SRC, "package.json"));
function resolve(spec, what) {
  try { return req.resolve(spec); }
  catch (e) {
    console.error(`\n  cannot resolve ${spec}\n  ${what}\n  Run \`npm install\` in ${path.resolve(SRC)} first.\n`);
    process.exit(1);
  }
}
const ts = req(resolve("typescript", "needed to transpile the JSX"));

// ── 1. React runtime, assembled from the CJS builds ──────────────────────────
// Four modules, and the dependency graph between them is: react and scheduler are
// leaves; react-dom needs react; react-dom/client needs all three. A ten-line module
// registry is enough — this does not need to be a general-purpose bundler.
// The production CJS builds. Each package's public entry is a NODE_ENV switch that this
// bundle cannot evaluate (there is no process), so the production file is required
// directly. React 18 and 19 both lay these out the same way. "scheduler" is resolved
// from react-dom's position in the tree, because npm may or may not have hoisted it.
const reactDomEntry = resolve("react-dom", "peer of react");
const RUNTIME = {
  react: pkgFile("react", "cjs/react.production"),
  scheduler: pkgFile("scheduler", "cjs/scheduler.production", reactDomEntry),
  "react-dom": pkgFile("react-dom", "cjs/react-dom.production"),
  "react-dom/client": pkgFile("react-dom", "cjs/react-dom-client.production"),
  // The automatic JSX runtime. main.jsx writes <App /> without importing React, which
  // only works under the automatic runtime — so that is the transform used below, and
  // this is the module it emits calls into.
  "react/jsx-runtime": pkgFile("react", "cjs/react-jsx-runtime.production"),
};

// React 19 ships "<name>.production.js"; React 18 ships "<name>.production.min.js".
// Try both rather than pinning a major version.
function pkgFile(pkg, rel, from) {
  const r = from ? createRequire(from) : req;
  let root;
  try { root = path.dirname(r.resolve(pkg + "/package.json")); }
  catch (e) { root = path.dirname(r.resolve(pkg)); }
  for (const ext of [".js", ".min.js"]) {
    const p = path.join(root, rel + ext);
    if (fs.existsSync(p)) return p;
  }
  console.error(`\n  cannot find ${rel} in ${root}\n  Unsupported ${pkg} layout.\n`);
  process.exit(1);
}

function moduleWrapper(name, code) {
  return `__reg(${JSON.stringify(name)}, function(module, exports, require){\n${code}\n});\n`;
}

let bundle = `(function(){
"use strict";
// process.env.NODE_ENV is read by the React builds at module scope.
var process = { env: { NODE_ENV: "production" } };
var __defs = {}, __cache = {};
function __reg(name, fn){ __defs[name] = fn; }
function require(name){
  if (name === "react-dom/client") name = "react-dom/client";
  if (__cache[name]) return __cache[name].exports;
  var def = __defs[name];
  if (!def) throw new Error("module not bundled: " + name);
  var m = { exports: {} };
  __cache[name] = m;
  def(m, m.exports, require);
  return m.exports;
}
`;

for (const [name, file] of Object.entries(RUNTIME)) {
  bundle += moduleWrapper(name, fs.readFileSync(file, "utf8"));
}

// ── 2. The app's own modules, transpiled from JSX ────────────────────────────
const TSOPTS = {
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2019,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
  allowJs: true,
};

const appFiles = [
  ["./App.jsx", path.join(SRC, "src", "App.jsx")],
  ["./main.jsx", path.join(SRC, "src", "main.jsx")],
];

for (const [name, file] of appFiles) {
  const raw = fs.readFileSync(file, "utf8");
  const res = ts.transpileModule(raw, { compilerOptions: TSOPTS, fileName: file, reportDiagnostics: true });
  const errs = (res.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errs.length) {
    for (const d of errs) console.error("  transpile error:", ts.flattenDiagnosticMessageText(d.messageText, " "));
    process.exit(1);
  }
  // `import.meta.env.DEV` is Vite's dev flag, used by the source's placeholder assertion.
  // It is legitimate under Vite and a hard parse error in a classic script — the whole
  // script fails to parse, not just that line — so the bundler substitutes the value Vite
  // would have inlined for a production build. The source is left as it is.
  let code = res.outputText.replace(/\bimport\.meta\b/g, "__viteMeta");
  // The stylesheet opens with an @import for Google Fonts. Offline that request hangs,
  // fails, and leaves a red line in the console during the demo — for a webfont the CSS
  // already has a full fallback stack for. Strip it; nothing else references it.
  code = code.replace(/@import url\(['"]https:\/\/fonts\.googleapis[^)]*\);?/g, "");
  bundle += moduleWrapper(name, `var __viteMeta = { env: { DEV: false, PROD: true, MODE: "production" } };\n${code}`);
}

bundle += `require("./main.jsx");\n})();\n`;

// ── 3. The page shell ────────────────────────────────────────────────────────
// The upstream index.html links Google Fonts, which is a network request. Offline that
// request hangs and then falls back, so the type visibly reflows mid-demo. The stack
// below is what the CSS already falls back to, declared up front, so nothing reflows
// and nothing is requested.
const srcIndex = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const title = (srcIndex.match(/<title>([^<]*)<\/title>/) || [, "CBSR mapper"])[1];
const favicon = (srcIndex.match(/<link rel="icon"[^>]*>/) || [""])[0];

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="robots" content="noindex" />
    ${favicon}
    <style>
      html,body{margin:0;padding:0;background:#EDEFEB;}
      body{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,
           "Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Arial,sans-serif;}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
${bundle}
    </script>
  </body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`  built ${path.relative(process.cwd(), OUT)}  (${kb} KB, self-contained)`);
