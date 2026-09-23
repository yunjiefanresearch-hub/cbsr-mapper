/* ═══════════════════════════════════════════════════════════════════════════
   本轮修改说明 — v0.11.2（白屏修复）

   症状：部署页 index.html 正常返回，但 #root 始终为空，整页白屏。
   原因：两处「数据形状与渲染代码脱节」的运行时 TypeError。React 在渲染阶段抛错
        会卸载整棵树，因此表现为白屏而非局部报错。

   1) Nav 缺 evaluate 标签（首屏必崩，白屏的直接原因）
      VIEWS = ["evaluate", "map", ...] 共 7 项，Nav 内 labels 表只覆盖 6 项，
      labels["evaluate"] 为 undefined，labels[v][0] 抛 TypeError。
      Nav 在任何视图下都渲染，所以进站即白屏。
      改动：TX.zh / TX.en 增补 navEval / navEvalSub；Nav 的 labels 增补 evaluate 键。

   2) 走廊视图读的是已不存在的字段（切到 corridors 必崩）
      DATA.corridors 现含两种 schema：一条手写 corridor/v2-rich，其余为
      corridor/v3-directed-edge 计算骨架。快照按 corridor_id 排序后，
      DATA.corridors[0] 已不再是 rich 记录。且 v2-rich 记录本身没有 corr.sources，
      监管关口挂在 leg.sub_gates[] 而非 leg.gate。
      改动：新增 WORKED_CORRIDOR 按 schema 判别取 rich 记录；
            CorridorPanel 改读 leg.sub_gates[] 与 leg.sources[]；
            legPending / corridorPending 同步改判；补五条子关口 / 段级出处排版 CSS。

   上述为历史修复记录；当前 DATA / COMPUTE / MCP 均由同一 Register 版本自动生成。
   ═══════════════════════════════════════════════════════════════════════════ */
import React, { useState, useRef, useEffect } from "react";
import { DATA } from "./data.snapshot.js";
import { COMPUTE } from "./compute.snapshot.js";
import { MCP } from "./mcp.snapshot.js";
import { configuredRegisterApi, prepareRegisterSync } from "./registerSync.js";
import EvaluateView, { EVALUATE_VIEW_CSS } from "./EvaluateView.jsx";
import { EvidenceLedger, RecordAxes, EVIDENCE_AXES_CSS } from "./EvidenceAxes.jsx";

// The public Register API verifies the bundled snapshot by default. An explicit
// `window.__CBSR_REGISTER_API__ = ""` opts out; another URL selects a mirror.
// A response is applied only when its version/build identity also matches the
// bundled COMPUTE layer, so this can never create a mixed-version view.
const REGISTER_API = configuredRegisterApi(typeof window === "undefined" ? {} : window);
const CONTACT = "mailto:yunjiefan.research@gmail.com"; // enables the CTA seam at the end of the mapping flow
const LLM_PROXY = "";    // self-host only: URL of YOUR authenticated proxy for /v1/messages.
                         // Leave "" in the Anthropic artifact sandbox (auth is injected there).
                         // See DEPLOYMENT.md for a ready-to-deploy Cloudflare Worker example.
// Model string for every AI-backed call. It was previously buried inside callClaude, which made a
// "model not found" failure look like a mapping bug. Hoisted here so it is checked and changed in
// one place: verify the string your Anthropic account actually serves at docs.claude.com before
// going live — a wrong string returns HTTP 404, not a network error.
const AI_MODEL = "claude-sonnet-4-6";

// AI-backed features (document / URL import, the auto-map router, question generation) POST to
// an authenticated model endpoint. That auth is injected by the hosting environment (the Anthropic
// artifact sandbox); on a self-hosted deploy the call needs LLM_PROXY to point at your own
// authenticated proxy. We CANNOT positively detect the sandbox from inside it — an artifact often
// runs in a sandboxed iframe whose hostname is an opaque/isolated origin, not anthropic.com — so a
// hostname allow-list would wrongly disable AI in the very place it works. We therefore FAIL OPEN:
// assume the environment can serve the AI features, and let a real call failure (401/CORS/network)
// flip the app into the degraded, manual-only state at runtime (see aiRuntimeDown below). Set
// window.__CBSR_FORCE_AI__ = false to force the degraded state up front (useful when self-hosting
// without a proxy and you'd rather not surface the AI controls at all). The deterministic core
// (map, corridors, matrix, time-travel, exports) never touches this and is always available.
const AI_AVAILABLE = (() => {
  try {
    if (typeof window !== "undefined" && window.__CBSR_FORCE_AI__ === false) return false;
  } catch (e) { /* sandboxed access can throw; ignore and assume available */ }
  return true; // fail open: a real failure degrades gracefully at runtime
})();

// Active AI proxy endpoint. Resolution order: the LLM_PROXY compile-time constant, else an injected
// window.__CBSR_LLM_PROXY__ (a durable way to configure a self-hosted deploy via a <script> tag),
// else "" which makes callClaude fall back to the bare endpoint (works only where auth is injected).
// The in-UI proxy field (shown in the degraded-mode banner) calls setAiProxy() to override this at
// runtime for the session — so a self-hoster can paste their proxy URL and restore AI without a
// redeploy. It's a module-level mutable read fresh on every callClaude, not React state.
// Resolution order, highest first: LLM_PROXY constant, window.__CBSR_LLM_PROXY__, a URL the user
// previously applied in the UI (persisted), else "".
const PROXY_STORE_KEY = "cbsr.llm_proxy";
// The Worker matches the secret path segment EXACTLY, so a trailing slash turns a working proxy
// into a 404. Normalise it here once rather than blaming the user's typing.
function normalizeProxyUrl(s) { return (s || "").trim().replace(/\/+$/, ""); }
let AI_PROXY = normalizeProxyUrl(LLM_PROXY);
try {
  if (typeof window !== "undefined" && typeof window.__CBSR_LLM_PROXY__ === "string" && window.__CBSR_LLM_PROXY__) {
    AI_PROXY = normalizeProxyUrl(window.__CBSR_LLM_PROXY__);
  }
} catch (e) { /* sandboxed access can throw; keep compile-time default */ }
// Persisted override: survives a reload so a self-hoster pastes the proxy once, not every session.
// Guarded because sandboxed iframes can block storage entirely — a throw here must not break boot.
try {
  if (!AI_PROXY && typeof window !== "undefined" && window.localStorage) {
    const saved = window.localStorage.getItem(PROXY_STORE_KEY);
    if (saved) AI_PROXY = normalizeProxyUrl(saved);
  }
} catch (e) { /* storage unavailable; session-only proxy still works */ }
function setAiProxy(url, persist) {
  AI_PROXY = normalizeProxyUrl(url);
  if (persist) {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        if (AI_PROXY) window.localStorage.setItem(PROXY_STORE_KEY, AI_PROXY);
        else window.localStorage.removeItem(PROXY_STORE_KEY);
      }
    } catch (e) { /* storage unavailable; the session value above still applies */ }
  }
}
function currentAiProxy() { return AI_PROXY; }
// A permissive sanity check for the config field: http(s) URL, nothing fancy.
function looksLikeProxyUrl(s) { return /^https?:\/\/[^\s]+$/i.test((s || "").trim()); }

// ── DEMO MODE ─────────────────────────────────────────────────────────────────
// Presentation build. With no authenticated model proxy in front of it, every AI-backed
// leg (document/URL import, the router, question generation) fails at the CORS preflight,
// and the app's honest response to that — a yellow "AI is off, paste your Worker URL"
// banner, a proxy input box, and a red CORS error under the run button — is exactly the
// wrong thing to have on screen while presenting.
//
// DEMO_MODE removes those surfaces by removing their CAUSE: it does not hide a broken
// call, it stops making the call. The router is replaced by a deterministic keyword
// extractor over the same six feature flags the manual checkboxes already set, and the
// questions are composed from the record's own fields (authority, pinpoint, source,
// tension, resolution channel, binding status). So the map flow runs end to end, offline,
// with nothing on screen that can fail — and nothing asserted that the register cannot
// back. Every other view (corridors, matrix, time-travel, substrate, agents, exports)
// was already deterministic and is untouched.
//
// Set window.__CBSR_DEMO__ = false (or flip this constant) to restore the AI paths once a
// proxy is deployed. Everything the AI legs used is still here, unmodified.
// NOTE: a public deployment should ship with DEMO_MODE off. A register that
// defaults to demo mode is telling the reader it is a demo. The deterministic
// evaluate view carries the front page without any model call, so the AI branch
// is no longer load-bearing — see DEPLOY.md.
const DEMO_MODE = (() => {
  try {
    if (typeof window !== "undefined" && window.__CBSR_DEMO__ === false) return false;
  } catch (e) { /* sandboxed access can throw; keep the safe default */ }
  return true;
})();

/* The bundled register snapshot used to live here as a hand-pasted object
   literal. It drifted: the mapper shipped register v0.10.1 and published
   `citable_count: 46` for weeks after the register had retracted that number
   (v0.11.0 reports 0 decision-ready records; 46 is only the count of STRUCTURAL
   CANDIDATES). The literal is now generated, and `npm run check` fails the build
   if the committed snapshot and the register disagree.

     python3 tools/build_mapper_snapshot.py \
       --register ../cross-border-stablecoin-register --out src/data.snapshot.js

   The generated module also keeps the legacy `citable` key, REDEFINED to the
   strict six-axis gate, so every one of the ~20 legacy call sites below reports
   the honest number without needing to be rewritten one at a time.

   COMPUTE and MCP now follow the same rule: tools/build_mapper_derived.py
   generates both modules and the build checks them byte-for-byte. */
function provLabel(tier, t) {
  return ({ resolution_text: t.pvText, mixed: t.pvMixed, firm_summary: t.pvFirm, unset: t.pvUnset })[tier] || tier || t.pvUnset;
}
function bindLabel(bs, t) {
  return ({ in_force_enacted: t.bnForce, made_not_commenced: t.bnMade, finalized_policy_pending: t.bnPolicy, pending_proposal: t.bnProp, prohibition: t.bnProhib, no_regime: t.bnNone })[bs] || bs || "—";
}

// ── Framer output code-gate (upgrades the citation firewall from prompt-only to enforced):
//    drop any generated question that (a) leaks internal provenance, (b) states a compliance
//    verdict, or (c) contains a currency/percent figure absent from the grounding record text.
const PROV_LEAK = /(compliance matrix|maintainer|transcrib|confidence level|firm[_ ]?summary|resolution[_ ]?text|evidence[_ ]?tier|version 0\.|v0\.\d)/i;
const VERDICT = /\b(?:is|are|be|being|will\s+be)\s+(?:compliant|non-?compliant)\b|\b(?:in\s+(?:violation|breach))\b|you\s+(?:comply|are\s+compliant|must\s+comply|do\s+comply)|\bdoes\s+comply\b/i;
// Normalized numeric comparison (not digit-substring): parse each figure to a number,
// expanding k/m/bn multipliers, so a fabricated "€200m" cannot slip through by matching
// the digits of an unrelated token (e.g. a year, or "277/2022").
const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(%|k|bn|m|billion|million|thousand)?/gi;
function extractNums(text) {
  const set = new Set();
  const str = String(text || "");
  let m; NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(str)) !== null) {
    const base = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(base)) continue;
    const u = (m[2] || "").toLowerCase();
    const mult = (u === "k" || u === "thousand") ? 1e3 : (u === "m" || u === "million") ? 1e6 : (u === "bn" || u === "billion") ? 1e9 : 1;
    set.add(Math.round(base * mult * 100) / 100);
    if (u === "%") set.add(base);
  }
  return set;
}
function questionOk(q, ground) {
  if (typeof q !== "string" || q.trim().length < 3) return false;
  if (PROV_LEAK.test(q) || VERDICT.test(q)) return false;
  const gnums = extractNums(ground);
  for (const n of extractNums(q)) {
    let hit = false;
    for (const g of gnums) { if (Math.abs(g - n) < 1e-6 || (n !== 0 && Math.abs(g - n) / Math.abs(n) < 1e-9)) { hit = true; break; } }
    if (!hit) return false;
  }
  return true;
}
function sanitizeFramed(valueObj, groundById) {
  const kept = {}; const dropped = {};
  for (const k of Object.keys(valueObj || {})) {
    const arr = Array.isArray(valueObj[k]) ? valueObj[k] : [];
    const ok = arr.filter((q) => questionOk(q, groundById[k] || ""));
    kept[k] = ok;
    const d = arr.length - ok.length;
    if (d > 0) dropped[k] = d;
  }
  return { kept, dropped };
}


const DIM_ORDER = [
  "regulatory_authority", "issuer_pathway", "reserve_backing", "capital_requirements",
  "permitted_activity_yield", "securities_classification", "bank_nonbank_routing",
  "redemption", "custody", "aml_kyc", "cross_border_data", "monetary_sovereignty",
  "disclosure_reporting", "distribution", "implementation_status",
];
const SPINES = new Set(["permitted_activity_yield", "securities_classification"]);
const CONSTRAINT = {
  issuer_pathway: "C1", reserve_backing: "C2", capital_requirements: "C2",
  permitted_activity_yield: "C3", securities_classification: "C4", bank_nonbank_routing: "C5",
  custody: "C2", cross_border_data: "C6", monetary_sovereignty: "C7", disclosure_reporting: "C8",
};

// ---- Deterministic dimension + tier derivation (replaces model-chosen tiering) ----
// PRESSURE = dimensions THIS business distinctively triggers, derived from feature flags.
// reserve_backing is always a pressure point for any fiat-referenced token.
const PRESSURE_RULE = [
  ["reserve_backing", () => true],
  ["permitted_activity_yield", (f) => !!f.yield],
  ["securities_classification", (f) => !!f.securities_wrapper || !!f.yield],
  ["bank_nonbank_routing", (f) => !!f.lending_or_routing],
  ["cross_border_data", (f) => !!f.cross_border_or_data],
  ["monetary_sovereignty", (f) => !!f.non_domestic_peg],
  ["custody", (f) => !!f.custody],
];
// BASELINE = table-stakes dimensions any stablecoin business carries; shown only where the
// register has a record for a selected jurisdiction (prunes empty all-gap rows).
const BASELINE_KEYS = [
  "regulatory_authority", "issuer_pathway", "capital_requirements", "redemption",
  "custody", "aml_kyc", "disclosure_reporting", "distribution", "implementation_status",
];

const REASONS = {
  zh: {
    reserve_backing: "锚定法币 → 储备的构成、质量与隔离直接进入审查范围",
    permitted_activity_yield: "存在向持有人提供收益/利息/回报的安排 → 触及稳定币收益边界,各法域处理不同",
    securities_classification: "含基金/证券/投资封装或生息特征 → 触及证券属性认定边界",
    bank_nonbank_routing: "涉及信贷/存款/或把余额路由进其他产品 → 触及银行与非银行性质及路由判断",
    cross_border_data: "跨境运营或数据跨境流转 → 触及数据主权与跨境传输要求",
    monetary_sovereignty: "锚定非本币并可跨境流通 → 对非锚定货币辖区涉及货币主权与外汇管理",
    regulatory_authority: "确认该法域对此类业务的主管监管机关",
    issuer_pathway: "发行主体需确认其许可/准入路径",
    capital_requirements: "发行人需满足最低资本与流动性要求",
    redemption: "持有人赎回机制为持续性监管要求",
    custody: "储备及客户资产的托管安排需符合规定",
    aml_kyc: "发行与转让环节需履行反洗钱与客户身份核验义务",
    disclosure_reporting: "需向监管方披露储备、运营与风险信息",
    distribution: "发行与销售渠道受分发及要约限制约束",
    implementation_status: "该法域监管规则的现行落地与生效状态",
  },
  en: {
    reserve_backing: "Pegs to fiat → reserve composition, quality and segregation come under review.",
    permitted_activity_yield: "Holders receive a yield / interest / return → engages the stablecoin yield boundary, handled differently per jurisdiction.",
    securities_classification: "Carries a fund / securities / investment wrapper or a yield feature → engages the securities-classification boundary.",
    bank_nonbank_routing: "Involves lending / deposits / or routing balances into other products → engages bank vs non-bank status and routing.",
    cross_border_data: "Operates across borders or moves user data across jurisdictions → engages data sovereignty and cross-border transfer.",
    monetary_sovereignty: "Pegs to a non-domestic currency and can circulate cross-border → engages monetary sovereignty in non-peg jurisdictions.",
    regulatory_authority: "Confirm which authority in this jurisdiction supervises this business.",
    issuer_pathway: "The issuer must confirm its licensing / authorisation pathway.",
    capital_requirements: "The issuer must meet minimum capital and liquidity requirements.",
    redemption: "Holder redemption is a continuing supervisory requirement.",
    custody: "Custody of reserves and client assets must meet the rules.",
    aml_kyc: "Issuance and transfer carry AML / KYC obligations.",
    disclosure_reporting: "Reserve, operational and risk information must be disclosed to the regulator.",
    distribution: "Distribution and offering channels are subject to restriction rules.",
    implementation_status: "The current commencement / in-force status of this jurisdiction's regime.",
  },
};

function deriveDims(features, jurs, recByJurDim, L) {
  const f = features || {};
  const hasRec = (k) => jurs.some((j) => (recByJurDim[j] || {})[k]);
  const out = [];
  for (const [k, on] of PRESSURE_RULE) if (on(f)) out.push({ key: k, tier: "pressure" });
  for (const k of BASELINE_KEYS) if (hasRec(k) && !out.some((o) => o.key === k)) out.push({ key: k, tier: "baseline" });
  out.sort((a, b) => DIM_ORDER.indexOf(a.key) - DIM_ORDER.indexOf(b.key));
  return out.map((d) => ({ key: d.key, tier: d.tier, reason: (REASONS[L] && REASONS[L][d.key]) || "" }));
}

// ── Deterministic router (DEMO_MODE) ─────────────────────────────────────────
// Sets the SAME six feature flags the manual checkboxes set, from surface terms in the
// description. It is a keyword extractor, not a reader: it is labelled as such in the
// restatement, and the manual checkboxes stay available to correct it. Everything
// downstream of the flags — dimension selection, tiering, record retrieval, the citable
// subset — is the unchanged deterministic core.
const FEATURE_TERMS = {
  yield: ["收益", "利息", "生息", "派息", "分红", "回报", "理财", "货币基金", "货币市场基金", "余额理财", "质押", "挖矿",
          "yield", "interest", "apy", "apr", "reward", "rebate", "return on", "money market", "mmf", "earn", "staking", "stake"],
  securities_wrapper: ["证券", "基金", "份额", "投资产品", "资管", "理财产品", "代币化基金", "资产支持", "证券化",
                       "securit", "fund share", "fund unit", " fund", "investment product", "tokenised fund", "tokenized fund",
                       "mmf", "wrapper", "abs", "rwa", "share class"],
  lending_or_routing: ["借贷", "放贷", "信贷", "存款", "吸储", "路由", "划转", "中转", "扫码归集", "归集", "钱包",
                       "lend", "loan", "credit", "deposit", "routing", "route", "sweep", "wallet", "intermediar",
                       "custodial wallet", "borrow", "on-lend"],
  non_domestic_peg: ["锚定美元", "美元", "外币", "非本币", "港元", "港币", "欧元", "离岸", "跨币种", "美金",
                     "usd", "dollar", "eur", "euro", "hkd", "foreign currency", "non-domestic", "offshore", "peg"],
  cross_border_or_data: ["跨境", "出境", "境外", "境内外", "跨国", "海外", "外国", "他国", "数据", "个人信息", "汇款", "结算", "通道",
                         "cross-border", "cross border", "overseas", "abroad", "offshore", "remittance", "corridor",
                         "settlement", "data", "personal information", "pipl", "gdpr", "internationa",
                         "non-us", "non-eu", "foreign user", "outside the"],
  custody: ["托管", "保管", "隔离", "客户资产", "冷钱包", "私钥", "多签", "信托",
            "custod", "safeguard", "segregat", "client asset", "cold storage", "private key", "trust account", "multi-sig"],
};
// If none of these appear, the description is not about a digital token / payment business
// at all, and the tool says so instead of mapping it anyway.
const IN_SCOPE_TERMS = [
  "稳定币", "代币", "加密", "数字资产", "虚拟资产", "区块链", "链上", "钱包", "支付", "发行", "结算", "汇款", "牌照", "合规",
  "stablecoin", "stable coin", "token", "crypto", "digital asset", "virtual asset", "blockchain", "on-chain", "onchain",
  "wallet", "payment", "issuer", "issuance", "settlement", "remittance", "usdc", "usdt", "licen", "compliance",
];
const hasAny = (hay, terms) => terms.some((w) => hay.indexOf(w) > -1);

const FEATURE_LABELS = {
  zh: {
    yield: "向持有人提供收益 / 利息 / 回报",
    securities_wrapper: "带基金 / 证券 / 投资封装",
    lending_or_routing: "涉及借贷、存款或余额路由",
    non_domestic_peg: "锚定非本币（如美元）",
    cross_border_or_data: "跨境运营或数据跨境",
    custody: "涉及资产托管 / 隔离安排",
  },
  en: {
    yield: "pays a yield / interest / return to holders",
    securities_wrapper: "carries a fund / securities / investment wrapper",
    lending_or_routing: "involves lending, deposits or balance routing",
    non_domestic_peg: "pegs to a non-domestic currency",
    cross_border_or_data: "operates across borders or moves data across borders",
    custody: "involves custody / segregation of assets",
  },
};

function localRoute(description, L) {
  const hay = String(description || "").toLowerCase();
  if (!hasAny(hay, IN_SCOPE_TERMS)) return { scope: "out", features: {}, business_restatement: "" };
  const features = {};
  for (const k of Object.keys(FEATURE_TERMS)) features[k] = hasAny(hay, FEATURE_TERMS[k]);
  const on = Object.keys(features).filter((k) => features[k]);
  const lab = FEATURE_LABELS[L] || FEATURE_LABELS.en;
  const list = on.map((k) => lab[k]);
  const restatement = L === "zh"
    ? (list.length
        ? "识别到的业务特征：" + list.join("；") + "。（由关键词规则确定性提取，不是模型推断。不准确请用下方「手动勾选业务特征」修正后重新映射。）"
        : "未识别到额外的业务特征，按储备锚定类业务的基线维度映射。（由关键词规则确定性提取。可用下方「手动勾选业务特征」补充。）")
    : (list.length
        ? "Features detected: this business " + list.join("; ") + ". (Extracted deterministically from surface terms, not inferred by a model. If it is wrong, correct it with the manual feature checkboxes below and map again.)"
        : "No additional features detected; mapped on the baseline dimensions for a reserve-backed token. (Extracted deterministically from surface terms. Add any missing feature with the manual checkboxes below.)");
  return { scope: "in", features, business_restatement: restatement };
}

// ── Deterministic questions (DEMO_MODE) ──────────────────────────────────────
// Composed from the record's own fields, so every question points at something the
// register actually holds. Same contract as the model-generated set: questions to ask,
// never conclusions.
function localQuestions(entry, rec, aud, L, t) {
  const dim = (DATA.dimensions && DATA.dimensions[rec.dimension]) || rec.dimension;
  const src = rec.source_primary || rec.authority || "";
  const pin = rec.pinpoint || "";
  const auth = rec.authority || "";
  const qs = [];
  if (L === "zh") {
    if (aud === "regulator") {
      qs.push(`请就「${dim}」出示与 ${src} 相符的具体安排${pin ? `，并指明它对应 ${pin} 的哪一处` : ""}。`);
      if (rec.tension) qs.push(`未决点：${rec.tension} 本项目在架构上如何处理这一点？`);
      if (rec.binding_status !== "in_force_enacted") qs.push(`该依据目前为「${bindLabel(rec.binding_status, t)}」。在其生效之前与之后，本项目在该维度上的安排分别是什么？`);
      else if (!rec.citable) qs.push(`本条出处强度为「${provLabel(rec.evidence_tier, t)}」，尚未逐条核对官方原文。请提供你方据以合规的一手条文出处。`);
      if (auth) qs.push(`${auth} 对本项目在该维度上的管辖是否成立？若涉多个监管口径，以哪一个为准？`);
    } else {
      qs.push(`按 ${src}${pin ? `（${pin}）` : ""}，我们在「${dim}」上的现行安排是否满足要求？最可能不满足的是哪一步？`);
      if (rec.tension) qs.push(`这一点目前没有定论：${rec.tension} 我们应按哪种解释来设计架构？${rec.resolution_channel ? `走「${rec.resolution_channel}」能否取得确定性？` : ""}`);
      if (rec.binding_status !== "in_force_enacted") qs.push(`该依据为「${bindLabel(rec.binding_status, t)}」。在它生效之前我们可以做什么、不能做什么？生效当天需要改动哪些环节？`);
      if (auth) qs.push(`如果改变「${dim}」上的安排，是否会触发 ${auth} 的额外审批或牌照要求？`);
    }
  } else {
    if (aud === "regulator") {
      qs.push(`Show the arrangement on "${dim}" that meets ${src}${pin ? `, and identify where it maps onto ${pin}` : ""}.`);
      if (rec.tension) qs.push(`Unsettled point: ${rec.tension} How does this structure handle it?`);
      if (rec.binding_status !== "in_force_enacted") qs.push(`This rests on an instrument that is "${bindLabel(rec.binding_status, t)}". What is the arrangement before commencement, and what changes on the day it commences?`);
      else if (!rec.citable) qs.push(`The provenance of this record is "${provLabel(rec.evidence_tier, t)}" — not line-checked against the official text. Cite the primary provision you are relying on.`);
      if (auth) qs.push(`Does ${auth} have jurisdiction over this business on this dimension, and if more than one authority does, which one binds?`);
    } else {
      qs.push(`Under ${src}${pin ? ` (${pin})` : ""}, does our current arrangement on "${dim}" meet the requirement, and which step is most likely to fail it?`);
      if (rec.tension) qs.push(`This is unsettled: ${rec.tension} Which reading should we build to?${rec.resolution_channel ? ` Would ${rec.resolution_channel} give us certainty?` : ""}`);
      if (rec.binding_status !== "in_force_enacted") qs.push(`This instrument is "${bindLabel(rec.binding_status, t)}". What may we do before it commences, and what has to change on commencement day?`);
      if (auth) qs.push(`If we change the arrangement on "${dim}", does that trigger further approval or a licence from ${auth}?`);
    }
  }
  return qs.slice(0, 3);
}

const T = {
  zh: {
    title: "监管维度映射器",
    subA: "把项目自述的业务形态,映射到相关监管维度、对应条款(带出处)、以及该问的问题。",
    notVerdict: " 这是一张地图,不是判决",
    subB: "：不判定你是否违规,只告诉你该看哪几条、该问哪几个问题。多选法域时按维度并排看跨法域差异。",
    f1: "1 · 项目自述(手打,或从白皮书 / 官网导入)",
    f1Demo: "1 · 项目自述",
    emptyDemo: "在描述框写一段业务自述(或点上面的示例),选一个或多个法域、选受众,点「映射」。工具会先复述它识别到的业务特征、标出监管压力点,再按维度并排列出每个法域的现行要求与该问的问题。",
     taPh: "例:我们发一个锚定美元的支付稳定币,不付息;用户余额会被路由进一个货币基金赚收益;也面向境外用户。",
    tryL: "试试:",
    impA: "或从来源导入：导入只填入上方描述框,", impBold: "映射前请在框里核对/修改", impC: "(描述框就是确认环节):",
    fileBtn: "上传白皮书 (PDF / txt)",
    urlPh: "官网 URL 或项目名,例 https://example.com",
    read: "读取",
    dExtracting: "正在从文件提取业务形态…",
    dExtracted: "已提取并填入下方描述框,请核对/修改后再点映射。",
    dExtractFail: (e) => `文件提取失败(${e})。文件可能过大,可改为粘贴关键段落。`,
    dReadFail: "文件读取失败。",
    dUrlReading: "正在联网读取并理解该网址…",
    dUrlDone: "这是工具对该网址的理解,已填入描述框。映射前请务必核对/修改。",
    dUrlFail: (e) => `读取失败(${e})。可改为手动描述。`,
    needUrl: "先填一个官网 URL 或项目名。",
    f2: "2 · 意向法域(可多选)", noCov: "覆盖空白", dimsU: "dims",
    f3: "3 · 受众",
    audRT: "监管方", audRS: "审查点 + 审查者会问的问题",
    audPT: "项目方", audPS: "现行要求 + 带去问律师的清单",
    qLangL: "问题语言", qAuto: "跟随输入", qZh: "中文", qEn: "EN",
    run: "映射 →", running: "处理中…",
    needDesc: "请先在描述框写/导入业务形态(至少十几个字)再映射。",
    needJur: "至少选一个意向法域。",
    s1: "第 1 步:理解业务 + 路由维度…", s2: "第 2 步:检索已核验记录…",
    procRoute: "理解业务形态 + 提取业务特征", procRetrieve: (n) => `检索 ${n} 条已核验记录`, procRetrieveStep: "按规则推导维度 + 检索记录", procFrame: "生成该问的问题",
    framingProg: (d, tot) => `正在生成问题… ${d} / ${tot} 组完成(条款与出处已就绪,可先看)`,
    errLimit: "AI 调用被限流(429):这轮跑得太频繁了。等一两分钟再点「映射」。这是 Claude 网页内 AI 调用的额度限制,我无法解除,只能减少调用、加退避。",
    errOverload: "AI 服务暂时过载(529)。稍等片刻再点「映射」。",
    errNoProxy: "未配置模型代理，AI 功能无法调用。这不是你的网络问题：本页在浏览器里直接向 api.anthropic.com 发请求，会在 CORS 预检阶段就被拒绝，且请求不带任何密钥。修法：按 README「Tier 2」部署一个带密钥的代理，然后在下方输入框粘贴代理地址（含 secret 路径段），或写入 index.html 的 window.__CBSR_LLM_PROXY__ 后重新构建。确定性核心（维度地图 / 走廊 / 12×12 矩阵 / 时间轴 / 导出）不受影响。",
    errProxyDown: "已配置代理，但请求发不出去。常见三种原因：① 代理地址写错或 Worker 未部署；② Worker 的 ALLOW_ORIGIN 没放行本站域名（浏览器会在 CORS 预检就拦下）；③ 代理域名解析或网络本身不通。可先在浏览器直接打开代理地址做健康检查。",
    errAuth: "代理拒绝了请求（401 / 403）：说明请求到达了代理，但密钥缺失或无效。检查 Worker 是否已执行 wrangler secret put ANTHROPIC_API_KEY，以及该密钥在你的 Anthropic 账号下是否仍然有效。",
    errNotFound: "代理返回 404：请求到了服务器但没命中路由。最常见的是代理地址末尾多了一个斜杠（Worker 对 secret 路径段是精确匹配），其次是模型串不被账号支持（见 App.jsx 顶部 AI_MODEL）。本版已自动去除末尾斜杠，若仍报 404，请核对 secret 路径段与模型串。",
    errNetwork: "网络错误,检查连接后重试。",
    errEmpty: "AI 返回了空回复,请再点一次「映射」。",
    errParse: "拿到了回复但解析失败(本版已加引号修复 + 截断修复)。若仍失败,把下面这段贴给我:",
    errOther: (e) => `映射调用失败:${e}。请再点一次「映射」。`,
    rawLabel: "模型实际返回(前 200 字):",
    scopeOut: "这段描述看起来与数字代币 / 加密 / 支付都没有关系,落在 register 范围之外。换一个贴近稳定币 / 数字资产业务的描述再试。",
    scopeVague: "描述还太笼统,没法稳妥映射到具体维度。多写一点:谁发行、锚定什么、有没有收益/回报安排、是否跨境、数据放哪。",
    partA: "这项业务比稳定币更宽(像是一套加密/数字资本论述),只有", partBold: "部分", partC: "落在 register 范围内。下面映射的是其中与 register 维度相关的部分;其余不在本工具覆盖之列。",
    restateL: "理解的业务形态", restateHint: "不准确?在上方描述框改完重新映射。",
    ppL: "监管压力点", ppHint: "(点击跳到对应内容)",
    resMeta: (c, g, d, aud) => `${c} 条已核验记录${g > 0 ? " · " + g + " 个覆盖空白" : ""} · ${d} 个维度 · 视角:${aud === "regulator" ? "监管方" : "项目方"}`,
    tierP: "核心压力点：这套业务最突出触发的维度", tierB: "基线维度：任何此类业务都会例行触发",
    baselineCount: (n, busy) => `${n} 个${busy ? " · 问题生成中" : ""} · 点击展开`, collapseHint: "点击收起",
    pTag: "压力点", back: "↑ 返回压力点目录", why: "为何相关",
    qReg: "审查者会问 / 该核查的点", qProj: "带去问持牌律师的问题",
    qGen: "模型基于本条目生成 · 非结论", qGap: "无核验记录 · 仅指向该维度",
    qGenerating: "生成中…", qPendGen: "问题未能生成,可重试。上方条目与出处仍有效。",
    frameFailH: (n) => `问题生成失败：${n} 个条目还没有问题`,
    frameFailKeep: "已核验记录、条款出处、可引用标记与全部导出都不依赖模型，上方内容依然有效、可直接使用。",
    frameFailRetry: "只重试缺失的问题",
    noRec: "覆盖空白 / no verified record",
    gapBody: (j) => `register 暂无 ${j} 此维度的已核验记录。该维度与你的业务相关,你仍需自行查证;工具不会凭空补一条规则。`,
    gapQ: (j, dim) => [`${j} 在「${dim}」上有哪些现行监管要求?`, `${j} 哪个机关对此有管辖权,适用哪部法规?`, `这个维度是否有适用于本业务的特定规则或豁免?`],
    tension: "未决张力", channel: "解决渠道:",
    axClaim: "命题", axLegal: "法律命题", axOp: "市场/运营事实",
    axProv: "出处", pvText: "官方文本已核", pvMixed: "部分核验", pvFirm: "实务摘要", pvUnset: "未定级",
    axBind: "生效", bnForce: "已生效", bnMade: "已通过·未生效", bnPolicy: "政策已定·待立法", bnProp: "提案·待决", bnProhib: "禁止", bnNone: "无制度",
    citable: "✓ 可作现行法引用", citableWord: "可引用", officialSrc: "官方出处",
    axesLegend: "每条记录显示六轴：命题、生效、出处、官方来源、时效与独立复核；六轴全部通过才可作决策依据。",
    seamH: "地图到此为止。", seamB: "需要针对你具体架构、某几个法域 / 通道的已核验通道分析（可引用记录 + corridor 可行性 + 待核查清单）？", seamBtn: "获取针对性的已核验分析 →",
    syncOk: "已同步 live 注册表", syncSnap: "内置快照", syncWait: "同步中…", refreshed: "条已刷新",
    asOf: "快照截至", scopeNote: "覆盖范围：本工具映射的是节点层（法域 × 维度）：业务形态→相关维度、对应条款与该问的问题。走廊可行性、时间维（生效前后）与跨法域分析在完整 register 中，不在此处。",
    discAsOf: "本快照为冻结版本，核验截至日见页首；监管随时变动（同一日内即可翻转），引用前请对照一手来源核实时效。",
    scopeNoCov: "所选法域在推导出的维度上暂无已核验记录：这是 register 的覆盖空白，不是描述太模糊。可换用其他法域，或到完整 register 查询。",
    manualH: "离线 / 无 AI 兜底：手动勾选业务特征",
    manualB: "路由步骤需要模型；若不可用，可自行勾选下列业务特征，工具仍会用确定性规则给出维度地图、对应记录与可引用子集（此路径不调用模型）。问题生成仍需模型。",
    manualBtn: "用这些特征生成地图",
    manualHDemo: "手动勾选业务特征（覆盖自动识别）",
    manualBDemo: "上方描述框走的是确定性关键词规则。若它漏掉或误判了某项特征，在这里直接勾选，然后用这些特征重新生成地图——结果同样来自已核验记录。",
    refineOpen: "自动识别不准？手动勾选业务特征 ↓",
    refineClose: "收起手动特征 ↑",
    qGenDet: "由本条目的条款 / 张力字段确定性生成 · 非结论",
    aiOffH: "AI 辅助功能未启用",
    aiOffB: "文档 / 网址导入、「自动映射」和问题生成需要一个已认证的模型代理。在 Anthropic 沙盒里代理是自动注入的；自托管时请按 README「Tier 2」部署 worker/ 里的 Cloudflare Worker，拿到形如 https://你的worker.workers.dev/你的PROXY_SECRET 的地址填到下面。在此期间，下方的手动特征兜底可用，其余全部功能：维度地图、走廊、12×12 矩阵、时间轴、导出：均为确定性，无需模型即可正常使用。",
    aiOffManual: "跳到手动映射",
    aiOffTag: "确定性核心不受影响",
    proxyLabel: "或者：填入你的模型代理地址以恢复 AI 功能",
    proxyPh: "https://你的worker.workers.dev/你的PROXY_SECRET",
    proxyApply: "应用",
    proxyHint: "填入后立即生效，并保存在本浏览器中，刷新后无需重填（清空输入框再点「应用」即可清除）。末尾的斜杠会被自动去掉——Worker 对 secret 路径段是精确匹配，多一个斜杠会返回 404。要对所有访问者生效，请改 index.html 里的 window.__CBSR_LLM_PROXY__ 后重新构建。",
    proxyOn: "代理已设为",
    proxyRetry: "现在可重试上方的 AI 功能。",
    proxyBad: "请填入以 http:// 或 https:// 开头的有效地址。",
    mfYield: "向持有人提供收益 / 利息 / 回报（含余额路由进生息产品）",
    mfSec: "工具可被包装为基金份额 / 证券 / 投资产品，或带投资属性",
    mfLend: "从事借贷 / 信贷 / 存款，或将用户余额路由进其他产品 / 层",
    mfPeg: "锚定对至少一个所服务市场为外币的货币（如境外使用的美元锚定）",
    mfXb: "跨境服务用户，或跨法域存储 / 传输用户数据",
    mfCust: "持有客户资产 / 储备（自托管或经第三方托管）",
    qHidden: (n) => `${n} 条问题因出处校验被隐藏`,
    qAllHidden: (n) => `该记录的 ${n} 条生成问题均未通过出处校验，已全部隐藏（出处文本中无对应数字/表述依据）。`,
    corrDemo: "示例 DEMO",
    corrDemoNote: "本走廊含未核验段（HK 段整段待核），按示例展示：非交付级结论，请勿据此引用。",
    corrTitle: "跨境通道分析", corrHint: "这是 register 区别于逐法域查表的核心层：沿一条跨境资金流,逐段标出什么能清算、什么会断。",
    corrFlow: "资金流", corrLeg: "法域段", corrGate: "监管关口", corrClears: "可清算路径", corrBreaks: "断点 / 受阻",
    corrKey: "核心约束", corrUsLink: "美国法理对应", corrSrc: "出处", corrPending: "待核验",
    corrPendingNote: "此段尚未完成一手核验。字段留空,而非填占位文字：工具不凭空补全。",
    corrNeeds: "补齐条件",
    corrConf: (c) => `通道 confidence:${c}`,
    empty: "在描述框写一段业务自述(或上传白皮书 / 填官网 URL 导入),选一个或多个法域、选受众,点「映射」。工具会先复述它理解的业务形态、标出监管压力点,再按维度并排列出每个法域的现行要求与该问的问题。",
    disc: '本工具输出的是研究 / 审查的起点:相关维度、现行条款(直接取自已核验的 register 记录,含出处)、以及该问的问题。它不是法律意见,不判定合规与否,也不替代持牌律师或监管者的判断。维度与分层由代码按固定规则从业务特征推导(同一输入可复现);"理解的业务形态"是工具对你输入的复述,从来源导入时请在描述框核对后再映射。问题部分由模型基于条款与未决张力生成;条款、出处、confidence 均直接来自 register,未经模型改写。覆盖空白处的问题为模板生成,仅指向该维度,不预设任何具体规则。某些记录系自维护者的 Compliance Matrix 转录、尚待最终一手核验。',
    examples: [
      { label: "支付稳定币 + 路由进货币基金", text: "我们发行一个 1:1 锚定美元的支付稳定币,不向持有人支付利息。用户钱包里的稳定币余额可以被路由进一个已注册的代币化货币市场基金,从而为用户产生收益。我们也面向境外用户提供服务。" },
      { label: "港元锚定 + 跨境零售", text: "我们计划在香港发行一个锚定港元的法币稳定币,面向零售用户,并把用户的 KYC 数据托管在境外的云服务上。我们想做跨境支付结算。" },
      { label: "RWA 质押信贷(中文测试)", text: "数字货币,稳定价值、能生息的工具。它锚定美元,可以是代币、基金、优先证券、账户或别的封装形式,底层是数字信贷加法币现金等价物的组合。核心业务:将流动性小的 RWA 作为质押品进行信贷业务。" },
    ],
  },
  en: {
    title: "Regulatory Dimension Mapper",
    subA: "Maps a project's self-described business form to the relevant regulatory dimensions, the governing provisions (with sources), and the questions to ask.",
    notVerdict: " This is a map, not a verdict",
    subB: ": it does not decide whether you comply; it tells you which provisions to read and which questions to ask. Select several jurisdictions to see the cross-jurisdictional differential side by side.",
    f1: "1 · Business description (type it, or import from a whitepaper / website)",
    f1Demo: "1 · Business description",
    emptyDemo: "Write a business description (or click one of the examples above), pick one or more jurisdictions and an audience, then click Map. The tool first restates the features it detected and flags the pressure points, then lists each jurisdiction's current requirements and the questions to ask, dimension by dimension.",
     taPh: "e.g. We issue a USD-pegged payment stablecoin, no interest to holders; user balances can be routed into a money-market fund for yield; we also serve non-US users.",
    tryL: "Try:",
    impA: "Or import from a source: import only fills the box above; ", impBold: "review / edit it before mapping", impC: " (the box is the confirmation step):",
    fileBtn: "Upload whitepaper (PDF / txt)",
    urlPh: "Website URL or project name, e.g. https://example.com",
    read: "Fetch",
    dExtracting: "Extracting the business form from the file…",
    dExtracted: "Extracted and filled into the box below: review / edit before you map.",
    dExtractFail: (e) => `Extraction failed (${e}). The file may be too large; try pasting the key sections instead.`,
    dReadFail: "Could not read the file.",
    dUrlReading: "Searching the web and reading this site…",
    dUrlDone: "This is the tool's understanding of the site, filled into the box. Review / edit it before you map.",
    dUrlFail: (e) => `Fetch failed (${e}). Describe it manually instead.`,
    needUrl: "Enter a website URL or project name first.",
    f2: "2 · Target jurisdictions (multi-select)", noCov: "no coverage", dimsU: "dims",
    f3: "3 · Audience",
    audRT: "Regulator", audRS: "Review points + the questions a reviewer asks",
    audPT: "Project team", audPS: "Current requirements + a checklist for your lawyer",
    qLangL: "Answer language", qAuto: "Follow input", qZh: "中文", qEn: "EN",
    run: "Map →", running: "Working…",
    needDesc: "Write or import a business description (a dozen-plus characters) before mapping.",
    needJur: "Select at least one jurisdiction.",
    s1: "Step 1: understand the business + route dimensions…", s2: "Step 2: retrieve verified records…",
    procRoute: "Understand the business + extract features", procRetrieve: (n) => `Retrieve ${n} verified records`, procRetrieveStep: "Derive dimensions by rule + retrieve records", procFrame: "Generate the questions to ask",
    framingProg: (d, tot) => `Generating questions… ${d} / ${tot} batches done (provisions & sources are ready below)`,
    errLimit: "AI calls are rate-limited (429): too many runs this session. Wait a minute or two, then click Map again. This is a limit on in-page AI calls that I can't lift: I can only reduce calls and back off.",
    errOverload: "The AI service is temporarily overloaded (529). Wait a moment and click Map again.",
    errNoProxy: "No model proxy is configured, so the AI features cannot run. This is not your connection: the page is POSTing straight to api.anthropic.com from the browser, which is refused at the CORS preflight and carries no key. Fix: deploy the proxy per README Tier 2, then paste its URL (including the secret path segment) in the field below, or set window.__CBSR_LLM_PROXY__ in index.html and rebuild. The deterministic core (dimension map, corridors, the 12×12 matrix, the timeline, exports) is unaffected.",
    errProxyDown: "A proxy is configured but the request never left the browser. Three usual causes: (1) the URL is wrong or the Worker is not deployed; (2) the Worker's ALLOW_ORIGIN does not permit this site's origin, so the CORS preflight is blocked; (3) the proxy host does not resolve. Open the proxy URL directly in a browser for a health check.",
    errAuth: "The proxy rejected the request (401 / 403): it was reached, but the key is missing or invalid. Check that the Worker has had `wrangler secret put ANTHROPIC_API_KEY` run against it, and that the key is still valid on your Anthropic account.",
    errNotFound: "The proxy returned 404: the server was reached but no route matched. Most often the proxy URL has a trailing slash (the Worker matches the secret path segment exactly); next most often the model string is not served to your account (see AI_MODEL at the top of App.jsx). This build strips trailing slashes automatically, so if 404 persists, verify the secret path segment and the model string.",
    errNetwork: "Network error. Check your connection and retry.",
    errEmpty: "The AI returned an empty reply. Click Map again.",
    errParse: "Got a reply but couldn't parse it (this version adds inner-quote repair + truncation repair). If it still fails, paste me the text below:",
    errOther: (e) => `Mapping call failed: ${e}. Click Map again.`,
    rawLabel: "What the model actually returned (first 200 chars):",
    scopeOut: "This description doesn't appear to involve digital tokens, crypto, or payments: it falls outside the register's scope. Try a description closer to a stablecoin / digital-asset business.",
    scopeVague: "The description is still too vague to map to specific dimensions. Add detail: who issues, what it pegs to, any yield / return arrangement, whether it's cross-border, where data sits.",
    partA: "This business is broader than a stablecoin (it reads like a crypto / digital-capital thesis); only ", partBold: "part", partC: " of it falls within the register. What's mapped below is the part that touches register dimensions; the rest is out of this tool's scope.",
    restateL: "Business form, as understood", restateHint: "Not accurate? Edit the box above and re-map.",
    ppL: "Regulatory pressure points", ppHint: "(click to jump to the section)",
    resMeta: (c, g, d, aud) => `${c} verified record${c === 1 ? "" : "s"}${g > 0 ? " · " + g + " coverage gap" + (g === 1 ? "" : "s") : ""} · ${d} dimensions · view: ${aud === "regulator" ? "regulator" : "project team"}`,
    tierP: "Core pressure points: the dimensions this business most distinctively triggers", tierB: "Baseline dimensions: routinely triggered by any business of this type",
    baselineCount: (n, busy) => `${n}${busy ? " · questions generating" : ""} · click to expand`, collapseHint: "click to collapse",
    pTag: "pressure", back: "↑ back to pressure-point list", why: "why relevant",
    qReg: "What a reviewer asks / points to scrutinise", qProj: "Questions to confirm with a licensed lawyer",
    qGen: "model-generated from this entry · not a conclusion", qGap: "no verified record · points to the dimension only",
    qGenerating: "generating…", qPendGen: "Questions couldn't be generated: retry. The entry and source above are still valid.",
    frameFailH: (n) => `Question generation failed: ${n} entr${n === 1 ? "y has" : "ies have"} no questions yet`,
    frameFailKeep: "The verified records, pinpoints, citable flags, and every export are model-free, so everything above remains valid and usable as it stands.",
    frameFailRetry: "Retry only the missing questions",
    noRec: "coverage gap / no verified record",
    gapBody: (j) => `The register has no verified record for ${j} on this dimension yet. It is relevant to your business and you still need to check it: the tool will not invent a rule.`,
    gapQ: (j, dim) => [`What are ${j}'s current requirements on ${dim} for this business?`, `Which authority in ${j} has jurisdiction here, and under what instrument?`, `Are there rules or carve-outs on this dimension specific to this business?`],
    tension: "open tension", channel: "resolution channel: ",
    axClaim: "claim", axLegal: "proposition of law", axOp: "market / operational fact",
    axProv: "provenance", pvText: "confirmed vs official text", pvMixed: "partly confirmed", pvFirm: "practitioner summary", pvUnset: "untiered",
    axBind: "binding", bnForce: "in force", bnMade: "passed · not commenced", bnPolicy: "policy final · pending legislation", bnProp: "proposal · pending", bnProhib: "prohibition", bnNone: "no regime",
    citable: "✓ citable as current law", citableWord: "citable", officialSrc: "official source",
    axesLegend: "Each record shows six axes: claim, force, provenance, official source, freshness, and independent review. All six must pass before it is decision-ready.",
    seamH: "The map stops here.", seamB: "Need a verified corridor analysis for your specific structure across a few jurisdictions / corridors (citable records + corridor feasibility + a checklist to verify)?", seamBtn: "Get a targeted verified analysis →",
    syncOk: "synced live register", syncSnap: "bundled snapshot", syncWait: "syncing…", refreshed: "refreshed",
    asOf: "snapshot as-of", scopeNote: "Scope: this maps the node layer (jurisdiction × dimension): business form → relevant dimensions, governing provisions, and the questions to ask. Corridor feasibility, the time dimension (before/after an instrument takes effect), and cross-jurisdictional analysis live in the full register, not here.",
    discAsOf: "This is a frozen snapshot; its verification as-of date is shown at the top. Regulation moves (a status can flip within a single day): check currency against the primary source before citing.",
    scopeNoCov: "The selected jurisdiction(s) have no verified record on the derived dimensions: a coverage gap in the register, not a vague description. Try other jurisdictions, or query the full register.",
    manualH: "Offline / no-AI fallback: set business features manually",
    manualB: "The routing step needs the model; if it is unavailable, tick the business features below and the tool still produces the dimension map, the matching records, and the citable subset by deterministic rule (this path calls no model). Question generation still needs the model.",
    manualBtn: "Map from these features",
    manualHDemo: "Set business features manually (overrides the automatic reading)",
    manualBDemo: "The description box is read by a deterministic keyword rule. If it missed or misread a feature, tick it here and map again from these features — the output comes from the same verified records either way.",
    refineOpen: "Reading not right? Set the business features by hand ↓",
    refineClose: "Hide manual features ↑",
    qGenDet: "Composed deterministically from this record's own provision / tension fields · not a conclusion",
    aiOffH: "AI-assisted features are off",
    aiOffB: "Document / URL import, auto-map, and question generation need an authenticated model proxy. In the Anthropic sandbox that proxy is injected automatically; to self-host, deploy the Cloudflare Worker in worker/ per README Tier 2 and paste the resulting https://your-worker.workers.dev/YOUR_PROXY_SECRET below. In the meantime the manual-feature fallback below works, and everything else: the dimension map, corridors, the 12×12 matrix, time-travel, and exports: is deterministic and runs with no model.",
    aiOffManual: "Jump to manual mapping",
    aiOffTag: "Deterministic core unaffected",
    proxyLabel: "Or: paste your model-proxy URL to restore AI features",
    proxyPh: "https://your-worker.workers.dev/YOUR_PROXY_SECRET",
    proxyApply: "Apply",
    proxyHint: "Applies immediately and is remembered in this browser, so a reload does not lose it (clear the field and Apply to forget it). A trailing slash is stripped automatically — the Worker matches the secret path segment exactly, and one extra slash returns 404. To set it for every visitor, edit window.__CBSR_LLM_PROXY__ in index.html and rebuild.",
    proxyOn: "Proxy set to",
    proxyRetry: "you can retry the AI features above now.",
    proxyBad: "Enter a valid URL starting with http:// or https://.",
    mfYield: "Holders receive yield / interest / return (incl. routing balances into a yield-bearing product)",
    mfSec: "The instrument can be wrapped as a fund share / security / investment product, or carries an investment character",
    mfLend: "Does lending / credit / deposit-taking, or routes user balances into other products / layers",
    mfPeg: "Pegs to a currency foreign to at least one market served (e.g. a USD peg used outside the US)",
    mfXb: "Serves users across borders, or stores / transfers user data across jurisdictions",
    mfCust: "Holds client assets / reserves (self-custody or via a third-party custodian)",
    qHidden: (n) => `${n} question${n > 1 ? "s" : ""} hidden by source-check`,
    qAllHidden: (n) => `All ${n} generated question${n > 1 ? "s" : ""} for this record failed the source-check and were hidden (no basis in the source text).`,
    corrDemo: "DEMO",
    corrDemoNote: "This corridor contains unverified legs (the HK leg is entirely pending) and is shown as an illustrative demo: not a delivered conclusion; do not cite from it.",
    corrTitle: "Cross-border corridor analysis", corrHint: "The layer that sets this register apart from per-jurisdiction lookup: along one cross-border flow, what clears and what breaks at each leg.",
    corrFlow: "Flow", corrLeg: "Leg", corrGate: "Regulatory gate", corrClears: "Clears", corrBreaks: "Breaks / blocked",
    corrKey: "Binding constraint", corrUsLink: "US doctrinal link", corrSrc: "Sources", corrPending: "pending verification",
    corrPendingNote: "This leg is not yet primary-source verified. The field is left empty rather than filled with placeholder text: the tool asserts nothing it has not verified.",
    corrNeeds: "To verify",
    corrConf: (c) => `corridor confidence: ${c}`,
    empty: "Write a business description (or import from a whitepaper / website URL), pick one or more jurisdictions and an audience, then click Map. The tool first restates the business form it understood and flags the pressure points, then lists each jurisdiction's current requirements and the questions to ask, dimension by dimension.",
    disc: 'This tool outputs the starting point for research / review: the relevant dimensions, the current provisions (taken directly from verified register records, with sources), and the questions to ask. It is not legal advice, makes no compliance determination, and does not replace a licensed lawyer or a regulator. Dimensions and their tier are derived by fixed rules from business features (reproducible for the same input). "Business form, as understood" is the tool\'s restatement of your input; when importing from a source, review it in the box before mapping. Questions are model-generated from the provisions and open tensions; provisions, sources, and confidence come straight from the register, unedited by the model. Questions on coverage gaps are template-generated, point only to the dimension, and assume no specific rule. Some records are transcribed from the maintainer\'s Compliance Matrix and pending final primary-source verification.',
    examples: [
      { label: "Payment stablecoin + routing into a MMF", text: "We issue a USD-pegged payment stablecoin that pays no interest to holders. A user's stablecoin balance can be routed into a registered tokenised money-market fund to generate yield for the user. We also serve non-US users." },
      { label: "HKD-pegged + cross-border retail", text: "We plan to issue an HKD-pegged fiat-referenced stablecoin to retail users in Hong Kong, hosting user KYC data on overseas cloud services, for cross-border payment settlement." },
      { label: "RWA-collateral lending (test)", text: "A digital-money instrument with stable value that can bear yield. It pegs to the US dollar and can take the form of a token, a fund, a preferred security, an account, or another wrapper, underpinned by a mix of digital credit and fiat-cash equivalents. Core business: using illiquid RWA as collateral for lending." },
    ],
  },
};

const langInstruction = (lang) =>
  lang === "zh" ? "Chinese" : lang === "en" ? "English" : "the SAME language as the source content above";
const resolveLang = (lang, text) =>
  lang === "zh" || lang === "en" ? lang : /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text || "") ? "zh" : "en";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// NOTE: the LLM-backed features (whitepaper/URL import, the router, and question generation)
// POST to the Anthropic endpoint WITHOUT a key — that only works inside the Anthropic-
// authenticated artifact environment, which injects auth. On a plain static host these calls
// fail (401/CORS); to self-host you must front them with your own authenticated proxy.
// REGISTER_API (top of file) affects ONLY the static data sync, not these calls. When the
// router call fails, the app now offers a no-AI manual-feature fallback so the deterministic
// core (dimension map + records + citable subset) still works.
// The single most common self-hosting failure is NO PROXY AT ALL: the bare cross-origin POST is
// refused at the CORS preflight, fetch rejects, and the old code reported that as a generic
// "network error" — which sends the user to check their wifi instead of their config. We now
// distinguish the two cases by whether a proxy was actually configured, so the message can name
// the real cause.
async function callClaude(content, opts = {}) {
  const proxy = currentAiProxy();
  let res;
  try {
    res = await fetch(proxy || "https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: opts.max_tokens || 1000, messages: [{ role: "user", content }], ...opts }),
    });
  } catch (e) {
    throw new Error((proxy ? "PROXYDOWN: " : "NOPROXY: ") + (e.message || "fetch failed"));
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
    throw new Error("HTTP " + res.status + (body ? ": " + body : ""));
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.content)) throw new Error("SHAPE: unexpected response");
  const txt = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!txt) throw new Error("EMPTY: no text returned");
  return txt;
}

function repairJson(t) {
  let inStr = false, esc = false, lastSafe = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "}" || c === "]") lastSafe = i + 1;
  }
  let s = t.slice(0, lastSafe || t.length);
  const stack = []; let is2 = false, es2 = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (is2) { if (es2) es2 = false; else if (c === "\\") es2 = true; else if (c === '"') is2 = false; continue; }
    if (c === '"') is2 = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  while (stack.length) s += stack.pop();
  return s;
}

// Re-escape unescaped double-quotes INSIDE string values (the classic failure when a model wraps
// a novel term like "tether" in quotes inside Chinese JSON). A '"' ends a string only when the next
// non-space char is structural (, } ] :); otherwise it is a literal inner quote and gets escaped.
function escapeInnerQuotes(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\n" || s[j] === "\t" || s[j] === "\r")) j++;
      const nx = s[j];
      if (nx === undefined || nx === "," || nx === "}" || nx === "]" || nx === ":") { out += c; inStr = false; }
      else { out += '\\"'; }
      continue;
    }
    out += c;
  }
  return out;
}

// Remove trailing commas before } or ] — a shape real models emit routinely ({"a":1,} or [1,2,]).
// String-aware so a comma inside a quoted value is never touched.
function stripTrailingCommas(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue; // drop this trailing comma
    }
    out += c;
  }
  return out;
}
function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = t.indexOf("{");
  if (a > 0) t = t.slice(a);
  const b = t.lastIndexOf("}");
  const sliced = b !== -1 ? t.slice(0, b + 1) : t;
  const candidates = [
    sliced, t,
    escapeInnerQuotes(sliced),
    repairJson(sliced),
    escapeInnerQuotes(repairJson(sliced)),
    repairJson(escapeInnerQuotes(sliced)),
    stripTrailingCommas(sliced),
    stripTrailingCommas(escapeInnerQuotes(repairJson(sliced))),
  ];
  for (const cand of candidates) { try { return JSON.parse(cand); } catch (e) { /* next */ } }
  return null;
}

const JSON_HYGIENE =
  "CRITICAL JSON RULE: return exactly one valid JSON object. Inside every string value, NEVER use the double-quote character (\"). If you must quote a term (a token name, a label), wrap it in 「」 or use no quotes at all. Do not wrap the JSON in code fences. Do not write anything before or after the JSON object.";

const extractPrompt = (lang) =>
  "Below (as an attached document or as text) is a project's own whitepaper / material. Describe, in <=160 words, the business form it sets out: what is issued or built, the economic model, who it serves, any yield or returns, and any cross-border or data aspects. Describe ONLY what the source states: do not evaluate, judge, rate, or add facts not present. Write in " + langInstruction(lang) + ". Output only the description, no preamble.";
const urlPrompt = (url, lang) =>
  "Use web search to find what the project at this website or name does: " + url +
  "\nThen describe, in <=160 words, its business form: what is issued or built, the economic model, audience, any yield or returns, and any cross-border or data aspects. Describe ONLY what you find. If information is insufficient, say so plainly. Do not evaluate, judge, or rate. Write in " + langInstruction(lang) + ". Output only the description.";

// ROUTER: model only restates + assesses concrete yes/no business features. It does NOT pick
// regulatory dimensions — deriveDims() does that deterministically. This kills tier non-determinism
// and makes routing robust to novel vocabulary (the model judges concepts, not term->key mappings).
function routerPrompt(description, lang, strict) {
  return [
    "You are the routing step of a cross-border stablecoin regulatory-research tool. You DO NOT judge compliance and DO NOT name any statute, rule, or jurisdiction.",
    "Read the business description and output (a) a plain restatement, (b) scope, (c) a small set of yes/no feature flags. You do NOT choose regulatory dimensions: downstream code derives those deterministically from your flags.",
    "", JSON_HYGIENE, "",
    "Business description:", '"""' + description + '"""', "",
    "Return ONLY JSON in this exact shape:",
    "{",
    '  "scope": "in" | "partial" | "out",',
    '  "too_vague": true | false,',
    '  "business_restatement": "1-3 plain sentences restating ONLY what is described; add no facts.",',
    '  "features": {',
    '    "yield": true/false,',
    '    "securities_wrapper": true/false,',
    '    "lending_or_routing": true/false,',
    '    "non_domestic_peg": true/false,',
    '    "cross_border_or_data": true/false,',
    '    "custody": true/false',
    "  }",
    "}", "",
    "Feature definitions: answer about the DESCRIBED business, regardless of the exact words or novel terms it uses:",
    "- yield: holders receive, or the product generates for holders, any interest / yield / return: directly OR by routing balances into a yield-bearing product.",
    "- securities_wrapper: the instrument is, or can be wrapped as, a fund share / security / investment product / preferred security, OR it carries a return that raises an investment-product question.",
    "- lending_or_routing: the business does lending / credit / deposit-taking, OR routes user balances into other products or layers.",
    "- non_domestic_peg: it pegs to a currency that is foreign to at least one market it serves (e.g. a USD peg served outside the US).",
    "- cross_border_or_data: it serves users across borders, OR stores / transfers user data across jurisdictions.",
    "- custody: it holds client assets, private keys, or reserve assets in custody.",
    "",
    'scope: "in" = a stablecoin / fiat-referenced / payment-token issuance or service; "partial" = a broader crypto / digital-asset / DeFi / digital-capital thesis that still touches stablecoin dimensions; "out" = nothing to do with digital tokens, crypto, or payments.',
    'If scope is "out" OR too_vague is true, set every feature to false.',
    "Language: write business_restatement in " + langInstruction(lang) + ".",
    strict ? "\nREMINDER: output ONLY the JSON object; use 「」 (never \") inside string values; every feature must be a boolean." : "",
  ].join("\n");
}

function framerPrompt(audience, entries, lang, strict) {
  const aud = audience === "regulator"
    ? "a regulator / reviewer examining the business. Produce the questions a reviewer would ask and the points to scrutinise."
    : "the project team preparing to meet a licensed lawyer. Produce the specific questions to confirm with the lawyer.";
  return [
    "You are the framing step of a cross-border stablecoin regulatory-research tool. You turn register entries into the QUESTIONS the audience should ask.",
    "You MUST NOT state conclusions or scores, MUST NOT say whether the business complies, and MUST NOT invent any statute, rule, figure, or requirement.",
    "You MUST NOT mention any internal provenance: never name a Compliance Matrix, a maintainer, a document version, an author, transcription status, or a confidence level. Speak only about the law/requirement itself.",
    "", JSON_HYGIENE, "",
    "Audience: " + aud, "",
    "Each entry has a verified requirement (and sometimes a tension / resolution_channel = an open issue). Ground questions in these.",
    "", JSON.stringify(entries, null, 1), "",
    'Return ONLY JSON mapping each entry "key" to an array of 2-3 questions:',
    '{ "<key>": ["question", "question"] }', "",
    "Rules:",
    "- Ground every question in that entry's requirement / tension; introduce no requirement not present.",
    "- Each question <= 22 words, phrased as a question. Never say compliant or non-compliant; assign no score.",
    "- Where an entry has a non-empty tension, at least one question must probe it.",
    "- Language: write every question in " + langInstruction(lang) + ".",
    strict ? "\nREMINDER: output ONLY the JSON object, and use 「」 (never \") inside string values." : "",
  ].join("\n");
}

async function callWithRetry(promptFn, callOpts = {}) {
  let lastErr = "", lastRaw = "";
  for (let i = 0; i < 3; i++) {
    try {
      const raw = await callClaude(promptFn(i > 0), callOpts);
      lastRaw = raw;
      const p = parseJson(raw);
      if (p) return { ok: true, value: p };
      lastErr = "PARSE";
    } catch (e) {
      lastErr = e.message || "unknown";
      if (/HTTP 429|HTTP 529|overload/i.test(lastErr)) await sleep(700 * (i + 1));
    }
  }
  return { ok: false, error: lastErr, raw: lastRaw };
}

function classifyErr(t, err) {
  if (/HTTP 429/.test(err)) return t.errLimit;
  if (/HTTP 529|overload/i.test(err)) return t.errOverload;
  if (/^NOPROXY/.test(err)) return t.errNoProxy;
  if (/^PROXYDOWN/.test(err)) return t.errProxyDown;
  if (/HTTP 401|HTTP 403/.test(err)) return t.errAuth;
  if (/HTTP 404/.test(err)) return t.errNotFound;
  if (/^NETWORK/.test(err)) return t.errNetwork;
  if (/^EMPTY/.test(err)) return t.errEmpty;
  if (/^PARSE/.test(err)) return t.errParse;
  return t.errOther(err);
}

// True when an error string indicates the AI ENVIRONMENT is unavailable (no auth injection and no
// working proxy) rather than a normal per-request failure. HTTP 401/403 = auth not injected; NETWORK
// = fetch blocked (CORS/connection), which is what a cross-origin call to the bare endpoint yields
// off-sandbox. 429/529/PARSE/EMPTY are transient or content issues, NOT environment failures, so
// they must NOT trip the degraded state.
function aiEnvDown(err) {
  const s = String(err || "");
  return /HTTP 401|HTTP 403/.test(s) || /^NETWORK/.test(s) || /^NOPROXY/.test(s) || /^PROXYDOWN/.test(s);
}

function Chip({ children, tone }) {
  const tones = {
    verify: { bg: "#e3edec", fg: "#2f6b6b", bd: "#bcd4d2" }, accent: { bg: "#f1e6d4", fg: "#8a5e23", bd: "#e0cba6" },
    muted: { bg: "#ebe7df", fg: "#6a6357", bd: "#d8d0c2" }, ink: { bg: "#e7e9ee", fg: "#2a3340", bd: "#cfd4dd" },
  };
  const c = tones[tone] || tones.muted;
  return <span style={{ display: "inline-block", fontSize: 11, lineHeight: "16px", padding: "1px 8px", borderRadius: 3, background: c.bg, color: c.fg, border: "1px solid " + c.bd, fontFamily: "ui-monospace, Menlo, Consolas, monospace", letterSpacing: ".02em", whiteSpace: "nowrap" }}>{children}</span>;
}

function Questions({ qs, audience, gap, t, framingActive, hidden }) {
  let body;
  if (qs && qs.length > 0) body = <ul className="qlist">{qs.map((q, i) => <li key={i}>{q}</li>)}</ul>;
  else if (framingActive) body = <div className="q-loading"><span className="spin" />{t.qGenerating}</div>;
  else if (hidden > 0) body = <div className="q-pending">{t.qAllHidden(hidden)}</div>;
  else body = <div className="q-pending">{t.qPendGen}</div>;
  return (
    <div className="qbox">
      <div className="qbox-label">{audience === "regulator" ? t.qReg : t.qProj}<span className="qbox-src">{gap ? t.qGap : (DEMO_MODE ? t.qGenDet : t.qGen)}</span></div>
      {body}
      {qs && qs.length > 0 && hidden > 0 && <div className="q-hidden">{t.qHidden(hidden)}</div>}
    </div>
  );
}

function JurRec({ jur, rec, qs, hidden, audience, t, ui, framingActive }) {
  const ct = rec.confidence === "high" ? "verify" : rec.confidence === "medium" ? "accent" : "muted";
  return (
    <div className="jsub jsub-rec">
      <div className="jsub-head"><span className="jbadge">{jur}</span>
        <div className="jsub-tags">{rec.citable && <span className="citable-badge">{t.citable}</span>}<Chip tone={ct}>confidence: {rec.confidence}</Chip><Chip tone="muted">{rec.status}</Chip></div></div>
      <RecordAxes record={rec} ui={ui} dense />
      <div className="jsub-req">{rec.requirement_summary}</div>
      <div className="jsub-prov">
        <div className="prov-row"><span className="prov-k">source</span><span className="prov-v">{rec.source_primary}</span></div>
        {rec.pinpoint && <div className="prov-row"><span className="prov-k">pinpoint</span><span className="prov-v">{rec.pinpoint}</span></div>}
        <div className="prov-row"><span className="prov-k">record</span><span className="prov-v dim">{rec.id}{rec.authority ? " · " + rec.authority : ""}</span></div>
        {rec.url && <div className="prov-row"><span className="prov-k">official</span><a className="prov-v src-link" href={rec.url} target="_blank" rel="noopener noreferrer">{t.officialSrc} ↗</a></div>}
      </div>
      {rec.tension && (
        <div className="tension"><span className="tension-label">{t.tension}</span><span className="tension-text">{rec.tension}</span>
          {rec.resolution_channel && <span className="tension-chan">{t.channel}{rec.resolution_channel}</span>}</div>
      )}
      <Questions qs={qs} hidden={hidden} audience={audience} gap={false} t={t} framingActive={framingActive} />
    </div>
  );
}

function JurGap({ jur, jurName, qs, audience, t }) {
  return (
    <div className="jsub jsub-gap">
      <div className="jsub-head"><span className="jbadge jbadge-gap">{jur}</span><Chip tone="muted">{t.noRec}</Chip></div>
      <div className="gap-body">{t.gapBody(jurName)}</div>
      <Questions qs={qs} audience={audience} gap={true} t={t} framingActive={false} />
    </div>
  );
}

function DimBlock({ dim, framed, framedHidden, framingActive, audience, t, ui, blockRef, showBack, onBack }) {
  const cref = dim.jurs.map((x) => x.rec && x.rec.constraint_ref).find(Boolean) || CONSTRAINT[dim.key];
  return (
    <div className={"dim-block" + (dim.tier === "pressure" ? " dim-pressure" : "")} ref={blockRef}>
      <div className="dim-head">
        <div className="dim-name">
          {dim.tier === "pressure" && <span className="ptag">{t.pTag}</span>}
          {DATA.dimensions[dim.key] || dim.key}
          {SPINES.has(dim.key) && <span className="spine">SPINE</span>}
        </div>
        <div className="dim-head-right">
          {cref && <Chip tone="ink">{cref}</Chip>}
          {showBack && <button className="backlink" onClick={onBack}>{t.back}</button>}
        </div>
      </div>
      {dim.reason && <div className="dim-reason"><span className="why-label">{t.why}</span>{dim.reason}</div>}
      <div className="dim-jurs">
        {dim.jurs.map((x) => x.rec
          ? <JurRec key={x.jur} jur={x.jur} rec={x.rec} qs={framed[x.rec.id]} hidden={framedHidden && framedHidden[x.rec.id]} audience={audience} t={t} ui={ui} framingActive={framingActive} />
          : <JurGap key={x.jur} jur={x.jur} jurName={DATA.jurisdictions[x.jur]} qs={framed["gap:" + x.jur + ":" + dim.key]} audience={audience} t={t} />
        )}
      </div>
    </div>
  );
}

// ── Corridor evidence discipline ──────────────────────────────────────────────
// A corridor leg carries the same contract as a node record: a field is either
// VERIFIED (a value, backed by leg.evidence_tier and the corridor's sources) or
// ABSENT (null), with the gap declared structurally in leg.pending. There is no
// third state, and in particular no placeholder text sitting in the value slot
// where a finding is supposed to sit — an unverified leg must not be readable, by
// a human or an agent, as if it were a finding.
//
// isPlaceholder() is the legacy backstop. Earlier revisions inlined angle-bracket
// VERIFY markers into the value slot. The invariant below fails the build if one
// returns; the guard stays so that a stale dataset still degrades honestly rather
// than printing the raw marker.
//
// The [<] character class is deliberate and load-bearing — do NOT "simplify" it back
// to a bare "<". scripts/check-invariants.mjs --dist greps the built bundle for that
// exact marker, and Vite bundles regex literals verbatim. Written the obvious way, the
// detector emits its own detection pattern into dist/ and the build fails on the guard
// itself: "placeholder in built asset", while the data is in fact clean. [<]VERIFY
// matches identically at runtime but never appears as that substring in the source, so
// the real check keeps its teeth. (Same trick as `ps aux | grep '[s]shd'`.)
const isPlaceholder = (s) => typeof s === "string" && /[<]VERIFY/i.test(s);
const legValue = (v) => (v == null || v === "" || isPlaceholder(v) ? null : v);
// [v0.11.2 修复] 按 corridor/v2-rich 的真实字段判定待核验状态。leg.gate 与 corr.sources
// 在该 schema 下都不存在：监管关口由 leg.sub_gates[] 承载，出处按段落挂在 leg.sources[] 上。
const legPending = (leg) =>
  !leg ? null
  : leg.pending ? leg.pending
  : ((leg.sub_gates || []).some((g) => isPlaceholder(g.requirement) || isPlaceholder(g.analysis))
     || isPlaceholder(leg.clears) || isPlaceholder(leg.breaks))
    ? { fields: ["sub_gates", "clears", "breaks"] }
    : null;
const corridorPending = (corr) =>
  (corr.boundary_analysis || []).some((leg) => legPending(leg) || (leg.sources || []).some(isPlaceholder));

// Build invariant, in the spirit of the register's own CI checks: no unverified
// placeholder may reach ANY output surface — view, export, or agent substrate.
// scripts/check-invariants.mjs enforces the same rule over the built bundle, so
// this cannot regress silently. A divergence is surfaced, never shipped quietly.
(function assertNoPlaceholdersInData() {
  const hit = JSON.stringify(DATA).match(/[<]VERIFY[^"]*/i); // [<] deliberate: see note above
  if (!hit) return;
  const msg = "CBSR invariant violated: unverified placeholder in shipped data: " + hit[0];
  try { console.error(msg); } catch (e) {}
  try { if (import.meta && import.meta.env && import.meta.env.DEV) throw new Error(msg); } catch (e) { if (e instanceof Error && e.message === msg) throw e; }
})();

// Legacy alias — kept so any existing caller of isPending keeps working.
const isPending = isPlaceholder;

function CorridorPanel({ corr, t }) {
  const ct = corr.confidence === "high" ? "verify" : corr.confidence === "medium" ? "accent" : "muted";
  const demo = corridorPending(corr);
  return (
    <div className="corridor">
      <div className="corridor-head">
        <div className="corridor-title">{t.corrTitle}<span className="corridor-legs">{corr.legs.join(" → ")}</span></div>
        <div className="corridor-head-tags">{demo && <Chip tone="muted">{t.corrDemo}</Chip>}<Chip tone={ct}>{t.corrConf(corr.confidence)}</Chip></div>
      </div>
      {demo && <div className="corridor-demo-note">{t.corrDemoNote}</div>}
      <div className="corridor-hint">{t.corrHint}</div>
      <div className="corridor-flow"><span className="corridor-k">{t.corrFlow}</span><span className="corridor-flow-v">{corr.flow}</span></div>

      <div className="corridor-legs-grid">
        {/* [v0.11.2 修复] 监管关口改读 leg.sub_gates[]（label / requirement / analysis），
            出处改读 leg.sources[]，与 corridor/v2-rich 记录一致。 */}
        {corr.boundary_analysis.map((leg) => {
          const pend = legPending(leg);
          const clears = legValue(leg.clears), breaks = legValue(leg.breaks);
          const gates = leg.sub_gates || [];
          const srcs = (leg.sources || []).filter((s) => !isPlaceholder(s));
          return (
            <div key={leg.leg} className={"leg" + (pend ? " leg-pending" : "")}>
              <div className="leg-head"><span className="jbadge">{leg.leg}</span>{pend && <Chip tone="muted">{t.corrPending}</Chip>}</div>
              <div className="leg-row"><span className="leg-k">{t.corrGate}</span><span className="leg-v">
                {gates.length
                  ? gates.map((g) => (
                      <span key={g.id} className="leg-gate">
                        <span className="leg-gate-l">{g.label}</span>
                        <span className="leg-gate-r">{legValue(g.requirement)}</span>
                        {legValue(g.analysis) && <span className="leg-gate-a">{g.analysis}</span>}
                      </span>
                    ))
                  : <em className="pend">{t.corrPendingNote}</em>}
              </span></div>
              <div className="leg-row"><span className="leg-k leg-k-clear">{t.corrClears}</span><span className="leg-v">{clears || <em className="pend">—</em>}</span></div>
              <div className="leg-row"><span className="leg-k leg-k-break">{t.corrBreaks}</span><span className="leg-v">{breaks || <em className="pend">—</em>}</span></div>
              {srcs.length > 0 && (
                <div className="leg-row"><span className="leg-k">{t.corrSrc}</span>
                  <span className="leg-v leg-src">{srcs.map((s, i) => <span key={i}>{s}{i < srcs.length - 1 ? " · " : ""}</span>)}</span>
                </div>
              )}
              {pend && pend.needs && <div className="leg-row leg-needs"><span className="leg-k">{t.corrNeeds}</span><span className="leg-v"><em className="pend">{pend.needs}</em></span></div>}
            </div>
          );
        })}
      </div>

      <div className="corridor-key"><span className="corridor-key-label">{t.corrKey}</span>{corr.key_constraint}</div>
      {corr.us_doctrinal_link && <div className="corridor-uslink"><span className="corridor-k">{t.corrUsLink}</span><span>{corr.us_doctrinal_link}</span></div>}
    </div>
  );
}


// [v0.11.2 修复] worked example 的选取。CorridorPanel 只消费手写的 RICH 记录
// (corridor/v2-rich: 带 legs / boundary_analysis / sources)；DATA.corridors 里其余
// 记录是 v3-directed-edge 计算骨架，没有这三个字段。原先按 DATA.corridors[0] 取，
// 快照按 corridor_id 排序后首位变成 v3 骨架，corr.legs.join 抛错使走廊视图整页崩溃。
// 这里按 schema 判别取唯一的 rich 记录。
const WORKED_CORRIDOR = (DATA.corridors || []).find((c) => c && c.schema === "corridor/v2-rich") || null;

// ─────────────────────────────────────────────────────────────────────────────
// v6 — layer-coverage build. The five views below expose the register layers the
// node-level mapper alone could not: the directed CORRIDOR layer, the dated TIME
// engine, the computed-vs-authored RECONCILIATION and the settlement/convergence
// macro readings, and the agent (MCP) surface. Everything is a projection of the
// bundled register + its computed layer; no facts are added here.
// ─────────────────────────────────────────────────────────────────────────────

const VIEWS = ["evaluate", "map", "corridors", "substrate", "forward", "structure", "agents"];

// Extra strings for the new views, merged over T[ui] at render time so the giant
// T literal above stays untouched.
const TX = {
  zh: {
    // [v0.11.2 修复] 新增 navEval / navEvalSub：VIEWS 首项 "evaluate" 此前没有对应的导航标题与副标题，
    // Nav 的 labels 表因此取到 undefined，undefined[0] 抛错导致整棵 React 树未挂载（白屏）。
    navEval: "合规评估", navMap: "维度地图", navCorr: "走廊", navSub: "约束基底", navFwd: "前瞻", navStruct: "结构", navAgents: "机器接口",
    navEvalSub: "确定性判定 + 回执", navMapSub: "节点层", navCorrSub: "有向可行性 + 时间", navSubSub: "八约束 · 六交互 · C1–C8", navFwdSub: "触发register + 敏感度",
    navStructSub: "对账 · 结算 · 收敛", navAgentsSub: "MCP · 可引用给机器",
    // corridor "why" (grounded explanation of the computed class)
    whyH: "为何是这个类别：落到约束基底",
    whyRule: {
      clean: "干净通道 · 两端各自可授权,顺流方向无等效步骤",
      dest_blocked: "目的地关口 · 存在发行禁止",
      dest_pre: "目的地关口 · 尚无可授权发行路径",
      dest_transition: "目的地关口 · 制度已通过、尚未生效",
      dest_gate: "目的地关口 · 需等效/承认/通道认定(货币主权渠道)",
      origin_drag: "起点拖拽 · origin 无可出口的可授权代币",
      compose: "组合问题 · 两制度无法直接组合",
    },
    whyClean: "两端均为已生效、可授权的发行制度;此向无绑定约束需引用：干净通道。",
    whyNote: "此解释由 register 的 compose() 类别 + C1–C8 基底逐边推导:类别读自计算层,绑定约束读自节点记录：不新增事实。点约束 ID 到「约束基底」看全网。",
    // substrate view
    subH: "约束基底：八约束的可控词表,与它们生成的组合问题",
    subLead: "地图把业务映到维度,走廊把两端组合成可行性。这一层是二者之下的引擎:Architecture 论文归纳出的八个监管约束(C1–C8),每个法域在每个约束上取一个「极」,极由承载 constraint_ref 的记录构成、并标注是否可引用。六个交互集(A–F)是这些约束联合绑定时生成的组合问题：正是它们推导出走廊里的每一个类别。全部为 register 的投影,不新增事实。",
    subTallyCit: "可引用(tier1 · 现行 · 已核)", subTallyPend: "待核积压(tier1 · 现行 · 未核)", subTallyT1: "法律命题(tier1_legal)", subTallyTot: "记录总数",
    subConH: "八约束(C1–C8)", subConX: "跨境组合问题:", subConDims: "对应维度:",
    subGridH: "法域 × 约束：极网格", subGridHint: "每格是该法域在该约束上的极。点任一格看其支撑记录。颜色是证据轴:该约束单元是否已达到「可作现行法引用」,还是仍在核验积压里。这就是把核验积压做成可交互面：不是空占位。",
    subStatCit: "可引用极", subStatPend: "现行 · 待核", subStatOther: "记录在册(草案/运营/混合)", subStatNone: "无记录",
    subPoleNone: "此约束单元暂无承载 constraint_ref 的记录。", subTension: "张力:",
    subIntH: "六交互集(A–F)", subIntLead: "八约束并非独立运作。以下六对约束的联合绑定生成本文分析的组合问题;点约束 ID 高亮到网格与词表。",
    // MCP runner
    mcpRunH: "现场调用：对内嵌 register 跑一个工具",
    mcpRunLead: "工具面不只是目录。选一个工具,它就对上方内嵌的 register 实跑,返回真实形状：无网络、不生成事实,输出即部署服务器该工具会给出的投影。",
    mcpArgJur: "法域", mcpArgO: "起点", mcpArgD: "目的地",
    mcpRunNote: "asserts_new_facts: false：每个工具只筛选和重排已发布记录。这演示了论文的核心主张:「可作现行法引用」是 build 能判定的记录属性,机器一次拿到干净子集。",
    // snapshot / liveness banner
    snapFrozen: "内置快照", snapLive: "API 已核对", snapChecking: "正在核对 API", snapFallback: "API 未通过 · 已回退",
    snapAgeNew: (d) => `截至 ${d}`,
    snapAge: (as_of, d) => `快照截至 ${as_of} · 已 ${d} 天`,
    snapDisc: "这是一个带日期、可版本化的登记册的一次快照：不是活体订阅。监管可在同一日内翻转（本 register 的台湾条目即在快照当日三读通过）。引用前请对照一手来源核实时效。",
    snapDiscLive: "records、meta 与计算层的版本和生成日期完全一致；已加载 API 的六条证据轴。它仍是该日期的版本快照，不是实时订阅。",
    snapDiscChecking: "正在用公开 Register API 核对内置快照；核对完成前只显示内部一致的内置版本。",
    snapDiscFallback: "远端 API 未通过网络、封装、完整性或版本一致性检查，因此未混用任何远端记录；当前仍完整使用内置快照。",
    // shared class vocabulary
    clsLegendT: "可行性类别（Corridor Atlas 六类）",
    clsLegendHint: "有向读取：读目的地入境关口，origin 施加出口/egress 限制时叠加一个 origin 拖拽。入境系统性地严于出境：同一对法域两个方向可落不同类别。",
    ovLabel: "origin 出口限制",
    // corridors view
    corrH: "走廊层：一条资金流沿途,什么能清算、什么会断,以及哪天会变",
    corrLead: "节点层告诉你每个法域各自要什么;走廊层把两端组合起来,给出这条有向通道今天的可行性类别、它在未来某个生效日的变化,以及若某部待决法律通过它会怎样。下方类别由 register 的 compose() 引擎从各法域信号表逐边推导（标注预览,非权威结论）。",
    corrPickO: "起点法域（origin）", corrPickD: "目的地法域（destination）",
    corrSame: "选两个不同法域看有向通道。",
    corrToday: "今日类别", corrReverse: "反向", corrAsym: "方向不对称",
    corrUndir: "无向合成", corrOverride: "此向叠加 origin 出口限制拖拽。",
    corrTransH: "已排定的变化（按生效日）", corrTransNone: "在已排定的生效日之前,本向类别无变化。",
    corrFlip: (dt, f, to) => `${dt}：由 ${f} 翻转为 ${to}`,
    corrWhatifH: "若某部待决法律通过（if-enacted,非预测）",
    corrWhatifNone: "无待决法律会改变本通道的类别。",
    corrBloc: "结算基底", corrBlocSame: (b) => `两端同属 ${b} bloc 内部轨道`,
    corrBlocCross: "跨 bloc：两端分属对立的结算实验,互不互通",
    corrBlocBridge: "经香港 Project Ensemble 的桥接位",
    corrBlocOff: "两端均不在共享结算实验之内",
    corrWorkedH: "手工精修的走廊（深度样本）",
    corrWorkedHint: "上面的类别是全 66 对的计算骨架;下面是一条手工核验到条款级的走廊。诚实标注:BR 段已核,HK 段仍在核验 backlog：这正是方法论的 honest-residual 纪律,不凭空补全。",
    corrExample: "示例通道", corrExDated: "带日期的翻转", corrExPre: "前制度起点", corrExBlocked: "禁止目的地",
    // forward view
    fwdH: "时间引擎：待决的法律变化,以及它们落在有向图的哪里",
    fwdLead: "静态地图是一张照片。前瞻层把公共记录上已可见、但尚未生效的法律变化逐一列出:每一条说明它会改变哪些有向边的可行性类别、依据哪些记录、以及它本身处于何种 conditional 状态。这是 conditioning(条件化),不是 forecasting(预测):每部法律一条 if-then,不赋概率、不编日期。",
    fwdSensH: "走廊敏感度排序", fwdSensHint: "一条待决触发在解决时会重分类多少条有向边。这是关于图结构的陈述(触发是单向还是双向、该法域的入度/出度),不是关于哪部法案会通过。",
    fwdRank: "排名", fwdEdges: "重分类边数", fwdFanIn: "入向", fwdFanOut: "出向", fwdBoth: "双向触发",
    fwdResolves: "解决为", fwdInsens: "对任何正向触发不敏感",
    fwdTwoH: "两种排序必须并读", fwdTwoByEdges: "按重分类边数", fwdTwoByDate: "按生效日先后",
    fwdDisagreeH: "一处 computed-vs-authored 分歧（如实保留,不覆盖）",
    fwdRegH: "触发register（截至 2026-06-30 公共记录上的法律变化）",
    fwdRegKind: "种类", fwdRegDir: "方向", fwdRegClass: "类别效应", fwdRegCert: "确定性",
    fwdJurH: "按法域读（给监管者）", fwdJurHint: "监管者问的不是「整个空间在动什么」,而是「哪些待决变化会改变进出我这个法域的通道,我对哪些对手方最敞口」。同一份数据,重排即可。",
    fwdJurPick: "选一个法域看它的前瞻读数",
    fwdOwnEv: "本法域待决事件", fwdInb: "入向重分类", fwdOutb: "出向重分类", fwdExp: "对手方敞口(按敞口排序)",
    fwdNoEv: "本法域无待决事件。", fwdNoInb: "无入向边因待决触发而重分类。", fwdNoOutb: "无出向边因待决触发而重分类。",
    fwdMoves: "移动类别", fwdAccess: "仅改变可及性（intra-regime gating）",
    fwdAccessNote: "关键区分:这类变化改变「谁可以运营、哪些代币可入市」,但不移动任何可行性类别。一个类别中心的敏感度读数会把它记为「无」：低敏感度须读作「无待决类别翻转」,不是「无事发生」。欧盟 2026-07-01 MiCA 过渡到期即此类。",
    fwdVia: "触发", fwdTiming: "时点",
    // structure view
    structH: "宏观结构：方法论的证明,以及静态地图表达不了的一个断层",
    structReconH: "computed-vs-authored 对账",
    structReconLead: "方法论论文最原创的一环:同一个下游结论(通道可行性)推导两次：一次手工,一次由小型可审计规则引擎在带出处的信号表上跑：然后把两者的每一处分歧作为 finding 呈现,而非在任一侧悄悄抹平。计算层作为「标注预览」交付,不是权威结论。下方即该对账的实况:",
    structAgree: "对账一致", structPairs: "对法域", structFindings: "分歧(作为 finding 保留)",
    structReconNote: "两处分歧同源:英国制度已通过但尚未生效,一层视之为「尚不可桥接」,另一层视之为「可干净桥接」。这正是引擎该暴露的、有研究价值的信号：若强行覆盖一侧,信号就被销毁了。时间维随后区分:其中随生效日(2027-10-25)消解的部分,与一个真正持久的建模差异。",
    structSetlH: "结算基底沿 bloc 断裂",
    structSetlTier: "证据分级:tier-2 运营 · 弱于 §3 的一手法律层",
    structSetlLead: "跨境稳定币栈的批发结算层不是单一共享开放轨道。公共记录显示它沿地缘 bloc 线分裂:bloc 内开放、跨 bloc 封闭。把三个实验的真实运营方标对,是把这一节从软类比变成可核查主张的关键。",
    structSetlCorr: "更正",
    structBlocAgora: "Agorá 轨道（美元路由）", structBlocMbridge: "mBridge 轨道（绕美元）",
    structBlocBridge: "Ensemble 桥接（香港）", structBlocNone: "不在共享实验内",
    structEdgeCounts: "按 bloc 关系统计的 66 对通道",
    structConvH: "收敛:收益红线",
    structConvLead: "跨法域(而非逐边)读,register 浮现第二个宏观 finding:相互独立的立法系统正收敛到同一条功能边界：为「单纯持有」而付的收益被禁,「活动关联」的奖励被允许。这条线由同一个功能测试(转换方向、所有权披露、时点独立、收益归属、审计线索)在各法域裁决。",
    structConvAnchor: "锚定实例(可引用深度)", structConvSibling: "同族限制", structConvCounter: "反例",
    structConvDisc: "纪律:仅在 tier1_legal + in_force + resolution_text 且功能线两侧都有记录处,才以可引用深度断言收敛：今天只有美国。其余在册于「禁止」一侧,两侧线作为 backlog,不断言其画同一条线。这正是 register 自身的 citable-purity 纪律,是它让收敛成为 finding 而非印象。",
    // agents view
    agH: "为机器而可引用：register 的 agent 接口",
    agLead: "比较监管的机读知识库,越来越多不是被会权衡 caveat 的人读,而是被软件读:检索管线、语言模型 agent、自动合规工具,它们会把某字段所断言的当作事实。方法论论文的核心主张是:一个字段是不是「可作现行法引用」,应当是 build 能判定的记录属性,而非人在每次读取时重新做的判断。同一套 register 因此暴露一个 typed 的 MCP 工具面,让 agent 消费：每个工具只筛选和重排已发布记录,不生成事实。",
    agToolSurface: (n) => `MCP 工具面 · ${n} 个 typed 工具`,
    agGuard: "护栏(每次调用都成立)",
    agSampleH: "示例调用 → 返回形状",
    agSampleTool: "citable_law()",
    agSampleDesc: "仅返回六轴全部通过的决策就绪记录：tier1_legal、in_force、resolution_text、official、current、reconciled，并附 source.url + pinpoint。",
    agSampleNote: "六轴门槛在 build 时和调用时同时执行；结构性候选与真正可作决策依据的记录不会再被混为一个数字。",
    agLayerNode: "节点 + 证据轴", agLayerEvidence: "核验 + 可引用", agLayerConstraint: "约束基底",
    agLayerCorridor: "走廊 + 组合", agLayerTime: "时间引擎", agLayerComputed: "计算层对账", agLayerStakeholder: "stakeholder 投影", agLayerAgentic: "证据检索 + 决策审计",
    agConsume: "谁在消费这一层",
    // export
    expBtn: "导出简报（Markdown）", expBtnCorr: "导出走廊分析（Markdown）", expBtnFwd: "导出前瞻读数（Markdown）",
    expReady: "简报已生成并下载。把它交给持牌律师作为交接物。",
    expNote: "导出为 Markdown:条款 + 出处 + 该问的问题 + 走廊 + 前瞻读数：一份可交给律师的清单。不含任何合规结论。",
    // session / seam
    sessH: "本次会话覆盖的层",
    sessNode: (n) => `节点层:${n} 个维度`, sessCorr: (n) => `走廊层:${n} 对通道`,
    sessFwd: (n) => `前瞻层:${n} 个法域读数`, sessStruct: "结构层:对账/结算/收敛",
    layerBadge: "层",
    scopeNote: "覆盖范围:本工具从业务自述映射到节点层（法域 × 维度）：相关维度、对应条款（带出处）与该问的问题;并把同一份 register 的走廊可行性、时间维（生效前后）、computed 对账与 agent 接口作为上方各视图一并露出。所有内容均为 register 及其计算层的投影,不新增事实。",
    // 12×12 corridor heat matrix
    mxH: "全网走廊矩阵：一眼看尽 132 条有向边",
    mxHint: "行是起点、列是目的地,每格是该有向边在所选日期的可行性类别。点任一格钻取该走廊。拖动上方时间轴,看已排定的生效日到来时整列翻类。",
    mxOrigin: "起点 ↓", mxDest: "目的地 →",
    mxFlip: "此格在所选日期已翻类",
    mxTodayTag: "今日快照",
    // time-travel slider (compose(as_of))
    ttH: "时间轴：compose(as_of)",
    ttHint: "把日期拖到某个已排定的生效日之后,走廊类别按 register 的时间引擎重算。已排定/已公布的翻转会自动生效;或有（无公布日）的触发不自动生效,单独标注。",
    ttAsOf: "截至日期", ttToday: "今日", ttReset: "回到今日",
    ttTodayMark: "今日（真实日期）", ttSnapMark: "数据快照基线",
    ttInForce: "已生效", ttUpcoming: "未到",
    ttDateNote: (today, snap, days) => `今日 ${today} · 数据快照截至 ${snap}（已 ${days} 天）。两者是两件事：已排定的生效日到期后走廊类别会自行翻转（这些日期是已公布的事实），而条文内容仍停留在快照日。拖到「数据快照基线」可看当日所见的状态。`,
    ttHorizons: "关键节点", ttScheduled: "已排定", ttContingent: "或有(无日期)",
    ttDist: "全网类别分布", ttChanged: (n) => `${n} 条边相对今日已翻类`, ttNoChange: "相对今日无翻转",
    ttGeniusCap: "美国 GENIUS §18 外限", ttUkGazette: "英国制度生效(公布)",
    ttPendingH: "或有触发（无公布日,不随时间轴自动生效）",
    ttPendingNote: "这些制度已通过/待决但无确定生效日;它们的翻转是条件性的,时间轴不替它们下判断：与 register 的「已排定 vs 或有」纪律一致。",
    // CSV / citation export
    expCsvCorr: "导出走廊矩阵（CSV）", expCsvCite: "导出可引用记录（CSV）", expBib: "导出引用（BibTeX）",
    expCsvCorrNote: "132 条有向边 · 起点/目的地/类别/含义/翻转日：表格工具即用。",
    expCsvCiteNote: (n) => `${n} 条可引用记录 · 每条带官方出处 URL + pinpoint：律所/四大交接物。`,
    expBibNote: "本 register 的 BibTeX 条目(含 DOI),供论文/备忘录引用。",
    expCff: "导出引用文件（CITATION.cff）",
    expCffNote: "标准 Citation File Format 文件(含 DOI + ORCID)：GitHub 与 Zenodo 可直接识别。",
    expDoneCsv: "已导出 CSV。",
    expDoneBib: "已导出 BibTeX。",
    expDoneCff: "已导出 CITATION.cff。",
    expPdf: "导出可引用记录 PDF",
    expPdfNote: "决策就绪记录的 PDF 摘要（含 DOI 页眉）：可打印、可分享的单文件。",
    expDonePdf: "已导出 PDF。",
    expAsOfCol: "截至日期类别",
  },
  en: {
    // [v0.11.2 fix] navEval / navEvalSub added: see the zh block above.
    navEval: "Evaluate", navMap: "Dimension map", navCorr: "Corridors", navSub: "Substrate", navFwd: "Forward", navStruct: "Structure", navAgents: "Machine surface",
    navEvalSub: "deterministic decision + receipt", navMapSub: "node layer", navCorrSub: "directed feasibility + time", navSubSub: "8 constraints · 6 interactions · C1–C8", navFwdSub: "trigger register + sensitivity",
    navStructSub: "reconciliation · settlement · convergence", navAgentsSub: "MCP · citable for machines",
    // corridor "why" (grounded explanation of the computed class)
    whyH: "Why this class: grounded in the substrate",
    whyRule: {
      clean: "Clean corridor · each end separately authorizable, no equivalence step in the direction of flow",
      dest_blocked: "Destination gate · an issuance prohibition applies",
      dest_pre: "Destination gate · no authorizable issuance pathway yet",
      dest_transition: "Destination gate · regime adopted but not yet operative",
      dest_gate: "Destination gate · equivalence / recognition / channel determination required (monetary-sovereignty channel)",
      origin_drag: "Origin drag · the origin has no exportable authorizable token",
      compose: "Composition problem · the regimes do not compose directly",
    },
    whyClean: "Both ends are in-force, authorizable issuance regimes; no binding constraint to cite in this direction: a clean corridor.",
    whyNote: "This explanation is derived edge-by-edge from the register's compose() class plus the C1–C8 substrate: the class is read from the computed layer, the binding constraint from the node record: no new facts. Tap a constraint ID to see the whole grid under Substrate.",
    // substrate view
    subH: "Constraint substrate: the eight-constraint vocabulary and the composition problems it generates",
    subLead: "The map projects a business onto dimensions; corridors compose two ends into feasibility. This layer is the engine beneath both: the eight regulatory constraints (C1–C8) induced in the Architecture paper. Each jurisdiction takes a pole on each constraint, built from the records that carry a constraint_ref and flagged for citability. The six interaction sets (A–F) are the composition problems joint binding generates: and they are what produce every class in the corridor view. All of it is a projection of the register; it asserts no new facts.",
    subTallyCit: "citable (tier1 · in force · verified)", subTallyPend: "verification backlog (tier1 · in force · unverified)", subTallyT1: "legal propositions (tier1_legal)", subTallyTot: "records total",
    subConH: "The eight constraints (C1–C8)", subConX: "Cross-border composition problem:", subConDims: "Register dimensions:",
    subGridH: "Jurisdiction × constraint: the pole grid", subGridHint: "Each cell is the jurisdiction's pole on that constraint. Tap a cell for its justifying record(s). Colour is the evidence axis: whether that constraint cell has reached 'citable as current law', or is still in the verification backlog. This is the backlog made interactive: not an empty placeholder.",
    subStatCit: "citable pole", subStatPend: "in force · pending verification", subStatOther: "on record (draft / operational / mixed)", subStatNone: "no record",
    subPoleNone: "No record carries a constraint_ref for this cell yet.", subTension: "Tension:",
    subIntH: "The six interaction sets (A–F)", subIntLead: "The eight constraints do not operate independently. Joint binding across these six pairs generates the composition problems the paper analyses; tap a constraint ID to highlight it in the grid and vocabulary.",
    // MCP runner
    mcpRunH: "Run it live: call a tool against the embedded register",
    mcpRunLead: "The tool surface is not just a catalogue. Pick a tool and it runs against the register embedded above, returning the real shape: no network, no synthesis; the output is exactly the projection the deployed server's tool would return.",
    mcpArgJur: "jurisdiction", mcpArgO: "origin", mcpArgD: "destination",
    mcpRunNote: "asserts_new_facts: false: each tool only filters and reshapes published records. This demonstrates the paper's central claim: 'citable as current law' is a record property the build can decide, so a machine gets the clean subset in one call.",
    snapFrozen: "Bundled snapshot", snapLive: "API-verified", snapChecking: "Checking API", snapFallback: "API rejected · fallback",
    snapAgeNew: (d) => `as of ${d}`,
    snapAge: (as_of, d) => `snapshot as of ${as_of} · ${d} days old`,
    snapDisc: "This is one snapshot of a dated, versionable register: not a live subscription. Regulation can flip intraday (this register's Taiwan entry passed at third reading on the snapshot date itself). Verify against the primary source before relying on it.",
    snapDiscLive: "Records, meta, and the computed layer share the exact version and generated date, so all six API evidence axes were loaded. This remains a dated version snapshot, not a live subscription.",
    snapDiscChecking: "Checking the bundled snapshot against the public Register API. Until that completes, only the internally consistent bundled build is shown.",
    snapDiscFallback: "The remote API failed a network, envelope, completeness, or version-consistency check. No remote records were mixed in; the complete bundled snapshot remains active.",
    clsLegendT: "Feasibility classes (Corridor Atlas, six)",
    clsLegendHint: "Read at the destination's inbound gate, with an origin drag where the origin imposes an export/egress restriction. Inbound is systematically tighter than outbound: the two directions of one pair can fall in different classes.",
    ovLabel: "origin export restriction",
    corrH: "The corridor layer: what clears, what breaks along a flow, and which day it changes",
    corrLead: "The node layer tells you what each jurisdiction requires on its own; the corridor layer composes the two ends and gives this directed corridor's feasibility class today, its change on a future commencement date, and what happens to it if a pending change in law is enacted. The classes below are derived edge-by-edge by the register's compose() engine from the per-jurisdiction signal table (a labelled preview, not an authoritative verdict).",
    corrPickO: "Origin jurisdiction", corrPickD: "Destination jurisdiction",
    corrSame: "Pick two different jurisdictions to read the directed corridor.",
    corrToday: "Class today", corrReverse: "Reverse", corrAsym: "Directional asymmetry",
    corrUndir: "Undirected composite", corrOverride: "This direction carries an origin export-restriction drag.",
    corrTransH: "Scheduled changes (by commencement date)", corrTransNone: "This direction's class does not change before any scheduled commencement date.",
    corrFlip: (dt, f, to) => `${dt}: flips ${f} → ${to}`,
    corrWhatifH: "If a pending change in law is enacted (if-enacted, not a forecast)",
    corrWhatifNone: "No pending change in law would move this corridor's class.",
    corrBloc: "Settlement substrate", corrBlocSame: (b) => `both ends on the ${b} bloc-internal rail`,
    corrBlocCross: "cross-bloc: the ends sit on rival settlement experiments, not mutually interoperable",
    corrBlocBridge: "via Hong Kong's Project Ensemble bridge position",
    corrBlocOff: "neither end sits on a shared settlement experiment",
    corrWorkedH: "Hand-authored corridor (deep sample)",
    corrWorkedHint: "The classes above are the computed skeleton for all 66 pairs; below is one corridor hand-verified to clause depth. Marked honestly: the BR leg is verified, the HK leg is still in the verification backlog: the methodology's own honest-residual discipline, not filled in from nothing.",
    corrExample: "Example corridors", corrExDated: "dated flip", corrExPre: "pre-regime origin", corrExBlocked: "blocked destination",
    fwdH: "The time engine: pending changes in law, and where they land on the directed map",
    fwdLead: "The static map is a photograph. The forward layer lists, one at a time, the changes in law already visible on the public record but not yet effective: each states which directed edges change class, which records it rests on, and the conditional status under which it is itself contingent. This is conditioning, not forecasting: one if-then per change in law, no probabilities, no invented dates.",
    fwdSensH: "Corridor-sensitivity ordering", fwdSensHint: "How many directed edges a pending trigger reclassifies on resolution. This is a statement about graph structure (whether the trigger is one- or both-directional and the jurisdiction's in-/out-degree), not about which bill will pass.",
    fwdRank: "Rank", fwdEdges: "edges reclassified", fwdFanIn: "fan-in", fwdFanOut: "fan-out", fwdBoth: "both-directions trigger",
    fwdResolves: "resolves to", fwdInsens: "insensitive to any positive trigger",
    fwdTwoH: "Two orderings must be read together", fwdTwoByEdges: "by edges reclassified", fwdTwoByDate: "by dated horizon",
    fwdDisagreeH: "One computed-vs-authored divergence (kept as a finding, not overwritten)",
    fwdRegH: "The trigger register (changes in law on the public record as of 2026-06-30)",
    fwdRegKind: "Kind", fwdRegDir: "Direction", fwdRegClass: "Class effect", fwdRegCert: "Certainty",
    fwdJurH: "A per-jurisdiction reading, for the supervisor", fwdJurHint: "A supervisor asks not 'what is moving across the whole space' but 'which pending developments change the corridors into and out of my jurisdiction, and which counterparts am I most exposed to.' Same data, re-sorted.",
    fwdJurPick: "Pick a jurisdiction for its forward reading",
    fwdOwnEv: "Own pending events", fwdInb: "Inbound reclassified", fwdOutb: "Outbound reclassified", fwdExp: "Counterpart exposure (by exposure)",
    fwdNoEv: "No pending event of its own.", fwdNoInb: "No inbound edge reclassifies under the pending set.", fwdNoOutb: "No outbound edge reclassifies under the pending set.",
    fwdMoves: "moves class", fwdAccess: "accessibility-only (intra-regime gating)",
    fwdAccessNote: "The distinction that matters: this kind of change alters who may operate and which tokens are admissible, but moves no feasibility class. A class-centric measure registers it as 'nothing': so a low sensitivity position must be read as 'no class flip pending', not 'nothing happening'. The EU's 2026-07-01 MiCA transitional expiry is exactly this kind.",
    fwdVia: "trigger", fwdTiming: "timing",
    structH: "The macro structure: the methodology's proof, and one fracture the static map cannot express",
    structReconH: "Computed-vs-authored reconciliation",
    structReconLead: "The methodology paper's most original element: derive the same downstream conclusion (corridor feasibility) twice: once by hand, once by a small auditable rule engine over a provenance-annotated signal table: then surface every divergence as a finding rather than silently reconciling it in favour of either side. The computed layer ships as a labelled preview, not an authoritative verdict. Below is that reconciliation, live:",
    structAgree: "pairs agree", structPairs: "jurisdiction pairs", structFindings: "divergences (kept as findings)",
    structReconNote: "Both divergences share one cause: the United Kingdom's regime is adopted but not yet operative; one layer treats it as not-yet-bridgeable, the other as cleanly bridgeable. That is exactly the research-valuable signal the engine should expose: overwriting one side would destroy it. The time dimension then separates the part that resolves on the commencement date (2027-10-25) from a genuine, durable modelling difference.",
    structSetlH: "The settlement substrate, split along bloc lines",
    structSetlTier: "evidence grade: tier-2 operational · weaker than the tier1 legal layer of §3",
    structSetlLead: "The wholesale settlement substrate beneath the issuance layer is not a single shared open rail. The public record shows it split along geopolitical bloc lines: open within a bloc, closed across. Getting the true operators of each experiment right is what turns this from a soft analogy into a checkable claim.",
    structSetlCorr: "Correction",
    structBlocAgora: "Agorá rail (dollar-routing)", structBlocMbridge: "mBridge rail (dollar-bypass)",
    structBlocBridge: "Ensemble bridge (Hong Kong)", structBlocNone: "off the shared experiments",
    structEdgeCounts: "66 corridors by bloc relationship",
    structConvH: "Convergence: the yield line",
    structConvLead: "Read across jurisdictions rather than edge by edge, the register surfaces a second macro finding: independent legislative systems are converging on the same functional boundary around stablecoin yield: yield for merely holding is prohibited, activity-linked rewards are permitted. The line is decided by the same functional test (conversion-direction, ownership-disclosure, timing-independence, yield-attribution, audit-trail) across jurisdictions.",
    structConvAnchor: "Anchor (citable depth)", structConvSibling: "Sibling restriction", structConvCounter: "Counter-example",
    structConvDisc: "Discipline: convergence is asserted at citable depth only where the cell is tier1_legal + in_force + resolution_text AND both sides of the line are documented: today, the United States alone. The rest are recorded on the prohibited side, with the two-sided line carried as backlog, not asserted as drawing the same line. This is the register's own citable-purity discipline: what keeps the convergence a finding, not an impression.",
    agH: "Citable for machines: the register's agent surface",
    agLead: "Machine-readable knowledge bases of comparative regulation are increasingly read not by a human who can weigh a caveat but by software: retrieval pipelines, language-model agents, automated compliance tools, that treat whatever a field asserts as fact. The methodology paper's core claim is that whether a record may be cited as current binding law should be a build-decidable property, not a judgment a human re-makes on every read. The same register therefore exposes a typed MCP surface for agents to consume: each tool only filters and reshapes published records; no facts are generated.",
    agToolSurface: (n) => `MCP surface · ${n} typed tools`,
    agGuard: "Guardrails (hold on every call)",
    agSampleH: "Sample call → response shape",
    agSampleTool: "citable_law()",
    agSampleDesc: "Returns only records passing all six decision-ready axes: tier1_legal, in_force, resolution_text, official, current, and reconciled, with source.url + pinpoint.",
    agSampleNote: "The six-axis gate runs at build time and call time, so structural candidates can never be presented as the decision-ready count.",
    agLayerNode: "node + evidence axes", agLayerEvidence: "verification + citable", agLayerConstraint: "constraint substrate",
    agLayerCorridor: "corridor + composition", agLayerTime: "time engine", agLayerComputed: "computed reconciliation", agLayerStakeholder: "stakeholder projection", agLayerAgentic: "evidence search + decision audit",
    agConsume: "who consumes this layer",
    expBtn: "Export briefing (Markdown)", expBtnCorr: "Export corridor analysis (Markdown)", expBtnFwd: "Export forward reading (Markdown)",
    expReady: "Briefing generated and downloaded. Hand it to a licensed lawyer as the handoff.",
    expNote: "Exports as Markdown: provisions + sources + questions to ask + corridors + forward readings: a checklist you can hand to a lawyer. It contains no compliance conclusion.",
    sessH: "Layers this session covered",
    sessNode: (n) => `Node layer: ${n} dimensions`, sessCorr: (n) => `Corridor layer: ${n} pairs`,
    sessFwd: (n) => `Forward layer: ${n} jurisdiction readings`, sessStruct: "Structure layer: reconciliation/settlement/convergence",
    layerBadge: "layer",
    scopeNote: "Coverage: from a business description this maps the node layer (jurisdiction × dimension): relevant dimensions, governing provisions with sources, and the questions to ask; and it surfaces the same register's corridor feasibility, time dimension, computed reconciliation, and agent surface in the views above. Everything is a projection of the register and its computed layer; no facts are added.",
    // 12×12 corridor heat matrix
    mxH: "Full corridor matrix: all 132 directed edges at a glance",
    mxHint: "Rows are origins, columns are destinations; each cell is that directed edge's feasibility class on the selected date. Click any cell to drill into the corridor. Drag the timeline above to watch whole columns reclassify as scheduled commencement dates arrive.",
    mxOrigin: "Origin ↓", mxDest: "Destination →",
    mxFlip: "This cell has reclassified on the selected date",
    mxTodayTag: "today's snapshot",
    // time-travel slider (compose(as_of))
    ttH: "Timeline: compose(as_of)",
    ttHint: "Drag the date past a scheduled commencement and corridor classes recompute from the register's time engine. Scheduled / gazetted flips apply automatically; contingent (undated) triggers do not, and are noted separately.",
    ttAsOf: "As of", ttToday: "today", ttReset: "Back to today",
    ttTodayMark: "today (real date)", ttSnapMark: "data snapshot baseline",
    ttInForce: "in force", ttUpcoming: "not yet",
    ttDateNote: (today, snap, days) => `Today is ${today}; the data snapshot is as of ${snap} (${days} days old). These are two different things: scheduled commencements flip corridor classes on their own once their date arrives (those dates are published facts), while the provisions themselves still reflect the snapshot day. Drag to "data snapshot baseline" to see what the register saw that day.`,
    ttHorizons: "Key horizons", ttScheduled: "scheduled", ttContingent: "contingent (no date)",
    ttDist: "Full-network class distribution", ttChanged: (n) => `${n} edges reclassified vs today`, ttNoChange: "no flips vs today",
    ttGeniusCap: "US GENIUS §18 outer cap", ttUkGazette: "UK regime operative (gazetted)",
    ttPendingH: "Contingent triggers (no gazetted date, do not auto-apply on the timeline)",
    ttPendingNote: "These regimes are enacted / pending but carry no fixed commencement date; their flips are conditional and the timeline does not decide them for you: consistent with the register's scheduled-vs-contingent discipline.",
    // CSV / citation export
    expCsvCorr: "Export corridor matrix (CSV)", expCsvCite: "Export citable records (CSV)", expBib: "Export citation (BibTeX)",
    expCsvCorrNote: "132 directed edges · origin/destination/class/meaning/flip-date: ready for a spreadsheet.",
    expCsvCiteNote: (n) => `${n} citable records · each with its official source URL + pinpoint: a law-firm / Big-Four handoff.`,
    expBibNote: "A BibTeX entry for this register (with DOI), for citing in a paper or memo.",
    expCff: "Export citation file (CITATION.cff)",
    expCffNote: "A standard Citation File Format file (with DOI + ORCID): recognised by GitHub and Zenodo.",
    expDoneCsv: "CSV exported.",
    expDoneBib: "BibTeX exported.",
    expDoneCff: "CITATION.cff exported.",
    expPdf: "Export citable-records PDF",
    expPdfNote: "A PDF summary of decision-ready records (with DOI header): a printable, shareable single file.",
    expDonePdf: "PDF exported.",
    expAsOfCol: "class as of date",
  },
};

// ── Feasibility-class vocabulary (shared by Corridors + Forward) ──────────────
const CLASS_LABEL = {
  zh: { I: "类别 I", II: "类别 II", III: "类别 III", T: "过渡期 T", blocked: "禁止", pre_regime: "前制度" },
  en: { I: "Category I", II: "Category II", III: "Category III", T: "In transition (T)", blocked: "Blocked", pre_regime: "Pre-regime" },
};
const CLASS_MEANING = {
  zh: {
    I: "双向可授权：两端各自可获授权,顺流方向无需等效步骤(最干净)",
    II: "需等效 / 承认 / 通道认定：入境取决于非普遍授予的裁量认定(受限通道)",
    III: "组合问题未决：origin 缺可出口可授权代币,或两制度无法组合(降为合作/协调)",
    T: "目的地制度在途：制度已通过但尚未生效",
    blocked: "目的地存在发行禁止",
    pre_regime: "目的地尚无可授权发行路径",
  },
  en: {
    I: "dual authorization available: each end separately authorizable, no equivalence step in the direction of flow (cleanest)",
    II: "equivalence / recognition / channel determination required: entry turns on a determination not generically granted (channelled)",
    III: "composition problem unresolved: origin lacks an exportable authorizable token, or the regimes interact unresolvably (reduces to partnership / coordination)",
    T: "regime-in-transition at destination: regime adopted but not yet operative",
    blocked: "issuance prohibition at destination",
    pre_regime: "no authorizable issuance pathway yet at destination",
  },
};
// Class -> tone key for the ClassChip
const CLASS_TONE = { I: "open", II: "chan", III: "unre", T: "trans", blocked: "block", pre_regime: "pre" };

function ClassChip({ cls, t, ui, big }) {
  const label = (CLASS_LABEL[ui] || CLASS_LABEL.en)[cls] || cls;
  const tone = CLASS_TONE[cls] || "unre";
  return <span className={"cls-chip cls-" + tone + (big ? " cls-big" : "")}>{label}</span>;
}

// Trigger-kind short label used in the register table + sensitivity
const KIND_LABEL = {
  zh: {
    "fully-scheduled": "全排定", "enacted-not-commenced": "已通过·未生效", "contingent-no-date": "待决·无日期",
    "contingent-not-class-change": "待决·非类别变化", "dated-empty-effect": "有日期·空效应",
    "inbound-recognition": "入境承认", "intra-regime-gating": "制度内 gating", "parameterization": "参数化",
    "resolved-tightening-open-relaxation": "收紧已定·放松待定", "scheduled-with-cap": "排定·带外沿上限",
  },
  en: {
    "fully-scheduled": "fully scheduled", "enacted-not-commenced": "enacted, not commenced", "contingent-no-date": "contingent, no date",
    "contingent-not-class-change": "contingent, not a class change", "dated-empty-effect": "dated, empty effect",
    "inbound-recognition": "inbound recognition", "intra-regime-gating": "intra-regime gating", "parameterization": "parameterization",
    "resolved-tightening-open-relaxation": "tightening resolved, relaxation open", "scheduled-with-cap": "scheduled with outer cap",
  },
};

// Snapshot age (turns the "frozen snapshot" weakness into a demonstration of the
// register's own dated/versioned discipline — the flagship paper argues a forward
// map must be a dated, register-backed living document).
function snapshotAge(as_of) {
  try {
    const d = new Date(as_of + "T00:00:00Z");
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    return days >= 0 ? days : 0;
  } catch (e) { return null; }
}

// Look up a directed corridor edge O->D from the compact COMPUTE.corridors bundle,
// whose keys are unordered "X-Y" pairs while directed classes are keyed "X->Y".
function corridorEdge(o, d) {
  const c = COMPUTE.corridors;
  const entry = c[o + "-" + d] || c[d + "-" + o];
  if (!entry) return null;
  const fwd = entry.d[o + "->" + d] || null;
  const rev = entry.d[d + "->" + o] || null;
  return { entry, fwd, rev };
}

function countCorrPairs(jurs) {
  let n = 0;
  for (const a of jurs) for (const b of jurs) { if (a === b) continue; const e = corridorEdge(a, b); if (e && e.fwd) n++; }
  return n;
}

// ── compose(as_of): the register's time engine, rendered client-side. ──────────
// For a given ISO date (or null = today's snapshot), returns { "O->D": classCode } for
// every directed edge. DATED transitions (entry.t[], carrying dt) apply when dt <= as_of;
// this is exactly the scheduled/gazetted flip set (US GENIUS §18 outer cap 2027-01-18,
// UK SI 2026/102 gazetted 2027-10-25). CONTINGENT transitions (entry.w[], no date) are
// NOT auto-applied — they are reported separately, matching the register's own
// scheduled-vs-contingent discipline. Verified edge-for-edge against COMPUTE at build.
//
// TWO DATES, DELIBERATELY DISTINCT — this is the fix for "the timeline is stuck on 2026-06-30":
//   snapshotDate()  the day the DATA below was verified. Frozen by design; it is what the
//                   citation discipline rests on, and it must never silently become "today".
//   todayISO()      the real wall clock. The dated commencements baked into COMPUTE (US GENIUS
//                   §18 outer cap 2027-01-18, UK SI 2026/102 gazetted 2027-10-25) are KNOWN
//                   facts, so once a real day passes one of them, the corridor classes should
//                   move on their own. Previously asOf==null skipped every dated transition, so
//                   the tool would still have shown the pre-flip world on 2027-10-26.
// snapshotDate() is a function, not a const: the live-register sync mutates DATA.meta.as_of after
// mount, and a module-level const captured at load time could never see it.
function snapshotDate() { return (DATA.meta && DATA.meta.as_of) || "2026-06-30"; }
function todayISO() {
  try {
    const d = new Date();
    // local calendar day, not UTC — a user in HK/CN should not see yesterday's date all morning
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  } catch (e) { return snapshotDate(); }
}
// asOf === null means "now" and now resolves to the real calendar day.
function composeCorridorClasses(asOf) {
  const at = asOf || todayISO();
  const out = {};
  const C = COMPUTE.corridors;
  for (const pk of Object.keys(C)) {
    const entry = C[pk];
    for (const ek of Object.keys(entry.d)) out[ek] = entry.d[ek].c;
    if (Array.isArray(entry.t)) {
      for (const tr of entry.t) if (tr.dt <= at && out[tr.e] === tr.f) out[tr.e] = tr.to;
    }
  }
  return out;
}
// The distinct dated horizons in the corridor layer, ascending — drives the slider ticks.
function datedHorizons() {
  const seen = {};
  for (const pk of Object.keys(COMPUTE.corridors)) {
    const tr = COMPUTE.corridors[pk].t;
    if (Array.isArray(tr)) for (const x of tr) if (x.dt) seen[x.dt] = (seen[x.dt] || new Set());
  }
  // tag each date with a human label from the events it carries
  const labels = {};
  for (const pk of Object.keys(COMPUTE.corridors)) {
    const tr = COMPUTE.corridors[pk].t;
    if (Array.isArray(tr)) for (const x of tr) if (x.dt) labels[x.dt] = x.dk || x.eid || "";
  }
  return Object.keys(seen).sort().map((dt) => ({ dt, kind: labels[dt] }));
}
function classDist(map) { const d = {}; for (const k in map) d[map[k]] = (d[map[k]] || 0) + 1; return d; }
// contingent (undated) triggers, deduped by trigger id — shown beneath the slider
function contingentTriggers() {
  const byTrig = {};
  for (const pk of Object.keys(COMPUTE.corridors)) {
    const w = COMPUTE.corridors[pk].w;
    if (Array.isArray(w)) for (const g of w) { byTrig[g.trig] = (byTrig[g.trig] || 0) + g.mv.length; }
  }
  return Object.keys(byTrig).sort().map((trig) => ({ trig, edges: byTrig[trig] }));
}

// ── CSV / BibTeX exporters (spreadsheet + citation handoffs). ──────────────────
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadBlob(filename, text, mime, noBom) {
  try {
    const blob = new Blob([(noBom ? "" : "\uFEFF") + text], { type: (mime || "text/plain") + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) { return false; }
}
// Every directed edge, with today's class, the class at an optional as_of, and any flip date.
function buildCorridorCsv(ui, asOf) {
  const meaning = CLASS_MEANING[ui] || CLASS_MEANING.en;
  const label = CLASS_LABEL[ui] || CLASS_LABEL.en;
  const today = composeCorridorClasses(null);
  const dated = asOf ? composeCorridorClasses(asOf) : null;
  const head = ["origin", "destination", "class_today", "class_label_today", "meaning_today", "origin_override", "scheduled_flip_date", "flip_to"];
  if (asOf) head.splice(5, 0, "class_as_of_" + asOf);
  const rows = [head.map(csvCell).join(",")];
  const C = COMPUTE.corridors;
  const edges = [];
  for (const pk of Object.keys(C)) {
    const entry = C[pk];
    for (const ek of Object.keys(entry.d)) {
      const [o, d] = ek.split("->");
      const flip = (entry.t || []).find((x) => x.e === ek);
      edges.push({ o, d, cell: entry.d[ek], flip });
    }
  }
  edges.sort((a, b) => (a.o + a.d).localeCompare(b.o + b.d));
  for (const e of edges) {
    const row = [e.o, e.d, today[e.o + "->" + e.d], label[today[e.o + "->" + e.d]] || "", meaning[today[e.o + "->" + e.d]] || "", e.cell.o ? "yes" : "", e.flip ? e.flip.dt : "", e.flip ? e.flip.to : ""];
    if (asOf) row.splice(5, 0, dated[e.o + "->" + e.d]);
    rows.push(row.map(csvCell).join(","));
  }
  return rows.join("\n");
}
// The 46 citable records with their official source + pinpoint — the lawyer-citable subset.
function buildCitableCsv() {
  const head = ["record_id", "jurisdiction", "dimension", "constraint_ref", "authority", "instrument_label_local", "requirement_summary", "source_primary", "pinpoint", "source_url", "claim_class", "evidence_tier", "binding_status"];
  const rows = [head.map(csvCell).join(",")];
  for (const r of DATA.records) {
    if (!r.citable) continue;
    rows.push([r.id, r.jur, r.dimension, r.constraint_ref || "", r.authority || "", r.instrument_label_local || "", r.requirement_summary, r.source_primary || "", r.pinpoint || "", r.url || "", r.claim_class, r.evidence_tier, r.binding_status].map(csvCell).join(","));
  }
  return rows.join("\n");
}
// BibTeX — the format most readers actually paste into a .bib. It previously carried neither a DOI
// nor a URL, so a citation generated from it could not be resolved back to the work. Both are now
// present, anchored to the DOI (stable across repo renames) rather than to a domain.
function buildBibtex() {
  const m = DATA.meta;
  const year = (m.as_of || "2026").slice(0, 4);
  return [
    "@dataset{cbsr_register_v" + (m.version || "").replace(/\./g, "_") + ",",
    "  title        = {" + m.name + "},",
    "  author       = {Fan, Yunjie},",
    "  version      = {" + m.version + "},",
    "  year         = {" + year + "},",
    "  publisher    = {Zenodo},",
    "  doi          = {10.5281/zenodo.20730358},",
    "  url          = {https://doi.org/10.5281/zenodo.20730358},",
    "  note         = {As-of " + (m.as_of || "") + "; " + m.record_count + " records, " + m.citable_count + " citable. Machine-readable register of cross-border stablecoin regulation across a fifteen-dimension framework.},",
    "  howpublished = {Machine-readable register, schema-validated, queryable over MCP}",
    "}",
  ].join("\n");
}
// CITATION.cff — the Citation File Format the register repo publishes at its root, regenerated
// from the embedded snapshot so version / date / counts always match what the tool is showing.
//
// The repo was renamed from `stablecoin-rail-register` to `cross-border-stablecoin-register`. The
// legacy Pages URL (yunjiefanresearch-hub.github.io/stablecoin-rail-register) now returns 404, and
// the legacy GitHub URL survives only on GitHub's rename-redirect. Both were baked in here, so every
// citation file a reader exported carried a dead link. `url` is therefore anchored to the DOI, which
// is the project's own stated citable anchor ("the citable anchor is the DOI, not a domain") and is
// stable across any future rename. The schema `$id` keeps the legacy slug on purpose: a JSON Schema
// $id is an identifier, not a locator, and changing it would break anyone who pinned it.
function buildCitationCff() {
  const m = DATA.meta;
  return [
    "cff-version: 1.2.0",
    "title: \"" + m.name + "\"",
    "message: \"If you use this register, please cite it using the DOI of the version you used.\"",
    "type: dataset",
    "authors:",
    "  - family-names: \"Fan\"",
    "    given-names: \"Yunjie\"",
    "    orcid: \"https://orcid.org/0009-0005-6762-084X\"",
    "repository-code: \"https://github.com/yunjiefanresearch-hub/cross-border-stablecoin-register\"",
    "url: \"https://doi.org/10.5281/zenodo.20730358\"",
    "abstract: \"An open, versioned, machine-readable register of how jurisdictions regulate stablecoins across a fifteen-dimension framework derived from an eight-constraint model, with two doctrinal spines (the permitted-activity / yield boundary and securities classification) and a corridor-level interoperability layer. This citation is for the register snapshot embedded in the dimension-mapper frontend: " + m.record_count + " records, " + m.citable_count + " lawyer-citable, as-of " + (m.as_of || "") + ". Data is licensed CC-BY-4.0.\"",
    "keywords:",
    "  - stablecoin",
    "  - tokenized real-world assets",
    "  - cross-jurisdictional regulation",
    "  - cross-border settlement",
    "  - regulatory data",
    "  - MiCA",
    "  - GENIUS Act",
    "license: CC-BY-4.0",
    "version: \"" + m.version + "\"",
    "date-released: \"2026-07-09\"",
    "doi: \"10.5281/zenodo.20730358\"",
    "identifiers:",
    "  - type: other",
    "    value: \"SSRN author 11463068\"",
    "    description: \"SSRN author ID of the maintainer (companion working papers).\"",
    "",
  ].join("\n");
}

// ── Self-contained PDF export (no external libraries) ──────────────────────────
// Produces a genuine, one-click .pdf summary of the 46 citable records with the
// register's DOI in the header — closing the round-1 "PDF export" item literally.
// Uses PDF's built-in Helvetica (a standard-14 font, no embedding needed), lays
// text out with manual word-wrap + pagination, and assembles a valid xref table
// with byte-accurate offsets. ASCII-only output so it's safe as a text Blob.
function pdfEsc(s) { return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function pdfAscii(s) { return String(s == null ? "" : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2192/g, "->").replace(/[^\x20-\x7E]/g, "?"); }
function pdfWrap(s, max) {
  const words = pdfAscii(s).split(/\s+/); const lines = []; let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; }
    else if ((cur + " " + w).length <= max) { cur += " " + w; }
    else { lines.push(cur); cur = w; }
    while (cur.length > max) { lines.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
function buildCitablePdf() {
  const m = DATA.meta;
  const recs = DATA.records.filter((r) => r.citable);
  // Page geometry (US Letter), margins, and a text cursor.
  const PW = 612, PH = 792, ML = 54, MT = 748, MB = 54, MAXW = 92;
  const pages = []; let cur = []; let y = MT;
  const emit = (text, size, lead, gapBefore) => {
    if (gapBefore && y - gapBefore < MB) { pages.push(cur); cur = []; y = MT; }
    else if (gapBefore) y -= gapBefore;
    for (const ln of pdfWrap(text, size <= 8 ? 108 : MAXW)) {
      if (y < MB) { pages.push(cur); cur = []; y = MT; }
      cur.push({ x: ML, y, size, text: ln });
      y -= lead;
    }
  };
  // Header block.
  emit(pdfAscii(m.name), 15, 20, 0);
  emit("Citable-records summary  ·  version " + m.version + "  ·  as of " + m.as_of, 9, 14, 4);
  emit("DOI: 10.5281/zenodo.20730358   ·   " + recs.length + " citable records (tier-1 legal, resolution-text, in force)", 9, 14, 0);
  emit("Each record below is citable by construction; see CITATION.cff / .bib for machine-readable citation.", 8, 12, 2);
  // One compact block per citable record.
  const jn = DATA.jurisdictions;
  recs.forEach((r, i) => {
    emit((i + 1) + ".  [" + r.jur + " · " + (jn[r.jur] || r.jur) + "]  " + r.dimension + (r.constraint_ref ? "  (" + r.constraint_ref + ")" : ""), 9.5, 13, 10);
    if (r.authority) emit("Authority: " + r.authority, 8, 11, 1);
    if (r.pinpoint) emit("Pinpoint: " + r.pinpoint, 8, 11, 1);
    if (r.source_primary) emit("Source: " + r.source_primary, 8, 11, 1);
    if (r.url) emit("URL: " + r.url, 8, 11, 1);
  });
  pages.push(cur);

  // ---- assemble PDF objects with byte-accurate offsets ----
  const objs = []; // object body strings (without the "N 0 obj" wrapper)
  const NPAGES = pages.length;
  // Fixed objects: 1=catalog, 2=pages, 3=font. Then per page: a page obj and a content obj.
  const pageObjNum = (i) => 4 + i * 2;      // page dictionary object number
  const contentObjNum = (i) => 5 + i * 2;   // content stream object number
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => pageObjNum(i) + " 0 R").join(" ");
  objs[2] = "<< /Type /Pages /Count " + NPAGES + " /Kids [" + kids + "] >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((pg, i) => {
    objs[pageObjNum(i)] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PW + " " + PH + "] " +
      "/Resources << /Font << /F1 3 0 R >> >> /Contents " + contentObjNum(i) + " 0 R >>";
    let stream = "";
    for (const t of pg) {
      stream += "BT /F1 " + t.size + " Tf 1 0 0 1 " + t.x + " " + t.y + " Tm (" + pdfEsc(t.text) + ") Tj ET\n";
    }
    objs[contentObjNum(i)] = "<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream";
  });

  // Serialize with a running byte offset for the xref table.
  const maxObj = 3 + NPAGES * 2;
  let out = "%PDF-1.4\n"; const offsets = [];
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = out.length;
    out += n + " 0 obj\n" + objs[n] + "\nendobj\n";
  }
  const xrefStart = out.length;
  out += "xref\n0 " + (maxObj + 1) + "\n0000000000 65535 f \n";
  for (let n = 1; n <= maxObj; n++) {
    out += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  }
  out += "trailer\n<< /Size " + (maxObj + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF";
  return out;
}
const REG_ROWS = [
  { j: "UK", k: "fully-scheduled", zdir: "入向", edir: "inbound", zcl: "T→I(8 对 caveat→0)", ecl: "T→I (8 caveats→0)", zc: "已排定 · 2027-10-25", ec: "scheduled · 2027-10-25", moves: true },
  { j: "TW", k: "enacted-not-commenced", zdir: "双向(生效时)", edir: "both (on commencement)", zcl: "前制度→live;入向→II(受限)", ecl: "pre-regime→live; inbound→II (channelled)", zc: "2026-06-30 通过;生效待附属立法,未定日", ec: "enacted 2026-06-30; commencement pending, no date", moves: true },
  { j: "US", k: "contingent-no-date", zdir: "中介/路由层", edir: "intermediary / routing", zcl: "生效状态 + §404 叠加生效", ecl: "binding status + §404 overlays operative", zc: "待决 · Calendar No. 423", ec: "contingent · Calendar No. 423", moves: false },
  { j: "KR", k: "contingent-no-date", zdir: "双向", edir: "both", zcl: "前制度→live;出向脱离 III", ecl: "pre-regime→live; out of Cat. III", zc: "待决 · 仍在小组委员会", ec: "contingent · in subcommittee", moves: true },
  { j: "SG", k: "contingent-not-class-change", zdir: "—", edir: "—", zcl: "仅生效状态(不变类别)", ecl: "binding status only (no class change)", zc: "待决 · 预期 2026 年中", ec: "contingent · expected mid-2026", moves: false },
  { j: "JP", k: "dated-empty-effect", zdir: "—", edir: "—", zcl: "无(控制案例)", ecl: "none (control case)", zc: "已生效 2026-06-01", ec: "in force 2026-06-01", moves: false },
  { j: "JP", k: "inbound-recognition", zdir: "入向", edir: "inbound", zcl: "承认通道;类别经 conditioning(II)", ecl: "recognition pathway; class by conditioning (II)", zc: "已生效 2026-06-01", ec: "in force 2026-06-01", moves: false },
  { j: "EU", k: "parameterization", zdir: "—", edir: "—", zcl: "锐化既有类别(不移动)", ecl: "sharpens existing class", zc: "开放问题 · 无生效日", ec: "open question · no commencement", moves: false },
  { j: "EU", k: "intra-regime-gating", zdir: "入向(制度内可及性)", edir: "inbound (accessibility)", zcl: "不变类别;关闭国家侧门,仅护照", ecl: "no class change; national side-doors close, passport-only", zc: "外限 2026-07-01;各国窗口交错,多数更早", ec: "outer cap 2026-07-01; staggered, most earlier", moves: false },
  { j: "HK", k: "administration", zdir: "入向(喂给 CN 边界)", edir: "inbound (feeds CN boundary)", zcl: "信息,非规则变化", ecl: "information, not a rule change", zc: "开放问题 · 未公布", ec: "open question · not announced", moves: false },
  { j: "CN", k: "resolved-tightening-open-relaxation", zdir: "双向(typology 可行性)", edir: "both (typology viability)", zcl: "收紧已定;放松待定", ecl: "tightening resolved; relaxation open", zc: "混合 · 42号已生效", ec: "mixed · 42号 in force", moves: false },
];

function ClassLegend({ t, ui }) {
  const order = ["I", "II", "III", "T", "blocked", "pre_regime"];
  return (
    <div className="clslegend">
      <div className="clslegend-h">{t.clsLegendT}</div>
      <div className="clslegend-grid">
        {order.map((c) => (
          <div key={c} className="clslegend-row">
            <ClassChip cls={c} t={t} ui={ui} />
            <span className="clslegend-m">{(CLASS_MEANING[ui] || CLASS_MEANING.en)[c]}</span>
          </div>
        ))}
      </div>
      <div className="clslegend-hint">{t.clsLegendHint}</div>
    </div>
  );
}

function blocRel(o, d, t) {
  const b = COMPUTE.settlement.bloc;
  const bo = b[o], bd = b[d];
  if (bo === "bridge" || bd === "bridge") return { txt: t.corrBlocBridge, tone: "trans" };
  if (bo === "none" || bd === "none") return { txt: t.corrBlocOff, tone: "unre" };
  if (bo === bd) {
    const name = bo === "agora" ? "Agorá" : "mBridge";
    return { txt: t.corrBlocSame(name), tone: bo === "agora" ? "open" : "chan" };
  }
  return { txt: t.corrBlocCross, tone: "block" };
}

function CorridorExplorer({ t, ui, o, d, setO, setD, worked, asOf, setAsOf }) {
  const jurList = Object.keys(DATA.jurisdictions);
  const same = o === d;
  const res = same ? null : corridorEdge(o, d);
  const fwd = res && res.fwd;
  const rev = res && res.rev;
  // Date-aware class for the drilled corridor: reflect the selected as_of, not just today.
  const composed = composeCorridorClasses(asOf);
  const fwdCls = fwd ? (composed[o + "->" + d] || fwd.c) : null;
  const revCls = rev ? (composed[d + "->" + o] || rev.c) : null;
  const fwdShifted = fwd && fwdCls !== fwd.c;
  const asym = fwd && rev && fwdCls !== revCls;
  const trans = res && res.entry.t ? res.entry.t.filter((x) => x.e === o + "->" + d) : [];
  const whatif = res && res.entry.w ? res.entry.w : [];
  const bloc = same ? null : blocRel(o, d, t);
  const examples = [
    { o: "US", d: "UK", tag: t.corrExDated },
    { o: "KR", d: "US", tag: t.corrExPre },
    { o: "CN", d: "US", tag: t.corrExBlocked },
  ];

  return (
    <div className="view">
      <h2 className="view-h">{t.corrH}</h2>
      <p className="view-lead">{t.corrLead}</p>

      <TimeTravel t={t} ui={ui} asOf={asOf} setAsOf={setAsOf} />
      <CorridorMatrix t={t} ui={ui} asOf={asOf} onPick={(a, b) => { setO(a); setD(b); }} />

      <div className="corr-pick">
        <div className="corr-pick-col">
          <label className="field-label">{t.corrPickO}</label>
          <div className="corr-jur-grid">
            {jurList.map((j) => (
              <button key={j} className={"corr-jbtn" + (o === j ? " on" : "")} onClick={() => setO(j)}>{j}</button>
            ))}
          </div>
        </div>
        <div className="corr-arrow">→</div>
        <div className="corr-pick-col">
          <label className="field-label">{t.corrPickD}</label>
          <div className="corr-jur-grid">
            {jurList.map((j) => (
              <button key={j} className={"corr-jbtn" + (d === j ? " on" : "")} onClick={() => setD(j)}>{j}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="corr-ex">
        <span className="corr-ex-label">{t.corrExample}</span>
        {examples.map((ex) => (
          <button key={ex.o + ex.d} className="corr-ex-chip" onClick={() => { setO(ex.o); setD(ex.d); }}>
            {ex.o}→{ex.d}<span className="corr-ex-tag">{ex.tag}</span>
          </button>
        ))}
      </div>

      {same ? (
        <div className="corr-empty">{t.corrSame}</div>
      ) : fwd ? (
        <div className="corr-result">
          <div className="corr-main">
            <div className="corr-dir-head">
              <span className="corr-dir-pair">{o} → {d}</span>
              <ClassChip cls={fwdCls} t={t} ui={ui} big />
              {fwdShifted && <span className="corr-shifted">{ui === "zh" ? `↻ ${asOf} 已翻类（今日 ` : `↻ reclassified at ${asOf} (today `}<ClassChip cls={fwd.c} t={t} ui={ui} />{ui === "zh" ? "）" : ")"}</span>}
            </div>
            <div className="corr-mean">{(CLASS_MEANING[ui] || CLASS_MEANING.en)[fwdCls]}</div>
            {fwd.o && <div className="corr-ovr">⚑ {t.corrOverride}</div>}
          </div>

          <CorridorWhy o={o} d={d} t={t} ui={ui} />

          <div className="corr-side">
            <div className="corr-side-row">
              <span className="corr-side-k">{t.corrReverse} ({d} → {o})</span>
              <ClassChip cls={revCls} t={t} ui={ui} />
              {asym && <span className="corr-asym">{t.corrAsym}</span>}
            </div>
            <div className="corr-side-row">
              <span className="corr-side-k">{t.corrUndir}</span>
              <span className="corr-undir-v">{res.entry.u}</span>
            </div>
            {bloc && (
              <div className="corr-side-row">
                <span className="corr-side-k">{t.corrBloc}</span>
                <span className={"bloc-chip bloc-" + bloc.tone}>{bloc.txt}</span>
              </div>
            )}
          </div>

          <div className="corr-time">
            <div className="corr-time-h">{t.corrTransH}</div>
            {trans.length ? trans.map((x, i) => (
              <div key={i} className="corr-trans"><span className="corr-trans-dt">{x.dt}</span>
                <ClassChip cls={x.f} t={t} ui={ui} /><span className="corr-trans-arr">→</span><ClassChip cls={x.to} t={t} ui={ui} /></div>
            )) : <div className="corr-none">{t.corrTransNone}</div>}
          </div>

          <div className="corr-time">
            <div className="corr-time-h">{t.corrWhatifH}</div>
            {whatif.length ? whatif.map((w, i) => (
              <div key={i} className="corr-wi">
                <span className="corr-wi-trig">{w.trig}</span>
                {w.mv.filter((m) => m.e === o + "->" + d || m.e === d + "->" + o).map((m, k) => (
                  <span key={k} className="corr-wi-mv">{m.e}: <ClassChip cls={m.f} t={t} ui={ui} />→<ClassChip cls={m.to} t={t} ui={ui} /></span>
                ))}
              </div>
            )) : <div className="corr-none">{t.corrWhatifNone}</div>}
          </div>
        </div>
      ) : null}

      <ClassLegend t={t} ui={ui} />

      {worked && (
        <div className="corr-worked">
          <div className="corr-worked-h">{t.corrWorkedH}</div>
          <div className="corr-worked-hint">{t.corrWorkedHint}</div>
          <CorridorPanel corr={worked} t={t} />
        </div>
      )}

      <ExportBar t={t} ui={ui} asOf={asOf} kinds={["corr", "cite", "bib", "cff", "pdf"]} />
    </div>
  );
}

// ── Reusable export bar (CSV / BibTeX). Renders only the requested kinds. ──────
function ExportBar({ t, ui, asOf, kinds }) {
  const [done, setDone] = useState("");
  const items = [];
  if (kinds.includes("corr")) items.push({ k: "corr", label: t.expCsvCorr, note: t.expCsvCorrNote, done: t.expDoneCsv, run: () => downloadBlob("cbsr-corridor-matrix" + (asOf ? "-" + asOf : "") + ".csv", buildCorridorCsv(ui, asOf), "text/csv") });
  if (kinds.includes("cite")) items.push({ k: "cite", label: t.expCsvCite, note: t.expCsvCiteNote(DATA.meta.citable_count), done: t.expDoneCsv, run: () => downloadBlob("cbsr-citable-records.csv", buildCitableCsv(), "text/csv") });
  if (kinds.includes("bib")) items.push({ k: "bib", label: t.expBib, note: t.expBibNote, done: t.expDoneBib, run: () => downloadBlob("cbsr-" + (DATA.meta.version || "") + ".bib", buildBibtex(), "application/x-bibtex") });
  if (kinds.includes("cff")) items.push({ k: "cff", label: t.expCff, note: t.expCffNote, done: t.expDoneCff, run: () => downloadBlob("CITATION.cff", buildCitationCff(), "application/x-yaml", true) });
  if (kinds.includes("pdf")) items.push({ k: "pdf", label: t.expPdf, note: t.expPdfNote, done: t.expDonePdf, run: () => downloadBlob("cbsr-citable-records-" + (DATA.meta.version || "") + ".pdf", buildCitablePdf(), "application/pdf", true) });
  return (
    <div className="xbar">
      <div className="xbar-grid">
        {items.map((it) => (
          <div key={it.k} className="xbar-item">
            <button className="xbar-btn" onClick={() => { const ok = it.run(); setDone(ok ? it.k : ""); }}>{it.label}</button>
            <div className="xbar-note">{done === it.k ? it.done : it.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Time-travel control: a draggable date over the register's dated horizons. ──
// The slider snaps to the discrete horizons (today → each scheduled flip → +1y),
// recomputes the whole corridor layer at that date, and reports how many edges moved.
function TimeTravel({ t, ui, asOf, setAsOf }) {
  const horizons = datedHorizons();                 // ascending dated flips
  const realToday = todayISO();
  const snap = snapshotDate();
  // Stops are built from real dates and sorted, so a commencement that has ALREADY arrived sits to
  // the LEFT of "today" and is marked as in force. The snapshot day stays reachable as an explicit
  // baseline whenever it is not today — that is how you see what the data actually saw.
  const marks = [];
  const push = (dt, kind, label) => {
    const at = marks.findIndex((m) => m.dt === dt);
    if (at >= 0) { if (kind === "today") marks[at] = { dt, kind, label }; return; }
    marks.push({ dt, kind, label });
  };
  if (snap !== realToday) push(snap, "snapshot", t.ttSnapMark);
  for (const h of horizons) push(h.dt, "horizon", h.dt === "2027-01-18" ? t.ttGeniusCap : h.dt === "2027-10-25" ? t.ttUkGazette : (h.kind || ""));
  push(realToday, "today", t.ttTodayMark);
  marks.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0));
  const todayIdx = Math.max(0, marks.findIndex((m) => m.kind === "today"));
  const sel = asOf == null ? realToday : asOf;
  const foundIdx = marks.findIndex((m) => m.dt === sel);
  const idx = foundIdx >= 0 ? foundIdx : todayIdx;
  const today = composeCorridorClasses(null);
  const now = composeCorridorClasses(asOf);
  let changed = 0;
  for (const k in today) if (today[k] !== now[k]) changed++;
  const dist = classDist(now);
  const order = ["I", "II", "III", "T", "blocked", "pre_regime"];
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  const pending = contingentTriggers();
  const pick = (m) => setAsOf(m.kind === "today" ? null : m.dt);
  const rawAge = snapshotAge(snap);
  const ageDays = rawAge == null ? 0 : rawAge;
  return (
    <div className="tt">
      <div className="tt-h">{t.ttH}</div>
      <div className="tt-hint">{t.ttHint}</div>
      <div className="tt-row">
        <span className="tt-asof-k">{t.ttAsOf}</span>
        <span className="tt-asof-v">{asOf == null ? `${t.ttToday} · ${realToday}` : asOf}</span>
        {asOf != null && <button className="tt-reset" onClick={() => setAsOf(null)}>{t.ttReset}</button>}
      </div>
      <div className="tt-dates">{t.ttDateNote(realToday, snap, ageDays)}</div>
      <input
        className="tt-slider" type="range" min={0} max={marks.length - 1} step={1} value={idx}
        onChange={(e) => pick(marks[+e.target.value])}
        aria-label={t.ttAsOf}
      />
      <div className="tt-ticks">
        {marks.map((m, i) => (
          <button key={m.dt} className={"tt-tick" + (i === idx ? " on" : "") + (m.kind === "today" ? " tt-tick-today" : "") + (m.kind === "horizon" && m.dt <= realToday ? " tt-tick-past" : "")} onClick={() => pick(m)}>
            <span className="tt-tick-dt">{m.dt}</span>
            <span className="tt-tick-lbl">{m.label || m.dt}</span>
            {m.kind === "horizon" && <span className="tt-tick-state">{m.dt <= realToday ? t.ttInForce : t.ttUpcoming}</span>}
          </button>
        ))}
      </div>
      <div className="tt-dist">
        <div className="tt-dist-h">{t.ttDist}
          <span className={"tt-dist-changed" + (changed ? "" : " zero")}>{changed ? t.ttChanged(changed) : t.ttNoChange}</span>
        </div>
        <div className="tt-bar">
          {order.map((c) => dist[c] ? (
            <div key={c} className={"tt-seg tt-seg-" + (CLASS_TONE[c] || "open")} style={{ width: (dist[c] / total * 100) + "%" }} title={((CLASS_LABEL[ui] || CLASS_LABEL.en)[c] || c) + ": " + dist[c]}>
              <span className="tt-seg-n">{dist[c]}</span>
            </div>
          ) : null)}
        </div>
        <div className="tt-legend">
          {order.map((c) => dist[c] ? (
            <span key={c} className="tt-legend-i"><i className={"tt-dot tt-seg-" + (CLASS_TONE[c] || "open")} />{(CLASS_LABEL[ui] || CLASS_LABEL.en)[c]} <b>{dist[c]}</b></span>
          ) : null)}
        </div>
      </div>
      {pending.length > 0 && (
        <div className="tt-pending">
          <div className="tt-pending-h">{t.ttPendingH}</div>
          <div className="tt-pending-row">
            {pending.map((p) => <span key={p.trig} className="tt-pending-chip">{p.trig}<b>{p.edges}</b></span>)}
          </div>
          <div className="tt-pending-note">{t.ttPendingNote}</div>
        </div>
      )}
    </div>
  );
}

// ── 12×12 corridor heat matrix: all 132 directed edges as one clickable grid. ──
// Rows = origin, cols = destination; cell color = feasibility class at `asOf`.
// A cell that has changed vs today's snapshot gets a flip marker. Clicking a cell
// selects that corridor and jumps to the Corridors view.
function CorridorMatrix({ t, ui, asOf, onPick }) {
  const jurs = Object.keys(DATA.jurisdictions);
  const now = composeCorridorClasses(asOf);
  const today = composeCorridorClasses(null);
  return (
    <div className="mx">
      <div className="mx-h">{t.mxH}</div>
      <div className="mx-hint">{t.mxHint}</div>
      <div className="mx-scroll">
        <table className="mx-tbl">
          <thead>
            <tr>
              <th className="mx-corner"><span className="mx-corner-o">{t.mxOrigin}</span><span className="mx-corner-d">{t.mxDest}</span></th>
              {jurs.map((d) => <th key={d} className="mx-colh">{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {jurs.map((o) => (
              <tr key={o}>
                <th className="mx-rowh">{o}</th>
                {jurs.map((d) => {
                  if (o === d) return <td key={d} className="mx-diag" aria-hidden="true" />;
                  const ek = o + "->" + d;
                  const cls = now[ek];
                  if (!cls) return <td key={d} className="mx-na" title={o + "→" + d + ": —"}>·</td>;
                  const flipped = today[ek] !== cls;
                  const meaning = (CLASS_MEANING[ui] || CLASS_MEANING.en)[cls] || cls;
                  return (
                    <td key={d}
                      className={"mx-cell mx-" + (CLASS_TONE[cls] || "open") + (flipped ? " mx-flip" : "")}
                      title={o + "→" + d + ": " + ((CLASS_LABEL[ui] || CLASS_LABEL.en)[cls] || cls) + ": " + meaning + (flipped ? " · " + t.mxFlip : "")}
                      onClick={() => onPick(o, d)}
                      role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(o, d); } }}
                    >
                      <span className="mx-code">{(CLASS_LABEL[ui] || CLASS_LABEL.en)[cls] || cls}</span>
                      {flipped && <span className="mx-flip-dot" aria-hidden="true">◆</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mx-foot">
        {["I", "II", "III", "T", "blocked", "pre_regime"].map((c) => (
          <span key={c} className="mx-foot-i"><i className={"mx-dot mx-" + (CLASS_TONE[c] || "open")} />{(CLASS_LABEL[ui] || CLASS_LABEL.en)[c]}</span>
        ))}
        <span className="mx-foot-i"><span className="mx-flip-dot">◆</span>{ui === "zh" ? "较今日已翻类" : "reclassified vs today"}</span>
      </div>
    </div>
  );
}

function ForwardView({ t, ui, fj, setFj, asOf, setAsOf }) {
  const S = COMPUTE.sensitivity;
  const jurList = Object.keys(DATA.jurisdictions);
  const F = fj ? COMPUTE.forward[fj] : null;

  return (
    <div className="view">
      <h2 className="view-h">{t.fwdH}</h2>
      <p className="view-lead">{t.fwdLead}</p>

      <TimeTravel t={t} ui={ui} asOf={asOf} setAsOf={setAsOf} />

      {/* Sensitivity ordering */}
      <div className="fwd-sec">
        <div className="fwd-sec-h">{t.fwdSensH}</div>
        <div className="fwd-sec-hint">{t.fwdSensHint}</div>
        <div className="sens-finding">{S.finding}</div>
        {S.two_orderings && (
          <div className="sens-two">
            <div className="sens-two-h">{t.fwdTwoH}</div>
            <div className="sens-two-row"><span className="sens-two-k">{t.fwdTwoByEdges}</span><span className="sens-two-v">{S.two_orderings.by_edge_count}</span></div>
            <div className="sens-two-row"><span className="sens-two-k">{t.fwdTwoByDate}</span><span className="sens-two-v">{S.two_orderings.by_dated_horizon}</span></div>
            <div className="sens-two-note">{S.two_orderings.note}</div>
          </div>
        )}
        <div className="sens-grid">
          {S.ordering.map((r) => (
            <div key={r.jurisdiction} className="sens-card">
              <div className="sens-top">
                <span className="sens-rank">#{r.rank}</span>
                <span className="sens-jur">{r.jurisdiction}</span>
                <span className="sens-jurname">{DATA.jurisdictions[r.jurisdiction]}</span>
                {r.both_directions && <span className="sens-both">{t.fwdBoth}</span>}
              </div>
              <div className="sens-edges"><b>{r.edges_reclassified}</b> {t.fwdEdges}
                <span className="sens-fan">{t.fwdFanIn} {r.fan_in} · {t.fwdFanOut} {r.fan_out}</span></div>
              <div className="sens-res">{t.fwdResolves}: <b>{r.resolves_to}</b> · {(KIND_LABEL[ui] || KIND_LABEL.en)[r.trigger_kind] || r.trigger_kind}</div>
              <div className="sens-note">{r.note}</div>
            </div>
          ))}
        </div>
        <div className="sens-insens">
          {S.insensitive.map((r) => (
            <div key={r.jurisdiction} className="sens-in">
              <span className="sens-in-jur">{r.jurisdiction}</span>
              <span className="sens-in-lbl">{t.fwdInsens}</span>
              <span className="sens-in-note">{r.note}</span>
            </div>
          ))}
        </div>
        <div className="fwd-disagree"><span className="fwd-disagree-lbl">{t.fwdDisagreeH}</span>{S.disagreement.observation} {S.disagreement.resolution}</div>
      </div>

      {/* Trigger register table */}
      <div className="fwd-sec">
        <div className="fwd-sec-h">{t.fwdRegH}</div>
        <div className="regtable-wrap">
          <table className="regtable">
            <thead><tr>
              <th></th><th>{t.fwdRegKind}</th><th>{t.fwdRegDir}</th><th>{t.fwdRegClass}</th><th>{t.fwdRegCert}</th>
            </tr></thead>
            <tbody>
              {REG_ROWS.map((r, i) => (
                <tr key={i} className={r.moves ? "reg-moves" : ""}>
                  <td className="reg-j"><span className="jbadge">{r.j}</span></td>
                  <td className="reg-k">{(KIND_LABEL[ui] || KIND_LABEL.en)[r.k] || r.k}</td>
                  <td>{ui === "zh" ? r.zdir : r.edir}</td>
                  <td className={r.moves ? "reg-cls-move" : ""}>{ui === "zh" ? r.zcl : r.ecl}</td>
                  <td className="reg-cert">{ui === "zh" ? r.zc : r.ec}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-jurisdiction reading */}
      <div className="fwd-sec">
        <div className="fwd-sec-h">{t.fwdJurH}</div>
        <div className="fwd-sec-hint">{t.fwdJurHint}</div>
        <div className="fwd-jur-pick">
          <span className="fwd-jur-pick-l">{t.fwdJurPick}</span>
          <div className="fwd-jur-grid">
            {jurList.map((j) => (
              <button key={j} className={"corr-jbtn" + (fj === j ? " on" : "")} onClick={() => setFj(j)}>{j}</button>
            ))}
          </div>
        </div>
        {F && (
          <div className="fwd-jur-read">
            <div className="fwd-jur-events">
              <div className="fwd-jr-h">{t.fwdOwnEv}</div>
              {F.events.length ? F.events.map((e, i) => (
                <div key={i} className={"fwd-ev" + (e.accessibility_only ? " fwd-ev-access" : e.moves_class ? " fwd-ev-move" : "")}>
                  <div className="fwd-ev-top">
                    <span className={"fwd-ev-tag " + (e.moves_class ? "tag-move" : e.accessibility_only ? "tag-access" : "tag-none")}>
                      {e.moves_class ? t.fwdMoves : e.accessibility_only ? t.fwdAccess : (KIND_LABEL[ui] || KIND_LABEL.en)[e.trigger_kind] || e.trigger_kind}</span>
                    {e.effective_date && <span className="fwd-ev-date">{e.effective_date}</span>}
                  </div>
                  <div className="fwd-ev-title">{e.title}</div>
                  {e.accessibility_only && <div className="fwd-ev-accnote">{t.fwdAccessNote}</div>}
                </div>
              )) : <div className="corr-none">{t.fwdNoEv}</div>}
            </div>

            <div className="fwd-jr-cols">
              <div className="fwd-jr-col">
                <div className="fwd-jr-h">{t.fwdInb}</div>
                {F.inbound.length ? F.inbound.map((x, i) => (
                  <div key={i} className="fwd-edge"><span className="fwd-edge-cp">{x.counterpart} → {fj}</span>
                    <ClassChip cls={x.from} t={t} ui={ui} /><span className="fwd-edge-arr">→</span><ClassChip cls={x.to} t={t} ui={ui} />
                    <span className="fwd-edge-via">{x.timing}</span></div>
                )) : <div className="corr-none">{t.fwdNoInb}</div>}
              </div>
              <div className="fwd-jr-col">
                <div className="fwd-jr-h">{t.fwdOutb}</div>
                {F.outbound.length ? F.outbound.map((x, i) => (
                  <div key={i} className="fwd-edge"><span className="fwd-edge-cp">{fj} → {x.counterpart}</span>
                    <ClassChip cls={x.from} t={t} ui={ui} /><span className="fwd-edge-arr">→</span><ClassChip cls={x.to} t={t} ui={ui} />
                    <span className="fwd-edge-via">{x.timing}</span></div>
                )) : <div className="corr-none">{t.fwdNoOutb}</div>}
              </div>
            </div>

            {F.exposure && F.exposure.length > 0 && (
              <div className="fwd-exp">
                <div className="fwd-jr-h">{t.fwdExp}</div>
                <div className="fwd-exp-chips">
                  {F.exposure.map((x, i) => (
                    <span key={i} className="fwd-exp-chip">{x.counterpart}<b>{x.edges_affected}</b></span>
                  ))}
                </div>
              </div>
            )}
            <div className="fwd-supervisor">{F.reading}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function StructureView({ t, ui }) {
  const R = COMPUTE.reconciliation;
  const findings = R.pairs.filter((p) => !p.agree);
  const setl = COMPUTE.settlement;
  const conv = COMPUTE.convergence;
  const blocGroups = [
    { key: "agora", label: t.structBlocAgora, tone: "open" },
    { key: "mbridge", label: t.structBlocMbridge, tone: "chan" },
    { key: "bridge", label: t.structBlocBridge, tone: "trans" },
    { key: "none", label: t.structBlocNone, tone: "unre" },
  ];
  const membersOf = (k) => Object.keys(setl.bloc).filter((j) => setl.bloc[j] === k);

  return (
    <div className="view">
      <h2 className="view-h">{t.structH}</h2>

      {/* Reconciliation: proves the methodology paper's central claim */}
      <div className="struct-sec">
        <div className="struct-sec-h">{t.structReconH}</div>
        <div className="struct-lead">{t.structReconLead}</div>
        <div className="recon-stat">
          <div className="recon-big"><b>{R.agreement}</b><span>{t.structAgree}</span></div>
          <div className="recon-big recon-find"><b>{findings.length}</b><span>{t.structFindings}</span></div>
        </div>
        <div className="recon-findings">
          {findings.map((p, i) => (
            <div key={i} className="recon-f">
              <span className="recon-f-pair">{p.pair}</span>
              <span className="recon-f-cmp">computed <b>{p.computed_category}</b> · authored <b>{p.authored_category}</b></span>
              <span className="recon-f-cause">{p.finding}</span>
            </div>
          ))}
        </div>
        <div className="struct-note">{t.structReconNote}</div>
      </div>

      {/* Settlement substrate bloc split */}
      <div className="struct-sec">
        <div className="struct-sec-h">{t.structSetlH}<span className="tier2-badge">{t.structSetlTier}</span></div>
        <div className="struct-lead">{t.structSetlLead}</div>
        <div className="setl-blocs">
          {blocGroups.map((g) => (
            <div key={g.key} className={"setl-bloc setl-" + g.tone}>
              <div className="setl-bloc-h">{g.label}</div>
              <div className="setl-bloc-members">
                {membersOf(g.key).map((j) => (
                  <span key={j} className="setl-member">{j}<span className="setl-member-n">{DATA.jurisdictions[j]}</span></span>
                ))}
              </div>
              {setl.experiments[g.key === "agora" ? "agora" : g.key === "mbridge" ? "mbridge" : null] && (
                <div className="setl-exp">{setl.experiments[g.key].name}: {setl.experiments[g.key].settlement_currency_orientation}</div>
              )}
            </div>
          ))}
        </div>
        <div className="setl-counts">
          <span className="setl-counts-l">{t.structEdgeCounts}</span>
          {Object.entries(setl.counts).map(([k, v]) => (
            <span key={k} className="setl-count"><b>{v}</b> {k}</span>
          ))}
        </div>
        <div className="setl-corr"><span className="setl-corr-l">{t.structSetlCorr}</span>{setl.correction}</div>
        <div className="setl-finding">{setl.finding}</div>
      </div>

      {/* Yield-line convergence */}
      <div className="struct-sec">
        <div className="struct-sec-h">{t.structConvH}</div>
        <div className="struct-lead">{t.structConvLead}</div>
        <div className="conv-cells">
          <div className="conv-cell conv-anchor">
            <div className="conv-cell-h">{t.structConvAnchor}</div>
            <div className="conv-cell-j">{conv.anchor.jurisdiction} · {conv.anchor.instrument}</div>
            <div className="conv-cell-axes"><Chip tone="verify">{conv.anchor.claim_class}</Chip><Chip tone="verify">{conv.anchor.evidence_tier}</Chip><Chip tone="verify">{conv.anchor.binding_status}</Chip></div>
          </div>
          {conv.sibling && (
            <div className="conv-cell">
              <div className="conv-cell-h">{t.structConvSibling}</div>
              <div className="conv-cell-j">{conv.sibling.jurisdiction || "SG"}</div>
              <div className="conv-cell-txt">{conv.sibling.note || conv.sibling.restriction || ""}</div>
            </div>
          )}
          {conv.counter_example && (
            <div className="conv-cell conv-counter">
              <div className="conv-cell-h">{t.structConvCounter}</div>
              <div className="conv-cell-j">{conv.counter_example.jurisdiction || "CH"}</div>
              <div className="conv-cell-txt">{conv.counter_example.note || conv.counter_example.reason || ""}</div>
            </div>
          )}
        </div>
        <div className="struct-note">{t.structConvDisc}</div>
      </div>
    </div>
  );
}

function AgentsView({ t, ui }) {
  const layerMeta = [
    { key: "node", label: t.agLayerNode, who: ui === "zh" ? "RegTech / 合规 SaaS · AI agent" : "RegTech / compliance SaaS · AI agents" },
    { key: "evidence", label: t.agLayerEvidence, who: ui === "zh" ? "律所 / 四大 · 监管者" : "law firms / Big Four · supervisors" },
    { key: "constraint", label: t.agLayerConstraint, who: ui === "zh" ? "架构师 · 发行方法务" : "architects · issuer legal" },
    { key: "corridor", label: t.agLayerCorridor, who: ui === "zh" ? "发行方 / 支付公司" : "issuers / payment firms" },
    { key: "time", label: t.agLayerTime, who: ui === "zh" ? "司库 · 监管前瞻" : "treasury · regulatory foresight" },
    { key: "computed", label: t.agLayerComputed, who: ui === "zh" ? "研究 · 审计" : "research · audit" },
    { key: "stakeholder", label: t.agLayerStakeholder, who: ui === "zh" ? "各角色视角" : "per-persona lenses" },
    { key: "agentic", label: t.agLayerAgentic, who: ui === "zh" ? "合规 agent · 二审者" : "compliance agents · second reviewers" },
  ];
  return (
    <div className="view">
      <h2 className="view-h">{t.agH}</h2>
      <p className="view-lead">{t.agLead}</p>

      <div className="ag-sample">
        <div className="ag-sample-h">{t.agSampleH}</div>
        <div className="ag-call">
          <code className="ag-call-code">{t.agSampleTool}</code>
          <span className="ag-call-arrow">→</span>
          <span className="ag-call-ret">{DATA.meta.decision_ready_count} records · tier1_legal · in_force · resolution_text · official · current · reconciled</span>
        </div>
        <div className="ag-sample-desc">{t.agSampleDesc}</div>
        <div className="ag-sample-note">{t.agSampleNote}</div>
      </div>

      <McpRunner t={t} ui={ui} />

      <div className="ag-surface-h">{t.agToolSurface(MCP.count)}</div>
      <div className="ag-layers">
        {layerMeta.map((lm) => {
          const tools = MCP.layers[lm.key] || [];
          if (!tools.length) return null;
          return (
            <div key={lm.key} className="ag-layer">
              <div className="ag-layer-head">
                <span className="ag-layer-name">{lm.label}</span>
                <span className="ag-layer-count">{tools.length}</span>
                <span className="ag-layer-who"><span className="ag-who-l">{t.agConsume}:</span> {lm.who}</span>
              </div>
              <div className="ag-tools">
                {tools.map((tool) => (
                  <div key={tool.n} className="ag-tool">
                    <code className="ag-tool-n">{tool.n}</code>
                    <span className="ag-tool-s">{tool.s}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="ag-guard">
        <div className="ag-guard-h">{t.agGuard}</div>
        <ul className="ag-guard-list">
          {MCP.guardrails.map((g, i) => <li key={i}>{g}</li>)}
        </ul>
      </div>
    </div>
  );
}

// ── Export: assemble the whole session into a lawyer-ready Markdown briefing.
// A pure in-memory Blob download — no storage API, works in the sandbox. This is
// the natural shareable unit and the handoff to a licensed lawyer.
function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) { return false; }
}

function axesLine(rec, t) {
  const claim = rec.claim_class === "tier1_legal" ? t.axLegal : t.axOp;
  return `${t.axClaim}: ${claim} · ${t.axProv}: ${provLabel(rec.evidence_tier, t)} · ${t.axBind}: ${bindLabel(rec.binding_status, t)}`;
}

function buildBriefingMd(result, framed, audience, jurs, ui, t) {
  const L = [];
  const age = snapshotAge(DATA.meta.as_of);
  L.push(`# ${t.title}: ${ui === "zh" ? "研究简报" : "research briefing"}`);
  L.push("");
  L.push(`> ${DATA.meta.name} v${DATA.meta.version} · ${t.snapAge(DATA.meta.as_of, age)} · ${DATA.meta.record_count} records · ${DATA.meta.citable_count} ${t.citableWord}`);
  L.push(`>`);
  L.push(`> ${t.snapDisc}`);
  L.push("");
  if (result.restatement) {
    L.push(`## ${t.restateL}`);
    L.push(result.restatement);
    L.push("");
  }
  L.push(`**${t.f2.replace(/^\d+\s*·\s*/, "")}:** ${jurs.map((j) => `${j} (${DATA.jurisdictions[j]})`).join(" · ")}`);
  L.push(`**${t.f3.replace(/^\d+\s*·\s*/, "")}:** ${audience === "regulator" ? t.audRT : t.audPT}`);
  L.push("");

  const emit = (dims, heading) => {
    if (!dims.length) return;
    L.push(`## ${heading}`);
    for (const d of dims) {
      const cref = d.jurs.map((x) => x.rec && x.rec.constraint_ref).find(Boolean) || CONSTRAINT[d.key] || "";
      L.push(`### ${DATA.dimensions[d.key] || d.key}${cref ? " · " + cref : ""}${SPINES.has(d.key) ? " · SPINE" : ""}`);
      if (d.reason) L.push(`_${t.why}${d.reason}_`);
      L.push("");
      for (const x of d.jurs) {
        if (x.rec) {
          const r = x.rec;
          L.push(`- **${x.jur}**: ${r.requirement_summary}${r.citable ? "  ✓ " + t.citableWord : ""}`);
          L.push(`  - ${axesLine(r, t)}`);
          L.push(`  - source: ${r.source_primary}${r.pinpoint ? " · pinpoint: " + r.pinpoint : ""}`);
          L.push(`  - record: ${r.id}${r.authority ? " · " + r.authority : ""}${r.url ? " · " + r.url : ""}`);
          if (r.tension) L.push(`  - ${t.tension}: ${r.tension}${r.resolution_channel ? " · " + t.channel + r.resolution_channel : ""}`);
          const qs = framed[r.id];
          if (Array.isArray(qs) && qs.length) {
            L.push(`  - ${audience === "regulator" ? t.qReg : t.qProj}:`);
            for (const q of qs) L.push(`    - ${q}`);
          }
        } else {
          L.push(`- **${x.jur}**: ${t.noRec}. ${t.gapBody(DATA.jurisdictions[x.jur])}`);
        }
      }
      L.push("");
    }
  };
  const pressure = result.dims.filter((d) => d.tier === "pressure");
  const baseline = result.dims.filter((d) => d.tier !== "pressure");
  emit(pressure, t.tierP);
  emit(baseline, t.tierB);

  // Corridor layer among selected jurisdictions
  const pairs = [];
  for (let i = 0; i < jurs.length; i++) for (let k = 0; k < jurs.length; k++) if (i !== k) {
    const e = corridorEdge(jurs[i], jurs[k]);
    if (e && e.fwd) pairs.push({ o: jurs[i], d: jurs[k], e });
  }
  if (pairs.length) {
    L.push(`## ${t.navCorr}: ${t.corrToday}`);
    for (const p of pairs) {
      const label = (CLASS_LABEL[ui] || CLASS_LABEL.en)[p.e.fwd.c] || p.e.fwd.c;
      L.push(`- **${p.o} → ${p.d}**: ${label}${p.e.fwd.o ? " (⚑ " + t.ovLabel + ")" : ""}: ${(CLASS_MEANING[ui] || CLASS_MEANING.en)[p.e.fwd.c]}`);
      const tr = p.e.entry.t ? p.e.entry.t.filter((x) => x.e === p.o + "->" + p.d) : [];
      for (const x of tr) L.push(`  - ${t.corrFlip(x.dt, x.f, x.to)}`);
    }
    L.push("");
  }

  // Forward layer for selected jurisdictions
  const fwdJurs = jurs.filter((j) => COMPUTE.forward[j]);
  if (fwdJurs.length) {
    L.push(`## ${t.navFwd}: ${t.fwdJurH}`);
    for (const j of fwdJurs) {
      const F = COMPUTE.forward[j];
      L.push(`### ${j} (${DATA.jurisdictions[j]})`);
      L.push(F.reading);
      for (const e of F.events) {
        const tag = e.moves_class ? t.fwdMoves : e.accessibility_only ? t.fwdAccess : ((KIND_LABEL[ui] || KIND_LABEL.en)[e.trigger_kind] || e.trigger_kind);
        L.push(`- [${tag}]${e.effective_date ? " " + e.effective_date : ""}: ${e.title}`);
      }
      L.push("");
    }
  }

  L.push("---");
  L.push(`_${t.disc}_`);
  L.push("");
  L.push(`_${t.snapDisc}_`);
  return L.join("\n");
}

// ── Snapshot / liveness banner — always visible; makes the register's dated
// discipline a first-class element instead of a hidden contradiction. ─────────
function SnapshotBanner({ t, ui, sync }) {
  const age = snapshotAge(DATA.meta.as_of);
  const status = (sync && sync.status) || "bundled";
  const verified = status === "verified";
  const checking = status === "checking";
  const fallback = status === "fallback";
  const tag = verified ? t.snapLive : checking ? t.snapChecking : fallback ? t.snapFallback : t.snapFrozen;
  const detail = verified
    ? t.snapDiscLive
    : checking
      ? t.snapDiscChecking
      : fallback
        ? t.snapDiscFallback
        : t.snapDisc;
  return (
    <div
      className={"snapbar" + (verified ? " snapbar-live" : "") + (fallback ? " snapbar-fallback" : "")}
      aria-live="polite"
      title={fallback && sync.msg ? sync.msg : undefined}
    >
      <div className="snapbar-top">
        <span className={"snapbar-tag" + (verified ? " snapbar-tag-live" : "")}>{tag}</span>
        <span className="snapbar-meta">
          v{DATA.meta.version} · {verified ? <>{sync.n} {t.refreshed} · </> : null}{t.snapAge(DATA.meta.as_of, age)}
          {" · "}{DATA.meta.record_count} records · {DATA.meta.citable_count} {t.citableWord}
        </span>
      </div>
      <div className="snapbar-disc">{detail}</div>
    </div>
  );
}

// ── Session-coverage summary — honest record of which register layers the user
// has actually touched; feeds the export and gives the seam something concrete.
function SessionSummary({ t, session }) {
  const items = [];
  if (session.nodeDims) items.push(t.sessNode(session.nodeDims));
  if (session.corrPairs) items.push(t.sessCorr(session.corrPairs));
  if (session.fwdJurs) items.push(t.sessFwd(session.fwdJurs));
  if (session.struct) items.push(t.sessStruct);
  if (!items.length) return null;
  return (
    <div className="sess">
      <div className="sess-h">{t.sessH}</div>
      <div className="sess-items">{items.map((x, i) => <span key={i} className="sess-item"><span className="sess-badge">{t.layerBadge}</span>{x}</span>)}</div>
    </div>
  );
}

function Nav({ view, setView, t }) {
  // [v0.11.2 修复] 补 evaluate 键。VIEWS = ["evaluate", ...] 共 7 项，此处原只覆盖 6 项，
  // labels["evaluate"] 为 undefined，下面 labels[v][0] 在首次渲染即抛 TypeError。
  const labels = {
    evaluate: [t.navEval, t.navEvalSub],
    map: [t.navMap, t.navMapSub], corridors: [t.navCorr, t.navCorrSub], substrate: [t.navSub, t.navSubSub], forward: [t.navFwd, t.navFwdSub],
    structure: [t.navStruct, t.navStructSub], agents: [t.navAgents, t.navAgentsSub],
  };
  return (
    <nav className="nav">
      {VIEWS.map((v) => (
        <button key={v} className={"nav-btn" + (view === v ? " nav-on" : "")} onClick={() => setView(v)}>
          <span className="nav-btn-t">{labels[v][0]}</span>
          <span className="nav-btn-s">{labels[v][1]}</span>
        </button>
      ))}
    </nav>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
// CONSTRAINT SUBSTRATE · CORRIDOR "WHY" · LIVE MCP — added to close the review's
// coverage gaps against the underlying research:
//   • the eight-constraint substrate + six interaction sets (Architecture §2)
//     were named in the MCP surface but had no view — the deepest analytical
//     layer was invisible;
//   • the computed corridor skeleton showed a bare class chip with no grounded
//     reason, so a reader saw a verdict with no substrate behind it;
//   • the MCP surface was a static catalogue with no way to run a tool;
//   • the verification backlog (which cells are citable vs still pending) had no
//     interactive surface.
// Everything below is a PROJECTION of the register already embedded above
// (DATA / COMPUTE / MCP). It asserts no new facts: every substrate cell points
// back to the record(s) that justify it, and every MCP call filters or reshapes
// published records only.
// ═══════════════════════════════════════════════════════════════════════════

// The eight constraints (Cross-Border Stablecoin Architecture working paper,
// §2.1–2.8), condensed to a name + the load-bearing sentence + the cross-border
// composition problem each one generates. `dim` links each constraint to the
// register dimension(s) that instantiate it.
const CONSTRAINTS_FULL = [
  { id: "C1", dim: ["issuer_pathway"],
    zh: { n: "发行人资格", d: "谁可以发行法币锚定稳定币。各法域都把发行限定给一组受监管实体。", x: "跨法域的合格发行人类别并不重合,且除美国 GENIUS §18 的等效认定外无互认：任何跨境运营要么在每个发行法域各自持牌,要么走合作分销,要么单一法域发行 + 用户侧跨境持有。" },
    en: { n: "Issuer eligibility", d: "Who may issue a fiat-referenced stablecoin. Every surveyed regime restricts issuance to a defined set of regulated entities.", x: "The eligible-issuer categories are not coextensive across borders and: outside the US GENIUS §18 comparability process: carry no reciprocal recognition; a cross-border operation must hold eligibility in every issuing jurisdiction, run partnership distribution, or issue in one jurisdiction and rely on user-side holding." } },
  { id: "C2", dim: ["reserve_backing", "capital_requirements", "custody"],
    zh: { n: "储备构成与托管", d: "什么资产可作储备、谁可托管。各法域限定为高质流动资产 + 隔离托管 + 定期审计。", x: "储备构成绑定参考货币:美元锚定币的储备须由美国监管的托管人持有美元资产,不能仅凭该授权转到他法域托管：跨货币运营必须多发行人各自持牌,再以不需转移储备的桥接相连。" },
    en: { n: "Reserve composition & custody", d: "Which assets may back the liability and who custodies them: high-quality liquid assets, segregated custody, periodic audit.", x: "Reserve composition is tied to the reference currency: a USD token's reserves sit at a US-supervised custodian in dollar assets and cannot move to a foreign custodian on that authorization: cross-currency operation needs multiple issuers bridged without reserve transfer." } },
  { id: "C3", dim: ["permitted_activity_yield"],
    zh: { n: "收益禁止及其边界: 支柱一", d: "禁止就「持有」向持有人支付利息/收益。", x: "美国 GENIUS §4(a)(11) 的「solely in connection with holding」是活的分界:持有付息被禁,但用户主动把持有转入独立收益资产是否落入 §404 禁止,取决于该路由是发行人「授权代理人」还是用户导向的经纪：这是与 C4 的接合点。" },
    en: { n: "Yield prohibition & boundaries: SPINE 1", d: "No interest or yield to holders in connection with the holding itself.", x: "The 'solely in connection with holding' line (GENIUS §4(a)(11)) is the live boundary: holder yield is banned, but whether user-directed routing into a separate yield-bearing instrument falls inside §404 turns on whether the router is an authorized agent or a user-directed broker: the join with C4." } },
  { id: "C4", dim: ["securities_classification"],
    zh: { n: "证券归类边界: 支柱二", d: "该工具是否构成证券(美国 Reves/Howey;欧盟 MiCA 分类;各法域各自的分界)。", x: "合规支付稳定币本身是非证券,但把它路由进代币化货币基金份额的那一步跨越了证券边界：执行该路由的中介是否因此成为经纪/证券分销,是与 C3 同一条边界的另一面。" },
    en: { n: "Securities classification: SPINE 2", d: "Whether the instrument is a security (US Reves/Howey; EU MiCA categories; each regime's own line).", x: "A compliant payment stablecoin is a non-security, but routing it into tokenised money-market-fund shares crosses the securities boundary at the point of routing: whether the executing intermediary thereby becomes a broker is the same boundary as C3 viewed from the securities side." } },
  { id: "C5", dim: ["bank_nonbank_routing"],
    zh: { n: "银行/非银行地位与路由禁止", d: "架构中每个实体的银行或非银行地位,及其对可从事路由安排的后果。", x: "同一运营模式可能因主体是银行或非银行而被许可或被禁;§404 恰在此运作：谁算「关联方/授权代理人」取决于按银行法确定的关联结构。选择须跨法域联合作出。" },
    en: { n: "Bank / non-bank status & routing", d: "The bank-or-non-bank status of each entity and its consequences for permitted routing arrangements.", x: "The same pattern may be permitted or prohibited depending on bank vs non-bank configuration; §404 operates here: who counts as an affiliate or authorized agent turns on the affiliation structure fixed by banking law. The choice must be made jointly across jurisdictions." } },
  { id: "C6", dim: ["cross_border_data"],
    zh: { n: "跨境支付与数据主权", d: "支付指令与个人数据的跨境流动(中国 PIPL/DSL、欧盟 GDPR、FATF 旅行规则)。", x: "任何触及中国境的资金/数据流须实现其要求的出境机制;触及欧盟居民数据须实现相应机制：当一条通道同时触及两者,合规负担叠加,实质约束可行的运营模式。" },
    en: { n: "Cross-border payment & data sovereignty", d: "Movement of payment instructions and personal data across borders (PRC PIPL/DSL, EU GDPR, FATF Travel Rule).", x: "Any flow crossing the PRC boundary must implement its transfer mechanism, and any flow touching EU-resident data must implement the EU mechanism: a corridor touching both carries a layered compliance burden that materially constrains the available pattern." } },
  { id: "C7", dim: ["monetary_sovereignty"],
    zh: { n: "货币主权与储备货币不对称", d: "宏观层关切:外币(尤其美元)锚定币的流通可能侵蚀货币政策传导、铸币税或金融稳定。", x: "美元与他币不对称：三种机制作为回应:欧盟 MiCA Art.58(3) 数量上限、阿联酋在岸渠道限制、中国全面禁止。跨境非本币流通必须叠加受方法域的主权约束,而非只看运营约束。" },
    en: { n: "Monetary sovereignty & reserve-currency asymmetry", d: "The macro concern that foreign-currency (especially USD) token circulation may erode monetary transmission, seigniorage, or financial stability.", x: "The dollar/other asymmetry draws three responses: the MiCA Art.58(3) means-of-exchange cap, the UAE onshore channel restriction, and the PRC categorical prohibition: so any non-domestic-currency flow must add the receiving jurisdiction's sovereignty constraint on top of its operational ones." } },
  { id: "C8", dim: ["disclosure_reporting", "distribution"],
    zh: { n: "披露、报告与监管协调", d: "发行人的披露、对监管者的报告,以及多监管者间的协调机制。", x: "二阶约束:满足它要求以监管者可核查的方式满足 C1–C7 的每一项。跨法域监管协调仍欠发达,故证明合规的负担落在运营方身上,本身可能成为约束可行模式的瓶颈。" },
    en: { n: "Disclosure, reporting & supervisory coordination", d: "Issuer disclosure, reporting to the supervisor, and coordination among the multiple supervisors over a cross-border operation.", x: "A second-order constraint: satisfying it requires satisfying every other constraint in a supervisor-verifiable way. Cross-jurisdictional coordination is underdeveloped, so the proof-of-compliance burden falls on the operator and can itself become the binding constraint." } },
];

// The six constraint-interaction sets (Architecture §2.9) — the specific
// composition problems that motivate the architectural patterns. Each names the
// constraint pair and the question it forces.
const INTERACTION_SETS = [
  { id: "A", pair: ["C1", "C6"],
    zh: { t: "发行人资格 × 数据主权", p: "当实体的最终母公司受他法域数据主权限制、无法向东道监管者共享监管信息时,即便形式上符合牌照标准,发行人资格也可能无法满足。中国—香港互动即此集的实例。" },
    en: { t: "Issuer eligibility × data sovereignty", p: "Where the ultimate parent is under data-sovereignty limits that block sharing supervisory information with the host supervisor, issuer eligibility may be unsatisfiable even if the formal licensing criteria are met. The PRC–Hong Kong interaction is the worked example." } },
  { id: "B", pair: ["C3", "C4"],
    zh: { t: "收益禁止 × 证券归类", p: "路由安排是否落入 §404 禁止,取决于它被配置为发行人「就持有付息的授权代理人」,还是「执行用户指令、把稳定币换成投资公司份额的用户导向经纪」。这条 Reves 四要素分析是全篇的接合枢纽。" },
    en: { t: "Yield prohibition × securities classification", p: "Whether a routing arrangement falls inside §404 turns on whether it is configured so the router functions as an authorized agent paying yield for the holding, or as a user-directed broker executing an instruction to convert the stablecoin into fund shares. This is the analytical hinge of the whole paper." } },
  { id: "C", pair: ["C5", "C1"],
    zh: { t: "银行/非银行地位 × 发行人资格", p: "许多法域的发行人资格部分取决于银行/非银行地位(GENIUS 为银行与非银行设不同路径;MiCA 为信用机构与电子货币机构设不同类别)。银行—非银行的配置选择必须跨法域联合作出。" },
    en: { t: "Bank / non-bank status × issuer eligibility", p: "Eligibility in many jurisdictions depends in part on bank vs non-bank status (GENIUS creates separate bank/non-bank paths; MiCA separate credit-institution/EMI categories). The bank-vs-non-bank configuration must be chosen jointly across jurisdictions." } },
  { id: "D", pair: ["C2", "C7"],
    zh: { t: "储备构成 × 货币主权", p: "某参考货币的储备通常持有该货币计价的资产,故跨境流通量会为该货币生成资产需求、在发行国产生货币政策效应。MiCA Art.58(3) 上限即对此的操作性回应。" },
    en: { t: "Reserve composition × monetary sovereignty", p: "Reserves of a given reference currency are typically held in that currency's assets, so cross-border circulation generates demand for those assets and can have monetary-policy effects in the issuing economy. The Art.58(3) cap is the operative response." } },
  { id: "E", pair: ["C4", "C6"],
    zh: { t: "证券归类 × 跨境支付", p: "把非证券支付稳定币转为证券化投资基金的路由在路由点跨越证券边界;当该安排横跨多法域(如 GENIUS 稳定币路由至欧盟 UCITS),跨境支付指令须同时满足两法域证券法的披露与路由要求。" },
    en: { t: "Securities classification × cross-border payment", p: "A routing arrangement converting a non-security payment token into a security fund crosses the securities boundary at the point of routing; where it spans jurisdictions (a GENIUS token routed to an EU UCITS), the payment instruction must satisfy both jurisdictions' securities disclosure and routing rules." } },
  { id: "F", pair: ["C8", "C1"],
    zh: { t: "披露与监管协调 × 其余全部", p: "二阶约束:满足 C8 要求以监管者可核查的方式满足 C1–C7 的每一项。协调欠发达处,证明负担落在运营方,本身即可能成为约束可行模式的绑定项。" },
    en: { t: "Disclosure & coordination × all other constraints", p: "A second-order constraint (C8 × C1–7): satisfying it requires satisfying every substantive constraint in a supervisor-verifiable way. Where coordination is weak, the proof burden on the operator can itself become the binding constraint." } },
];

const CID_TO_CONSTRAINT = Object.fromEntries(CONSTRAINTS_FULL.map((c) => [c.id, c]));

// evidence_tier -> which citability tier a cell has reached (for the substrate
// grid + the verification backlog). Kept identical to the register's own axis.
function cellStatus(recs) {
  if (!recs.length) return "none";
  if (recs.some((r) => r.citable)) return "citable";
  if (recs.some((r) => r.status === "in_force" && r.claim_class === "tier1_legal")) return "pending";
  return "other";
}

// Build the (jurisdiction × C1–C8) substrate purely from records that carry a
// constraint_ref. Each cell is the pole (its records + citability), so the whole
// grid is a projection with no authored content of its own.
function buildSubstrate() {
  const jurs = Object.keys(DATA.jurisdictions);
  const grid = {};
  for (const j of jurs) {
    grid[j] = {};
    for (const c of CONSTRAINTS_FULL) {
      const cell = DATA.records.filter((r) => r.jur === j && r.constraint_ref === c.id);
      grid[j][c.id] = { recs: cell, status: cellStatus(cell) };
    }
  }
  return { jurs, grid };
}

// The verification backlog / citability tally, computed live so it always tracks
// the embedded snapshot.
function citabilityTally() {
  const R = DATA.records;
  const citable = R.filter((r) => r.citable);
  const backlog = R.filter((r) => r.claim_class === "tier1_legal" && r.status === "in_force" && r.evidence_tier !== "resolution_text");
  return {
    total: R.length,
    citable: citable.length,
    backlog: backlog.length,
    tier1: R.filter((r) => r.claim_class === "tier1_legal").length,
    inforce: R.filter((r) => r.status === "in_force").length,
    backlogList: backlog,
  };
}

// Origin exportability: can this jurisdiction ORIGINATE a token that can leave?
// Read from its C1 (issuer_pathway) binding_status — an enacted issuer regime can
// export; prohibition / pre-regime / made-not-commenced / policy-pending cannot.
function originExportable(j) {
  const c1 = DATA.records.find((r) => r.jur === j && r.dimension === "issuer_pathway");
  if (!c1) return false;
  return c1.binding_status === "in_force_enacted";
}

// Derive WHY a directed corridor sits in its class, and cite the substrate
// record(s) that produce it. This reads the class off COMPUTE and explains it via
// the C1–C8 poles — it does not re-derive the class or assert anything new.
function corridorWhyModel(o, d) {
  const e = corridorEdge(o, d);
  if (!e || !e.fwd) return null;
  const cls = e.fwd.c;
  const originOverride = !!e.fwd.o;
  const findRec = (jur, cid) => DATA.records.find((r) => r.jur === jur && r.constraint_ref === cid) ||
    DATA.records.find((r) => r.jur === jur && r.dimension === "issuer_pathway");
  let rule, jur, cid;
  if (cls === "I") { rule = "clean"; }
  else if (cls === "blocked") { rule = "dest_blocked"; jur = d; cid = "C1"; }
  else if (cls === "pre_regime") { rule = "dest_pre"; jur = d; cid = "C1"; }
  else if (cls === "T") { rule = "dest_transition"; jur = d; cid = "C1"; }
  else if (cls === "II") { rule = "dest_gate"; jur = d; cid = "C7"; }
  else { // III
    if (!originExportable(o)) { rule = "origin_drag"; jur = o; cid = "C1"; }
    else { rule = "compose"; jur = d; cid = "C1"; }
  }
  const rec = jur ? findRec(jur, cid) : null;
  return { cls, rule, jur, cid, rec, originOverride };
}

// ── Live MCP tool runners. Each is a pure function over the embedded register;
// no network, no synthesis — the returned object is exactly what the deployed
// server's tool would reshape. Used by <McpRunner/> to make the surface runnable.
function mcpCitableLaw() {
  const rows = DATA.records.filter((r) => r.decision_ready === true).map((r) => ({
    id: r.id, jur: r.jur, dimension: r.dimension, constraint_ref: r.constraint_ref,
    pinpoint: r.pinpoint, url: r.url,
  }));
  return { tool: "citable_law()", returned: rows.length, guard: "tier1_legal ∧ in_force ∧ resolution_text ∧ official ∧ current ∧ reconciled ∧ source.url ∧ pinpoint", rows: rows.slice(0, 8), truncated: rows.length > 8 ? rows.length - 8 : 0 };
}
function mcpQuery(jur, dim) {
  const rows = DATA.records.filter((r) => (!jur || r.jur === jur) && (!dim || r.dimension === dim)).map((r) => ({
    id: r.id, jur: r.jur, dimension: r.dimension, status: r.status, citable: r.citable, evidence_tier: r.evidence_tier,
  }));
  return { tool: `query(jurisdiction=${jur || "*"}, dimension=${dim || "*"})`, returned: rows.length, rows: rows.slice(0, 8), truncated: rows.length > 8 ? rows.length - 8 : 0 };
}
function mcpComposeCorridor(o, d) {
  const w = corridorWhyModel(o, d);
  const e = corridorEdge(o, d);
  if (!e || !e.fwd) return { tool: `compose_corridor(${o}->${d})`, error: "no edge" };
  return {
    tool: `compose_corridor(origin=${o}, destination=${d}, as_of=${DATA.meta.as_of})`,
    directed_class: e.fwd.c, reverse_class: e.rev ? e.rev.c : null, undirected: e.entry.u,
    origin_export_restriction: !!e.fwd.o, rule_fired: w ? w.rule : null,
    justifying_record: w && w.rec ? w.rec.id : null,
    scheduled_transitions: (e.entry.t || []).filter((x) => x.e === o + "->" + d),
    contingent_transitions: (e.entry.w || []).length,
    asserts_new_facts: false,
  };
}
function mcpConstraintSubstrate(jur) {
  const { grid } = buildSubstrate();
  const g = grid[jur] || {};
  const poles = CONSTRAINTS_FULL.map((c) => ({
    constraint: c.id, pole: g[c.id] ? g[c.id].status : "none",
    records: g[c.id] ? g[c.id].recs.map((r) => r.id) : [],
  }));
  return { tool: `constraint_substrate(jurisdiction=${jur})`, jurisdiction: jur, poles, asserts_new_facts: false };
}
function mcpVerificationWorklist() {
  const b = citabilityTally();
  return {
    tool: "verification_worklist()",
    citable: b.citable, in_force_tier1: b.tier1, pending_to_citable: b.backlog,
    sample: b.backlogList.slice(0, 8).map((r) => ({ id: r.id, evidence_tier: r.evidence_tier, needs: r.evidence_tier === "firm_summary" ? "official primary-text line-read" : r.evidence_tier === "mixed" ? "operational detail + source.url" : "primary-source pass" })),
    truncated: b.backlog > 8 ? b.backlog - 8 : 0,
  };
}

// A compact, live "why" block for the corridor view: the rule that fired + the
// substrate record that justifies it. Closes the "bare class chip" gap.
function CorridorWhy({ o, d, t, ui }) {
  const w = corridorWhyModel(o, d);
  if (!w) return null;
  const ruleTxt = t.whyRule[w.rule];
  const c = w.cid ? CID_TO_CONSTRAINT[w.cid] : null;
  return (
    <div className="why">
      <div className="why-h">{t.whyH}</div>
      <div className="why-rule"><span className={"why-badge why-" + w.rule}>{ruleTxt}</span></div>
      {c && (
        <div className="why-con">
          <span className="why-con-id">{c.id}</span>
          <span className="why-con-n">{c[ui].n}</span>
          {w.jur && <span className="why-con-j">{ui === "zh" ? "绑定于" : "binds at"} {w.jur}</span>}
        </div>
      )}
      {w.rec ? (
        <div className="why-rec">
          <span className={"why-rec-dot why-" + (w.rec.citable ? "cit" : "pend")} />
          <code className="why-rec-id">{w.rec.id}</code>
          <span className="why-rec-pin">{w.rec.pinpoint}</span>
          {w.rec.url && <a className="why-rec-src" href={w.rec.url} target="_blank" rel="noreferrer">{ui === "zh" ? "一手来源 ↗" : "primary ↗"}</a>}
        </div>
      ) : (
        <div className="why-clean">{t.whyClean}</div>
      )}
      {w.originOverride && <div className="why-ovr">⚑ {t.corrOverride}</div>}
      <div className="why-note">{t.whyNote}</div>
    </div>
  );
}

// ── The Constraint Substrate view: the eight-constraint vocabulary, the
// jurisdiction × C1–C8 pole grid (with citability), and the six interaction sets.
// This is the register's deepest analytical layer, previously view-less.
function SubstrateView({ t, ui, sj, setSj, sc, setSc }) {
  const { jurs, grid } = buildSubstrate();
  const tally = citabilityTally();
  const activeCon = CID_TO_CONSTRAINT[sc] || CONSTRAINTS_FULL[0];
  const cell = grid[sj] && grid[sj][sc] ? grid[sj][sc] : { recs: [], status: "none" };
  const statusLabel = { citable: t.subStatCit, pending: t.subStatPend, other: t.subStatOther, none: t.subStatNone };

  return (
    <div className="view">
      <h2 className="view-h">{t.subH}</h2>
      <p className="view-lead">{t.subLead}</p>

      {/* citability tally: the substrate's own completeness, live from the snapshot */}
      <div className="sub-tally">
        <div className="sub-tally-c sub-cit"><b>{tally.citable}</b><span>{t.subTallyCit}</span></div>
        <div className="sub-tally-c sub-pend"><b>{tally.backlog}</b><span>{t.subTallyPend}</span></div>
        <div className="sub-tally-c"><b>{tally.tier1}</b><span>{t.subTallyT1}</span></div>
        <div className="sub-tally-c"><b>{tally.total}</b><span>{t.subTallyTot}</span></div>
      </div>

      {/* the eight constraints */}
      <div className="sub-sec-h">{t.subConH}</div>
      <div className="sub-cons">
        {CONSTRAINTS_FULL.map((c) => (
          <button key={c.id} className={"sub-con" + (sc === c.id ? " on" : "")} onClick={() => setSc(c.id)}>
            <span className="sub-con-id">{c.id}</span>
            <span className="sub-con-n">{c[ui].n}</span>
          </button>
        ))}
      </div>
      <div className="sub-con-detail">
        <div className="sub-con-d">{activeCon[ui].d}</div>
        <div className="sub-con-x"><span className="sub-con-x-l">{t.subConX}</span>{activeCon[ui].x}</div>
        <div className="sub-con-dims">
          <span className="sub-con-dims-l">{t.subConDims}</span>
          {activeCon.dim.map((dm) => <span key={dm} className="sub-con-dim">{DATA.dimensions[dm]}</span>)}
        </div>
      </div>

      {/* the jurisdiction × constraint pole grid */}
      <div className="sub-sec-h">{t.subGridH}</div>
      <div className="sub-grid-hint">{t.subGridHint}</div>
      <div className="sub-grid-wrap">
        <table className="sub-grid">
          <thead>
            <tr>
              <th className="sub-grid-corner"></th>
              {CONSTRAINTS_FULL.map((c) => (
                <th key={c.id} className={"sub-grid-ch" + (sc === c.id ? " on" : "")} onClick={() => setSc(c.id)}>{c.id}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jurs.map((j) => (
              <tr key={j} className={sj === j ? "on" : ""}>
                <th className="sub-grid-rh" onClick={() => setSj(j)}>{j}</th>
                {CONSTRAINTS_FULL.map((c) => {
                  const st = grid[j][c.id].status;
                  const sel = sj === j && sc === c.id;
                  return (
                    <td key={c.id} className={"sub-cell sub-" + st + (sel ? " sub-sel" : "")}
                        onClick={() => { setSj(j); setSc(c.id); }}
                        title={j + " · " + c.id + " · " + (statusLabel[st] || st)}>
                      <span className="sub-dot" />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sub-legend">
        <span className="sub-leg"><span className="sub-dot sub-citable" /> {t.subStatCit}</span>
        <span className="sub-leg"><span className="sub-dot sub-pending" /> {t.subStatPend}</span>
        <span className="sub-leg"><span className="sub-dot sub-other" /> {t.subStatOther}</span>
      </div>

      {/* the selected pole (jurisdiction × constraint) */}
      <div className="sub-pole">
        <div className="sub-pole-head">
          <span className="sub-pole-jur">{sj} · {DATA.jurisdictions[sj]}</span>
          <span className="sub-pole-arrow">×</span>
          <span className="sub-pole-con">{activeCon.id} {activeCon[ui].n}</span>
          <span className={"sub-pole-stat sub-stat-" + cell.status}>{statusLabel[cell.status] || cell.status}</span>
        </div>
        {cell.recs.length ? cell.recs.map((r) => (
          <div key={r.id} className="sub-rec">
            <div className="sub-rec-top">
              <span className={"sub-dot sub-" + (r.citable ? "citable" : "pending")} />
              <code className="sub-rec-id">{r.id}</code>
              <span className="sub-rec-auth">{r.authority}</span>
              {r.url && <a className="sub-rec-src" href={r.url} target="_blank" rel="noreferrer">↗</a>}
            </div>
            <div className="sub-rec-sum">{r.requirement_summary}</div>
            {r.tension && <div className="sub-rec-tension"><span className="sub-rec-tension-l">{t.subTension}</span>{r.tension}</div>}
          </div>
        )) : <div className="sub-rec-none">{t.subPoleNone}</div>}
      </div>

      {/* the six interaction sets */}
      <div className="sub-sec-h">{t.subIntH}</div>
      <div className="sub-int-lead">{t.subIntLead}</div>
      <div className="sub-ints">
        {INTERACTION_SETS.map((s) => (
          <div key={s.id} className="sub-int">
            <div className="sub-int-head">
              <span className="sub-int-id">{s.id}</span>
              <span className="sub-int-pair">
                {s.pair.map((p, i) => (
                  <span key={p}>
                    <button className="sub-int-c" onClick={() => setSc(p)}>{p}</button>
                    {i < s.pair.length - 1 && <span className="sub-int-x">×</span>}
                  </span>
                ))}
              </span>
              <span className="sub-int-t">{s[ui].t}</span>
            </div>
            <div className="sub-int-p">{s[ui].p}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Live MCP runner appended to the Agents view: pick a tool, run it against the
// embedded register, see the real returned shape. No network; the output is a
// projection of DATA/COMPUTE, matching the deployed server's contract.
function McpRunner({ t, ui }) {
  const jurList = Object.keys(DATA.jurisdictions);
  const [tool, setTool] = useState("citable_law");
  const [a1, setA1] = useState("HK");
  const [a2, setA2] = useState("BR");
  const tools = [
    { k: "citable_law", label: "citable_law()" },
    { k: "query", label: "query()" },
    { k: "compose_corridor", label: "compose_corridor()" },
    { k: "constraint_substrate", label: "constraint_substrate()" },
    { k: "verification_worklist", label: "verification_worklist()" },
  ];
  let out;
  if (tool === "citable_law") out = mcpCitableLaw();
  else if (tool === "query") out = mcpQuery(a1, null);
  else if (tool === "compose_corridor") out = mcpComposeCorridor(a1, a2);
  else if (tool === "constraint_substrate") out = mcpConstraintSubstrate(a1);
  else out = mcpVerificationWorklist();

  const needsJur = tool === "query" || tool === "compose_corridor" || tool === "constraint_substrate";
  const needsDest = tool === "compose_corridor";

  return (
    <div className="mcp-run">
      <div className="mcp-run-h">{t.mcpRunH}</div>
      <div className="mcp-run-lead">{t.mcpRunLead}</div>
      <div className="mcp-run-tools">
        {tools.map((tl) => (
          <button key={tl.k} className={"mcp-run-tool" + (tool === tl.k ? " on" : "")} onClick={() => setTool(tl.k)}>{tl.label}</button>
        ))}
      </div>
      {(needsJur || needsDest) && (
        <div className="mcp-run-args">
          {needsJur && (
            <label className="mcp-arg">{needsDest ? t.mcpArgO : t.mcpArgJur}
              <select value={a1} onChange={(e) => setA1(e.target.value)}>{jurList.map((j) => <option key={j} value={j}>{j}</option>)}</select>
            </label>
          )}
          {needsDest && (
            <label className="mcp-arg">{t.mcpArgD}
              <select value={a2} onChange={(e) => setA2(e.target.value)}>{jurList.map((j) => <option key={j} value={j}>{j}</option>)}</select>
            </label>
          )}
        </div>
      )}
      <pre className="mcp-out">{JSON.stringify(out, null, 2)}</pre>
      <div className="mcp-run-note">{t.mcpRunNote}</div>
    </div>
  );
}

export default function App() {
  const [ui, setUi] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search).get("lang");
      if (p === "zh" || p === "en") return p;
    } catch (e) {}
    return "en";
  });
  // Origin of the page embedding us, learned from the first language message it sends. Replies are
  // then addressed to that origin instead of broadcast to "*". Falls back to "*" if we never hear
  // from a parent (e.g. the mapper opened standalone), so standalone use is unaffected.
  const parentOrigin = useRef("");
  useEffect(() => {
    function onLangMessage(e) {
      const d = e && e.data;
      if (d && d.type === "cbsr-lang" && (d.lang === "zh" || d.lang === "en")) {
        if (e.origin && e.origin !== "null") parentOrigin.current = e.origin;
        setUi(d.lang);
      }
    }
    window.addEventListener("message", onLangMessage);
    // Announce that we are mounted and listening. The embedding page posts the language
    // on the iframe's `load` event, which can fire BEFORE React attaches the listener
    // above — so that first post can land with nobody home. The landing page re-posts on
    // `cbsr-ready`, which closes the race. Broadcast to "*" because the parent's origin
    // is not known until it speaks to us first; safe here because the message carries no
    // data, and the landing page validates the sender's origin before acting on it.
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage({ type: "cbsr-ready" }, "*");
    } catch (e) {}
    return () => window.removeEventListener("message", onLangMessage);
  }, []);
  const [description, setDescription] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [fileName, setFileName] = useState("");
  const [deriving, setDeriving] = useState(false);
  const [deriveMsg, setDeriveMsg] = useState("");
  const [lang, setLang] = useState("auto");
  const [jurs, setJurs] = useState(["HK"]);
  const [sync, setSync] = useState(() => ({ status: REGISTER_API ? "checking" : "bundled" }));
  const [manualMode, setManualMode] = useState(false);
  // Reactive capability signal: flips true if an AI call fails with an auth/CORS/network error,
  // which is how the self-hosted-without-proxy case actually manifests. When set, the same no-AI
  // banner appears and manual mode opens — so we degrade gracefully at the moment of real failure
  // instead of guessing from the hostname up front (which can be wrong inside the sandbox).
  const [aiRuntimeDown, setAiRuntimeDown] = useState(false);
  // In-UI proxy config field (rendered in the degraded-mode banner). proxyInput is the controlled
  // text value; proxyApplied echoes the endpoint once set so the user gets confirmation.
  const [proxyInput, setProxyInput] = useState(currentAiProxy());
  const [proxyApplied, setProxyApplied] = useState("");
  const [manualFeat, setManualFeat] = useState({ yield: false, securities_wrapper: false, lending_or_routing: false, non_domestic_peg: false, cross_border_or_data: false, custody: false });
  // Verify the bundled snapshot against the deployed API. prepareRegisterSync
  // unwraps the API envelopes and prepares a complete six-axis replacement,
  // but only when records, meta and COMPUTE identify the exact same build.
  // Any network/shape/version failure is explicit and leaves DATA untouched.
  useEffect(() => {
    if (!REGISTER_API) return;
    let cancelled = false;
    (async () => {
      try {
        const [rRes, mRes] = await Promise.all([
          fetch(REGISTER_API + "/records.json"),
          fetch(REGISTER_API + "/meta.json"),
        ]);
        if (!rRes.ok) throw new Error("records " + rRes.status);
        if (!mRes.ok) throw new Error("meta " + mRes.status);
        const prepared = prepareRegisterSync({
          recordsPayload: await rRes.json(),
          metaPayload: await mRes.json(),
          bundledData: DATA,
          compute: COMPUTE,
        });
        if (cancelled) return;
        DATA.records.splice(0, DATA.records.length, ...prepared.records);
        Object.assign(DATA.meta, prepared.meta);
        setSync(prepared.sync);
      } catch (e) {
        if (!cancelled) {
          setSync({
            status: "fallback",
            ok: false,
            msg: String((e && e.message) || e),
            version: DATA.meta.version,
            as_of: DATA.meta.as_of,
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [audience, setAudience] = useState("regulator");
  const [stage, setStage] = useState("idle");
  const [result, setResult] = useState(null);
  const [framed, setFramed] = useState({});
  const [framedHidden, setFramedHidden] = useState({});
  const [framing, setFraming] = useState(null); // {done,total} while generating questions
  const [frameErr, setFrameErr] = useState(""); // classified reason the question leg failed
  const [frameMissing, setFrameMissing] = useState([]); // entries that still have no questions
  const frameCtx = useRef(null);                // inputs kept so a retry need not re-run the map
  const [showBaseline, setShowBaseline] = useState(false);
  useEffect(() => { setShowBaseline(audience !== "regulator"); }, [audience]); // baseline collapsed by default -> hard focus on pressure points
  const [error, setError] = useState("");
  const [errRaw, setErrRaw] = useState("");

  const [view, setView] = useState("map");
  const [o, setO] = useState("US");
  const [d, setD] = useState("UK");
  const [asOf, setAsOf] = useState(null);   // corridors/forward: compose(as_of) date; null = today snapshot
  const [fj, setFj] = useState("KR");
  const [sj, setSj] = useState("US");   // substrate: selected jurisdiction
  const [sc, setSc] = useState("C3");   // substrate: selected constraint (C3 = the yield spine)
  const [exported, setExported] = useState(false);
  const [visited, setVisited] = useState({ map: true });
  useEffect(() => { setVisited((p) => (p[view] ? p : { ...p, [view]: true })); }, [view]);

  const t = { ...T[ui], ...TX[ui] };
  const dirRef = useRef(null);
  const blockRefs = useRef({});
  const scrollTo = (node) => { if (node && node.scrollIntoView) node.scrollIntoView({ behavior: "smooth", block: "start" }); };

  const jurList = Object.keys(DATA.jurisdictions);
  const covCount = (j) => (DATA.coverage[j] || []).length;
  const toggleJur = (j) => setJurs((p) => p.includes(j) ? p.filter((x) => x !== j) : [...p, j]);

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFileName(f.name); setError(""); setErrRaw(""); setDeriving(true); setDeriveMsg(t.dExtracting);
    const isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        let desc;
        if (isPdf) {
          const b64 = String(reader.result).split(",")[1];
          desc = await callClaude([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }, { type: "text", text: extractPrompt(lang) }]);
        } else {
          desc = await callClaude(extractPrompt(lang) + '\n\nDOCUMENT:\n"""\n' + String(reader.result).slice(0, 12000) + '\n"""');
        }
        setDescription(desc); setDeriveMsg(t.dExtracted);
      } catch (err) { setError(t.dExtractFail(err.message || "unknown")); if (aiEnvDown(err.message)) setAiRuntimeDown(true); setDeriveMsg(""); }
      finally { setDeriving(false); }
    };
    reader.onerror = () => { setError(t.dReadFail); setDeriving(false); setDeriveMsg(""); };
    if (isPdf) reader.readAsDataURL(f); else reader.readAsText(f);
  }

  async function onUrl() {
    if (!urlInput.trim()) { setError(t.needUrl); return; }
    setError(""); setErrRaw(""); setDeriving(true); setDeriveMsg(t.dUrlReading);
    try {
      const desc = await callClaude(urlPrompt(urlInput.trim(), lang), { tools: [{ type: "web_search_20250305", name: "web_search" }] });
      setDescription(desc); setDeriveMsg(t.dUrlDone);
    } catch (err) { setError(t.dUrlFail(err.message || "unknown")); if (aiEnvDown(err.message)) setAiRuntimeDown(true); setDeriveMsg(""); }
    finally { setDeriving(false); }
  }

  const assembleAndFrame = async (features, restatement, scope, L) => {
    setStage("retrieving");
    const recByJurDim = {};
    for (const rec of DATA.records) if (jurs.includes(rec.jur)) (recByJurDim[rec.jur] = recByJurDim[rec.jur] || {})[rec.dimension] = rec;
    const validDims = deriveDims(features, jurs, recByJurDim, L);

    const dimsResult = []; const covered = []; const gapFramed = {}; let gapN = 0;
    for (const d of validDims) {
      const jrow = [];
      for (const j of jurs) {
        const rec = (recByJurDim[j] || {})[d.key] || null;
        jrow.push({ jur: j, rec });
        if (rec) covered.push({ key: rec.id, jurisdiction: DATA.jurisdictions[j], dimension: d.key, requirement: rec.requirement_summary, tension: rec.tension || "", resolution_channel: rec.resolution_channel || "" });
        else { gapFramed["gap:" + j + ":" + d.key] = T[L].gapQ(DATA.jurisdictions[j], DATA.dimensions[d.key] || d.key); gapN++; }
      }
      dimsResult.push({ key: d.key, tier: d.tier, reason: d.reason, jurs: jrow });
    }

    // Honest label: no covered record for any derived dimension across the selected jurisdictions
    // is a coverage gap in the register, NOT a vague description.
    if (covered.length === 0) { setResult({ kind: "no_coverage", restatement, jurs: jurs.slice() }); setStage("done"); return; }

    const corridors = (DATA.corridors || []).filter((c) => c.legs.every((leg) => jurs.includes(leg)));

    setFramed(gapFramed);
    setResult({ kind: "ok", scope, restatement, dims: dimsResult, coveredN: covered.length, gapN, corridors });
    setStage("framing");

    // Grounding text per covered record, for the numeric term of the code-gate.
    const coveredIds = new Set(covered.map((c) => c.key));
    const groundById = {};
    for (const rec of DATA.records) if (coveredIds.has(rec.id)) groundById[rec.id] = [rec.requirement_summary, rec.tension, rec.pinpoint, rec.source_primary].filter(Boolean).join(" ");

    // Keep everything the framer needs so a later retry does not have to re-run the whole map.
    frameCtx.current = { covered, groundById, L, audience };

    // DEMO_MODE: compose the questions from each record's own fields. Instant, offline,
    // and grounded by construction — so there is no framing progress bar, no partial
    // failure panel, and no "questions could not be generated" state to explain.
    if (DEMO_MODE) {
      const recById = {};
      for (const rec of DATA.records) if (coveredIds.has(rec.id)) recById[rec.id] = rec;
      const det = {};
      for (const c of covered) {
        const rec = recById[c.key];
        if (rec) det[c.key] = localQuestions(c, rec, audience, L, T[L]);
      }
      setFramed((prev) => ({ ...prev, ...det }));
      setFraming(null); setFrameErr(""); setFrameMissing([]);
      setStage("done");
      return;
    }

    await runFraming(covered, groundById, L, audience);
    setStage("done");
  };

  // Question generation, extracted so it can be re-run on its own. The old version swallowed every
  // framer error: a failed batch just pushed its entries into `missed`, the retry pass failed the
  // same way, and the user was left with "questions couldn't be generated" and no cause — even
  // though the cause was invariably the same missing proxy that produced the banner above. Now the
  // last error is classified, shown, and allowed to trip the degraded-mode state.
  const runFraming = async (covered, groundById, L, aud, only) => {
    const SIZE = 4;
    const FRAME_OPTS = { max_tokens: 2000 };
    const work = Array.isArray(only) && only.length ? only : covered;
    setFrameErr("");
    const batches = [];
    for (let i = 0; i < work.length; i += SIZE) batches.push(work.slice(i, i + SIZE));
    setFraming({ done: 0, total: batches.length });
    const missed = [];
    let lastErr = "";
    let stopped = -1;
    for (let bi = 0; bi < batches.length; bi++) {
      const fr = await callWithRetry((strict) => framerPrompt(aud, batches[bi], L, strict), FRAME_OPTS);
      if (fr.ok) {
        const { kept, dropped } = sanitizeFramed(fr.value, groundById);
        setFramed((prev) => ({ ...prev, ...kept }));
        setFramedHidden((prev) => ({ ...prev, ...dropped }));
        for (const e of batches[bi]) if (!Array.isArray(kept[e.key]) || kept[e.key].length === 0) missed.push(e);
      } else {
        lastErr = fr.error || lastErr;
        for (const e of batches[bi]) missed.push(e);
      }
      setFraming({ done: bi + 1, total: batches.length });
      // An environment failure will not fix itself on the next batch: stop burning attempts.
      if (aiEnvDown(lastErr)) { stopped = bi; break; }
    }
    // Batches we never reached still have no questions — count them, or the failure panel
    // would under-report how much is actually missing.
    if (stopped >= 0) for (let bi = stopped + 1; bi < batches.length; bi++) missed.push(...batches[bi]);
    const stillMissing = [];
    if (!aiEnvDown(lastErr)) {
      for (const e of missed) {
        const fr = await callWithRetry((strict) => framerPrompt(aud, [e], L, strict), FRAME_OPTS);
        if (fr.ok) {
          const { kept, dropped } = sanitizeFramed(fr.value, groundById);
          if (Array.isArray(kept[e.key]) && kept[e.key].length) setFramed((prev) => ({ ...prev, [e.key]: kept[e.key] }));
          else stillMissing.push(e);
          if (dropped[e.key]) setFramedHidden((prev) => ({ ...prev, [e.key]: dropped[e.key] }));
        } else { lastErr = fr.error || lastErr; stillMissing.push(e); }
      }
    } else {
      stillMissing.push(...missed);
    }
    setFraming(null);
    setFrameMissing(stillMissing);
    // Store the RAW error code, not the rendered sentence: classifying at render time means the
    // message follows the UI-language toggle instead of freezing in whatever locale was active.
    if (stillMissing.length && lastErr) {
      setFrameErr(lastErr);
      if (aiEnvDown(lastErr)) setAiRuntimeDown(true);
    }
  };

  // Retry only the entries that still have no questions — records and sources are already on screen
  // and must not be thrown away just because the model leg failed.
  const retryFraming = async () => {
    const ctx = frameCtx.current;
    if (!ctx) return;
    const missing = (ctx.covered || []).filter((e) => !Array.isArray(framed[e.key]) || framed[e.key].length === 0);
    await runFraming(ctx.covered, ctx.groundById, ctx.L, ctx.audience, missing.length ? missing : null);
  };

  async function handleMap() {
    setError(""); setErrRaw(""); setResult(null); setFramed({}); setFramedHidden({}); setFraming(null);
    if (!DEMO_MODE) setManualMode(false); // in demo the panel is a user-opened override, not a fallback
    if (!description.trim() || description.trim().length < 12) { setError(t.needDesc); return; }
    if (jurs.length === 0) { setError(t.needJur); return; }
    const L = resolveLang(lang, description.trim());
    setStage("routing");

    // DEMO_MODE: no network leg at all. Same feature flags, extracted by rule.
    if (DEMO_MODE) {
      const route = localRoute(description.trim(), L);
      if (route.scope === "out") { setResult({ kind: "out", restatement: "" }); setStage("done"); return; }
      await assembleAndFrame(route.features, route.business_restatement, route.scope, L);
      return;
    }

    const r = await callWithRetry((strict) => routerPrompt(description.trim(), L, strict));
    if (!r.ok) { setError(classifyErr(t, r.error)); if (r.error === "PARSE" && r.raw) setErrRaw(r.raw.slice(0, 200)); if (aiEnvDown(r.error)) setAiRuntimeDown(true); setManualMode(true); setStage("error"); return; }
    const route = r.value;

    if (route.scope === "out") { setResult({ kind: "out", restatement: route.business_restatement || "" }); setStage("done"); return; }
    if (route.too_vague === true) { setResult({ kind: "too_vague", restatement: route.business_restatement || "" }); setStage("done"); return; }

    await assembleAndFrame(route.features, route.business_restatement || "", route.scope, L);
  }

  async function handleManualMap() {
    if (jurs.length === 0) { setError(t.needJur); return; }
    setError(""); setErrRaw(""); setResult(null); setFramed({}); setFramedHidden({}); setFraming(null);
    const L = resolveLang(lang, description.trim() || "en");
    await assembleAndFrame(manualFeat, "", "in", L);
  }

  // Apply a user-supplied proxy URL from the degraded-mode banner. On a valid URL we point AI calls
  // at it, clear the runtime-down flag (so aiOff flips back and the normal run button returns), and
  // echo the endpoint. An empty value clears any override and reverts to the bare endpoint.
  function applyProxy() {
    const url = normalizeProxyUrl(proxyInput);
    if (url && !looksLikeProxyUrl(url)) { setError(t.proxyBad); return; }
    setAiProxy(url, true);            // persist: paste it once, not once per session
    setProxyInput(url);               // echo the normalised form so the user sees the slash go
    setProxyApplied(url);
    setAiRuntimeDown(false);
    setError(""); setErrRaw("");
    setFrameErr("");                  // a stale failure banner must not outlive its cause
  }

  const preBusy = stage === "routing" || stage === "retrieving";
  const busy = preBusy || stage === "framing";
  const showResults = (stage === "framing" || stage === "done") && result && result.kind === "ok";
  const pressure = showResults ? result.dims.filter((d) => d.tier === "pressure") : [];
  const baseline = showResults ? result.dims.filter((d) => d.tier !== "pressure") : [];
  const framingActive = framing !== null;
  // AI is "off" for UI purposes if statically disabled up front OR a real call has failed with an
  // environment error this session. Both surface the same banner + manual path.
  // In DEMO_MODE there is no AI leg to be down, so there is nothing to report: the banner,
  // the proxy field and the degraded run button all stay off the screen.
  const aiOff = !DEMO_MODE && (!AI_AVAILABLE || aiRuntimeDown);

  return (
    <div className="wrap">
      <style>{CSS + EVIDENCE_AXES_CSS + EVALUATE_VIEW_CSS}</style>

      <header className="head">
        <div className="head-top">
          <div className="head-kicker">CROSS-BORDER STABLECOIN REGISTER · {DATA.meta.version}</div>
          <div className="ui-lang">{[["zh", "中文"], ["en", "EN"]].map(([v, lbl]) =>
            <button key={v} className={"ui-lang-btn" + (ui === v ? " on" : "")} onClick={() => { setUi(v); try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "cbsr-lang", lang: v }, parentOrigin.current || "*"); } catch (e) {} }}>{lbl}</button>)}</div>
        </div>
        <h1 className="head-title">{t.title}</h1>
        <p className="head-sub">{t.subA}<b className="not-verdict">{t.notVerdict}</b>{t.subB}</p>
        <div className="scope-note">{t.scopeNote}</div>
      </header>

      <Nav view={view} setView={setView} t={t} />
      <SnapshotBanner t={t} ui={ui} sync={sync} />

      {/* The lead view. The other six tour the register's layers; this one is
          the only surface that takes a proposed agent action and returns a
          decision, a receipt, and the evidence the decision rested on. */}
      {view === "evaluate" && <EvaluateView DATA={DATA} ui={ui} />}

      {view === "map" && (<>
      <section className="panel">
        <label className="field-label">{DEMO_MODE ? t.f1Demo : t.f1}</label>
        <textarea className="ta" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t. taPh} />
        <div className="examples"><span className="ex-label">{t.tryL}</span>
          {t.examples.map((ex, i) => <button key={i} className="ex-chip" onClick={() => setDescription(ex.text)}>{ex.label}</button>)}</div>

        {aiOff && (
          <div className="aioff">
            <div className="aioff-top">
              <span className="aioff-tag">{t.aiOffH}</span>
              <span className="aioff-pill">{t.aiOffTag}</span>
            </div>
            <div className="aioff-b">{t.aiOffB}</div>
            <div className="aioff-cfg">
              <label className="aioff-cfg-label">{t.proxyLabel}</label>
              <div className="aioff-cfg-row">
                <input
                  className="aioff-cfg-input"
                  type="url"
                  spellCheck={false}
                  value={proxyInput}
                  onChange={(e) => setProxyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") applyProxy(); }}
                  placeholder={t.proxyPh}
                />
                <button className="aioff-cfg-btn" onClick={applyProxy}>{t.proxyApply}</button>
              </div>
              {proxyApplied
                ? <div className="aioff-cfg-note ok">{t.proxyOn} <code>{proxyApplied}</code>: {t.proxyRetry}</div>
                : <div className="aioff-cfg-note">{t.proxyHint}</div>}
            </div>
            <button className="aioff-jump" onClick={() => { setManualMode(true); }}>{t.aiOffManual} ↓</button>
          </div>
        )}

        {AI_AVAILABLE && !DEMO_MODE && (
        <div className="import">
          <div className="import-title">{t.impA}<b>{t.impBold}</b>{t.impC}</div>
          <div className="import-row">
            <label className="file-btn">{t.fileBtn}<input type="file" accept=".pdf,.txt,.md,.markdown" onChange={onFile} style={{ display: "none" }} /></label>
            {fileName && <span className="file-name">{fileName}</span>}
          </div>
          <div className="import-row">
            <input className="url-in" placeholder={t.urlPh} value={urlInput} onChange={(e) => setUrlInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onUrl(); }} />
            <button className="url-btn" onClick={onUrl} disabled={deriving}>{t.read}</button>
          </div>
          {deriveMsg && <div className={"derive-msg" + (deriving ? "" : " done")}>{deriveMsg}</div>}
        </div>
        )}

        <label className="field-label">{t.f2}</label>
        <div className="jurs">
          {jurList.map((j) => {
            const c = covCount(j), on = jurs.includes(j);
            return (
              <button key={j} className={"jur" + (on ? " jur-on" : "")} onClick={() => toggleJur(j)}>
                <span className="jur-code">{j}{on && <span className="jur-check"> ✓</span>}</span>
                <span className="jur-name">{DATA.jurisdictions[j]}</span>
                <span className={"jur-cov" + (c === 0 ? " jur-cov-0" : "")}>{c === 0 ? t.noCov : c + " " + t.dimsU}</span>
              </button>
            );
          })}
        </div>

        <div className="row-aud">
          <div className="aud-wrap">
            <label className="field-label">{t.f3}</label>
            <div className="aud">
              <button className={"aud-btn" + (audience === "regulator" ? " aud-on" : "")} onClick={() => setAudience("regulator")}><b>{t.audRT}</b><span>{t.audRS}</span></button>
              <button className={"aud-btn" + (audience === "project" ? " aud-on" : "")} onClick={() => setAudience("project")}><b>{t.audPT}</b><span>{t.audPS}</span></button>
            </div>
          </div>
          <div className="lang-wrap">
            <label className="field-label">{t.qLangL}</label>
            <div className="lang">{[["auto", t.qAuto], ["zh", t.qZh], ["en", t.qEn]].map(([v, lbl]) =>
              <button key={v} className={"lang-btn" + (lang === v ? " lang-on" : "")} onClick={() => setLang(v)}>{lbl}</button>)}</div>
          </div>
        </div>

        {!aiOff
          ? <button className="run" onClick={handleMap} disabled={busy || deriving}>{busy ? t.running : t.run}</button>
          : <button className="run run-off" onClick={() => setManualMode(true)} title={t.aiOffH}>{t.aiOffManual} ↓</button>}

        {DEMO_MODE && (
          <button className="refine-toggle" onClick={() => setManualMode((s) => !s)}>
            {manualMode ? t.refineClose : t.refineOpen}
          </button>
        )}

        {preBusy && (
          <div className="proc">
            <div className={"proc-step" + (stage === "routing" ? " act" : " done")}><span className="proc-ico">{stage === "routing" ? <span className="spin" /> : "✓"}</span>{t.procRoute}</div>
            <div className={"proc-step" + (stage === "retrieving" ? " act" : "")}><span className="proc-ico">{stage === "retrieving" ? <span className="spin" /> : "·"}</span>{t.procRetrieveStep}</div>
            <div className="proc-step"><span className="proc-ico">·</span>{t.procFrame}</div>
          </div>
        )}
        {error && <div className="err">{error}{errRaw && <pre className="errraw"><b>{t.rawLabel}</b>{"\n" + errRaw}</pre>}</div>}
              {(manualMode || aiOff) && (
          <div className="manual">
            <div className="manual-h">{DEMO_MODE ? t.manualHDemo : t.manualH}</div>
            <div className="manual-b">{DEMO_MODE ? t.manualBDemo : t.manualB}</div>
            <div className="manual-grid">
              {[["yield", t.mfYield], ["securities_wrapper", t.mfSec], ["lending_or_routing", t.mfLend], ["non_domestic_peg", t.mfPeg], ["cross_border_or_data", t.mfXb], ["custody", t.mfCust]].map(([k, lbl]) => (
                <label key={k} className="manual-opt">
                  <input type="checkbox" checked={!!manualFeat[k]} onChange={(e) => setManualFeat((p) => ({ ...p, [k]: e.target.checked }))} />
                  <span>{lbl}</span>
                </label>
              ))}
            </div>
            <button className="manual-btn" onClick={handleManualMap}>{t.manualBtn}</button>
          </div>
        )}
      </section>

      {stage === "done" && result && (result.kind === "out" || result.kind === "too_vague" || result.kind === "no_coverage") && (
        <div className="results">
          {result.restatement && <div className="restate"><div className="restate-label">{t.restateL}</div><div className="restate-text">{result.restatement}</div></div>}
          <div className="notice">{result.kind === "out" ? t.scopeOut : result.kind === "no_coverage" ? t.scopeNoCov : t.scopeVague}</div>
        </div>
      )}

      {showResults && (
        <section className="results">
          <div className="axes-legend">{t.axesLegend}</div>
          {result.scope === "partial" && <div className="scope-banner">{t.partA}<b>{t.partBold}</b>{t.partC}</div>}

          {result.restatement && (
            <div className="restate"><div className="restate-label">{t.restateL}</div><div className="restate-text">{result.restatement}</div><div className="restate-hint">{t.restateHint}</div></div>
          )}

          {pressure.length > 0 && (
            <div className="ppoints" ref={dirRef}>
              <div className="ppoints-label">{t.ppL}<span className="ppoints-hint">{t.ppHint}</span></div>
              <div className="ppoints-chips">{pressure.map((d) =>
                <button key={d.key} className="ppoint-chip" onClick={() => scrollTo(blockRefs.current[d.key])}>{DATA.dimensions[d.key]}</button>)}</div>
            </div>
          )}

          <div className="res-head"><span className="res-jur">{jurs.join(" · ")}</span>
            <span className="res-meta">{t.resMeta(result.coveredN, result.gapN, result.dims.length, audience)}</span></div>

          {(() => {
            const seen = new Set(); const rows = [];
            for (const a of jurs) for (const b of jurs) { if (a === b) continue; const key = a + ">" + b; if (seen.has(key)) continue; seen.add(key); const e = corridorEdge(a, b); if (e && e.fwd) rows.push({ a, b, c: e.fwd.c, ov: e.fwd.o }); }
            if (!rows.length) return null;
            return (
              <div className="mapcorr">
                <div className="mapcorr-h">{t.navCorr} · {t.corrToday}<button className="mapcorr-link" onClick={() => setView("corridors")}>{t.navCorr} →</button></div>
                <div className="mapcorr-grid">
                  {rows.map((r, i) => (
                    <button key={i} className="mapcorr-cell" onClick={() => { setO(r.a); setD(r.b); setView("corridors"); }}>
                      <span className="mapcorr-pair">{r.a}→{r.b}</span><ClassChip cls={r.c} t={t} ui={ui} />{r.ov && <span className="mapcorr-ov">⚑</span>}
                    </button>
                  ))}
                </div>
                <div className="mapcorr-hint">{t.corrLead}</div>
              </div>
            );
          })()}

          {framingActive && (
            <div className="framebar">
              <div className="framebar-text"><span className="spin" />{t.framingProg(framing.done, framing.total)}</div>
              <div className="framebar-track"><div className="framebar-fill" style={{ width: (framing.total ? (framing.done / framing.total * 100) : 0) + "%" }} /></div>
            </div>
          )}

          {!framingActive && frameErr && frameMissing.length > 0 && (
            <div className="framefail">
              <div className="framefail-h">{t.frameFailH(frameMissing.length)}</div>
              <div className="framefail-b">{classifyErr(t, frameErr)}</div>
              <div className="framefail-keep">{t.frameFailKeep}</div>
              <button className="framefail-btn" onClick={retryFraming}>{t.frameFailRetry}</button>
            </div>
          )}

          {pressure.length > 0 && (
            <div className="tier-sec">
              <div className="tier-head tier-head-p">{t.tierP}</div>
              {pressure.map((d) => <DimBlock key={d.key} dim={d} framed={framed} framedHidden={framedHidden} framingActive={framingActive} audience={audience} t={t} ui={ui}
                blockRef={(el) => { if (el) blockRefs.current[d.key] = el; }} showBack={true} onBack={() => scrollTo(dirRef.current)} />)}
            </div>
          )}
          {baseline.length > 0 && (
            <div className="tier-sec">
              <button className={"tier-head tier-head-b tier-toggle" + (showBaseline ? " open" : "")} onClick={() => setShowBaseline((s) => !s)}>
                <span className="tier-caret">{showBaseline ? "▾" : "▸"}</span>
                <span className="tier-toggle-label">{t.tierB}</span>
                <span className="tier-count">{showBaseline ? t.collapseHint : t.baselineCount(baseline.length, framingActive)}</span>
              </button>
              {showBaseline && baseline.map((d) => <DimBlock key={d.key} dim={d} framed={framed} framedHidden={framedHidden} framingActive={framingActive} audience={audience} t={t} ui={ui} showBack={false} />)}
            </div>
          )}

          <div className="disclaimer">{t.disc} {t.discAsOf}</div>
          <SessionSummary t={t} session={{ nodeDims: result.dims.length, corrPairs: countCorrPairs(jurs), fwdJurs: jurs.filter((j) => COMPUTE.forward[j]).length, struct: !!visited.structure }} />

          <div className="export">
            <button className="export-btn" onClick={() => { const md = buildBriefingMd(result, framed, audience, jurs, ui, t); const ok = downloadText("cbsr-briefing-" + jurs.join("-") + ".md", md); setExported(ok); }}>{t.expBtn}</button>
            <div className="export-note">{exported ? t.expReady : t.expNote}</div>
          </div>

          <div className="seam">
            <div className="seam-h">{t.seamH}</div>
            <div className="seam-b">{t.seamB}</div>
            {CONTACT && <a className="seam-btn" href={CONTACT} target="_blank" rel="noopener noreferrer">{t.seamBtn}</a>}
          </div>
        </section>
      )}

      {stage === "idle" && <div className="empty">{DEMO_MODE ? t.emptyDemo : t.empty}</div>}
      </>)}

      {view === "corridors" && <CorridorExplorer t={t} ui={ui} o={o} d={d} setO={setO} setD={setD} worked={WORKED_CORRIDOR} asOf={asOf} setAsOf={setAsOf} />}
      {view === "substrate" && <SubstrateView t={t} ui={ui} sj={sj} setSj={setSj} sc={sc} setSc={setSc} />}
      {view === "forward" && <ForwardView t={t} ui={ui} fj={fj} setFj={setFj} asOf={asOf} setAsOf={setAsOf} />}
      {view === "structure" && <StructureView t={t} ui={ui} />}
      {view === "agents" && <AgentsView t={t} ui={ui} />}
    </div>
  );
}

const CSS = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

.wrap{ --ink:#191B17; --paper:#EDEFEB; --paper2:#F5F6F2; --rule:#DBDDD4; --slate:#565A50; --accent:#1E3A5F; --verify:#1E3A5F; --gap:#8B8E84;
  max-width:880px; margin:0 auto; padding:28px 22px 64px; background:var(--paper); color:var(--ink); font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
.head{border-bottom:1px solid var(--rule); padding-bottom:18px; margin-bottom:22px;}
.head-top{display:flex; justify-content:space-between; align-items:flex-start; gap:12px;}
.head-kicker{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; letter-spacing:.08em; color:var(--slate); text-transform:uppercase;}
.ui-lang{display:flex; gap:4px; flex-shrink:0;}
.ui-lang-btn{font-size:12px; padding:3px 10px; border:1px solid var(--rule); border-radius:4px; background:#FBFBF9; color:#565A50; cursor:pointer; font-family:inherit;}
.ui-lang-btn.on{border-color:var(--ink); background:var(--ink); color:var(--paper);}
.head-title{font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:30px; font-weight:600; margin:10px 0 6px; letter-spacing:-.01em;}
.head-sub{font-size:14px; line-height:1.6; color:#565A50; margin:0; max-width:720px;}
.not-verdict{color:var(--accent);}

.panel{background:var(--paper2); border:1px solid var(--rule); border-radius:6px; padding:18px 18px 20px; margin-bottom:22px;}
.field-label{display:block; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; letter-spacing:.06em; color:var(--slate); text-transform:uppercase; margin:14px 0 7px;}
.field-label:first-child{margin-top:0;}
.ta{width:100%; box-sizing:border-box; min-height:86px; resize:vertical; padding:11px 12px; border:1px solid var(--rule); border-radius:5px; background:#FBFBF9; color:var(--ink); font-size:14px; line-height:1.55; font-family:inherit;}
.ta:focus{outline:2px solid var(--verify); outline-offset:1px; border-color:var(--verify);}
.examples{display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:9px;}
.ex-label{font-size:12px; color:var(--slate);}
.ex-chip{font-size:12px; padding:4px 10px; border:1px dashed var(--rule); border-radius:14px; background:transparent; color:#565A50; cursor:pointer;}
.ex-chip:hover{border-color:var(--verify); color:var(--verify);}

.import{margin-top:12px; padding:11px 12px; border:1px dashed var(--rule); border-radius:5px; background:#F5F6F2;}
.import-title{font-size:12px; line-height:1.5; color:var(--slate); margin-bottom:9px;} .import-title b{color:var(--accent);}
.import-row{display:flex; align-items:center; gap:9px; margin-top:7px;}
.file-btn{display:inline-block; font-size:12.5px; padding:7px 13px; border:1px solid var(--ink); border-radius:5px; background:#FBFBF9; color:var(--ink); cursor:pointer; font-weight:600;}
.file-btn:hover{background:var(--ink); color:var(--paper);}
.file-name{font-size:11.5px; color:var(--slate); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; word-break:break-all;}
.url-in{flex:1; min-width:160px; box-sizing:border-box; padding:7px 11px; border:1px solid var(--rule); border-radius:5px; background:#FBFBF9; font-size:13px; font-family:inherit; color:var(--ink);}
.url-in:focus{outline:2px solid var(--verify); outline-offset:1px; border-color:var(--verify);}
.url-btn{padding:7px 16px; border:1px solid var(--ink); border-radius:5px; background:#FBFBF9; color:var(--ink); font-size:13px; font-weight:600; cursor:pointer; font-family:inherit;}
.url-btn:hover:not(:disabled){background:var(--ink); color:var(--paper);} .url-btn:disabled{opacity:.5; cursor:default;}
.derive-msg{margin-top:9px; font-size:12px; color:var(--verify); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; line-height:1.5;}
.derive-msg.done{color:var(--accent);}

.jurs{display:flex; flex-wrap:wrap; gap:8px;}
.jur{display:flex; flex-direction:column; align-items:flex-start; gap:1px; padding:7px 11px; border:1px solid var(--rule); border-radius:5px; background:#FBFBF9; cursor:pointer; min-width:96px;}
.jur:hover{border-color:var(--slate);}
.jur-on{border-color:var(--ink); background:var(--ink);}
.jur-on .jur-code,.jur-on .jur-name,.jur-on .jur-cov{color:var(--paper);}
.jur-code{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:14px; font-weight:600;}
.jur-check{color:#7FC79A;} .jur-name{font-size:11px; color:var(--slate);}
.jur-cov{font-size:10px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; color:var(--verify);} .jur-cov-0{color:var(--gap);}

.row-aud{display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start;}
.aud-wrap{flex:1; min-width:280px;}
.aud{display:flex; gap:8px; flex-wrap:wrap;}
.aud-btn{flex:1; min-width:180px; display:flex; flex-direction:column; gap:2px; text-align:left; padding:10px 12px; border:1px solid var(--rule); border-radius:5px; background:#FBFBF9; cursor:pointer;}
.aud-btn b{font-size:14px;} .aud-btn span{font-size:11px; color:var(--slate);}
.aud-btn:hover{border-color:var(--slate);} .aud-on{border-color:var(--ink); box-shadow:inset 0 0 0 1px var(--ink);}
.lang-wrap{min-width:160px;}
.lang{display:flex; gap:6px;}
.lang-btn{padding:9px 13px; border:1px solid var(--rule); border-radius:5px; background:#FBFBF9; cursor:pointer; font-size:13px; color:#565A50; font-family:inherit;}
.lang-btn:hover{border-color:var(--slate);} .lang-on{border-color:var(--ink); background:var(--ink); color:var(--paper);}

.run{margin-top:18px; width:100%; padding:12px; border:none; border-radius:5px; background:var(--ink); color:var(--paper); font-size:15px; font-weight:600; cursor:pointer; letter-spacing:.02em; font-family:inherit;}
.run:hover:not(:disabled){background:#0F1210;} .run:disabled{opacity:.55; cursor:default;}
.refine-toggle{display:block; margin:9px auto 0; padding:2px 4px; border:none; background:none; color:var(--gap); font-family:inherit; font-size:12.5px; cursor:pointer; text-decoration:underline; text-underline-offset:3px;}
.refine-toggle:hover{color:var(--accent);}

.proc{margin-top:12px; display:flex; flex-direction:column; gap:6px;}
.proc-step{display:flex; align-items:center; gap:9px; font-size:13px; color:var(--gap); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;}
.proc-step.act{color:var(--verify);} .proc-step.done{color:var(--accent);}
.proc-ico{display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; font-size:12px;}

.spin{display:inline-block; width:11px; height:11px; border:2px solid #C6C8BF; border-top-color:var(--verify); border-radius:50%; animation:spin .7s linear infinite; vertical-align:middle;}
@keyframes spin{to{transform:rotate(360deg);}}

.err{margin-top:10px; font-size:13px; color:#B23B36; background:#F3E4E3; border:1px solid #E0BDBA; padding:9px 11px; border-radius:5px; line-height:1.55;}
.errraw{margin:8px 0 0; padding:8px 10px; background:#F3E4E3; border:1px solid #E0BDBA; border-radius:4px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:1.45; color:#565A50; white-space:pre-wrap; word-break:break-word;}
.errraw b{display:block; margin-bottom:4px; color:#B23B36;}

.results{margin-top:4px;}
.scope-banner{font-size:13px; line-height:1.6; color:#565A50; background:#F3EAD9; border:1px solid #E5CFA0; border-radius:5px; padding:11px 14px; margin-bottom:14px;} .scope-banner b{color:var(--accent);}
.notice{font-size:14px; line-height:1.6; color:#565A50; background:var(--paper2); border:1px solid var(--rule); border-left:3px solid var(--accent); border-radius:5px; padding:14px 16px;}
.empty{font-size:13px; line-height:1.65; color:var(--slate); padding:6px 2px;}

.restate{background:#FBFBF9; border:1px solid var(--ink); border-radius:6px; padding:14px 16px; margin-bottom:14px;}
.restate-label{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.06em; color:var(--accent); text-transform:uppercase; margin-bottom:6px;}
.restate-text{font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:15.5px; line-height:1.62; color:#191B17;}
.restate-hint{font-size:11px; color:var(--gap); margin-top:8px;}

.ppoints{margin-bottom:16px; scroll-margin-top:14px;}
.ppoints-label{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; letter-spacing:.05em; color:var(--accent); text-transform:uppercase; margin-bottom:7px;}
.ppoints-hint{text-transform:none; letter-spacing:0; color:var(--gap); margin-left:7px; font-size:10px;}
.ppoints-chips{display:flex; flex-wrap:wrap; gap:7px;}
.ppoint-chip{font-size:12.5px; padding:5px 11px; border-radius:4px; background:#F3EAD9; color:#B26B12; border:1px solid #E5CFA0; font-weight:600; cursor:pointer; font-family:inherit; transition:background .12s;}
.ppoint-chip:hover{background:#E5CFA0; border-color:#B26B12;}

.res-head{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; padding-bottom:10px; margin-bottom:14px; border-bottom:1px solid var(--rule);}
.res-jur{font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:21px; font-weight:600;}
.res-meta{font-size:12px; color:var(--slate); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;}

.framebar{position:sticky; top:6px; z-index:5; background:#F3EAD9; border:1px solid #E5CFA0; border-radius:6px; padding:9px 12px; margin-bottom:14px;}
.framebar-text{display:flex; align-items:center; gap:8px; font-size:12.5px; color:#565A50; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; margin-bottom:7px;}
.framebar-track{height:4px; background:#DBDDD4; border-radius:2px; overflow:hidden;}
.framebar-fill{height:100%; background:var(--accent); border-radius:2px; transition:width .3s ease;}

.tier-sec{margin-bottom:18px;}
.tier-head{font-size:12px; font-weight:600; letter-spacing:.02em; padding:6px 0 10px; margin-bottom:4px; border-bottom:1px solid var(--rule);}
.tier-head-p{color:var(--accent);} .tier-head-b{color:var(--gap);}
.tier-toggle{display:flex; align-items:center; gap:8px; width:100%; background:none; cursor:pointer; font-family:inherit; font-size:12px; text-align:left; transition:color .12s;}
.tier-toggle:hover{color:var(--accent);}
.tier-toggle:hover .tier-count{color:var(--accent);}
.tier-caret{font-size:9px; width:10px; display:inline-block; flex-shrink:0;}
.tier-toggle-label{font-weight:600;}
.tier-count{margin-left:auto; font-size:10px; font-weight:400; color:var(--gap); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; letter-spacing:.02em; white-space:nowrap;}

.dim-block{border:1px solid var(--rule); border-radius:6px; background:#FBFBF9; padding:15px 16px; margin-bottom:12px; scroll-margin-top:56px;}
.dim-pressure{border-color:#E0C48F; box-shadow:inset 3px 0 0 #B26B12;}
.dim-head{display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;}
.dim-name{font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:18px; font-weight:600; line-height:1.3;}
.dim-head-right{display:flex; align-items:center; gap:9px; flex-wrap:wrap;}
.backlink{font-size:11px; color:var(--slate); background:none; border:none; cursor:pointer; font-family:inherit; padding:0; text-decoration:underline; text-underline-offset:2px;}
.backlink:hover{color:var(--accent);}
.ptag{font-family:'IBM Plex Sans',-apple-system,system-ui,sans-serif; font-size:10px; font-weight:700; color:#FBFBF9; background:var(--accent); border-radius:3px; padding:1px 6px; margin-right:8px; vertical-align:middle; letter-spacing:.02em;}
.spine{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9px; letter-spacing:.1em; color:var(--accent); border:1px solid #E5CFA0; background:#F3EAD9; border-radius:3px; padding:1px 5px; margin-left:8px; vertical-align:middle;}
.dim-reason{font-size:12.5px; color:var(--slate); margin:8px 0 12px; line-height:1.5;}
.why-label{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.05em; color:var(--accent); text-transform:uppercase; margin-right:8px;}
.dim-jurs{display:flex; flex-direction:column; gap:10px;}

.jsub{border-radius:5px; padding:12px 13px;}
.jsub-rec{background:var(--paper2); border:1px solid var(--rule);}
.jsub-gap{background:transparent; border:1px dashed var(--rule);}
.jsub-head{display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:9px;}
.jbadge{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:13px; font-weight:700; color:var(--paper); background:var(--ink); border-radius:3px; padding:2px 9px; letter-spacing:.03em;}
.jbadge-gap{background:var(--gap);}
.jsub-tags{display:flex; gap:6px; flex-wrap:wrap;}
.jsub-req{font-size:13.5px; line-height:1.6; margin:0 0 11px; color:#191B17;}
.jsub-prov{background:#FBFBF9; border:1px solid var(--rule); border-radius:4px; padding:8px 10px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:1.5;}
.prov-row{display:flex; gap:9px; padding:1px 0;}
.prov-k{color:var(--accent); flex:0 0 58px; text-transform:uppercase; font-size:9.5px; padding-top:1px;}
.prov-v{color:#191B17; word-break:break-word;} .prov-v.dim{color:var(--slate);}
.gap-body{font-size:12.5px; line-height:1.55; color:#565A50;}

.tension{margin-top:10px; padding:9px 11px; background:#F3EAD9; border:1px solid #E5CFA0; border-radius:5px; font-size:12px; line-height:1.55;}
.tension-label{display:block; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; letter-spacing:.06em; color:var(--accent); text-transform:uppercase; margin-bottom:4px;}
.tension-text{color:#565A50;} .tension-chan{display:block; margin-top:5px; color:var(--slate); font-size:11px;}

.qbox{margin-top:11px; border-top:1px dashed var(--rule); padding-top:10px;}
.qbox-label{display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; font-size:12.5px; font-weight:600; color:var(--ink); margin-bottom:7px;}
.qbox-src{font-weight:400; font-size:9.5px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; color:var(--gap); letter-spacing:.02em;}
.qlist{margin:0; padding-left:19px;} .qlist li{font-size:13px; line-height:1.58; color:#191B17; margin-bottom:5px;}
.q-loading{display:flex; align-items:center; gap:7px; font-size:12px; color:var(--verify); font-style:italic;}
.q-pending{font-size:12px; color:var(--gap); font-style:italic;}

.disclaimer{margin-top:20px; font-size:11.5px; line-height:1.65; color:var(--slate); background:var(--paper2); border:1px solid var(--rule); border-radius:6px; padding:13px 15px;}

/* Corridor panel — the differentiator layer; visually the highest-value block. */
.corridor{border:1px solid var(--rule); border-left:3px solid var(--accent); border-radius:8px; padding:16px 17px 17px; margin-bottom:22px; background:#FBFBF9;}
.corridor-head{display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;}
.corridor-title{font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:18px; font-weight:600; color:var(--ink);}
.corridor-legs{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:13px; font-weight:600; color:var(--accent); margin-left:10px; letter-spacing:.03em;}
.corridor-hint{font-size:12px; line-height:1.55; color:var(--slate); margin:7px 0 12px;}
.corridor-flow{display:flex; gap:9px; font-size:12.5px; line-height:1.5; margin-bottom:13px;}
.corridor-k{flex:0 0 auto; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--accent); padding-top:2px;}
.corridor-flow-v{color:#191B17;}
.corridor-legs-grid{display:flex; flex-direction:column; gap:11px;}
.leg{border:1px solid var(--rule); border-radius:6px; padding:11px 12px; background:#FBFBF9;}
.leg-pending{background:#F5F6F2; border-style:dashed;}
.leg-head{display:flex; align-items:center; gap:8px; margin-bottom:8px;}
.leg-row{display:flex; gap:10px; padding:3px 0; font-size:12.5px; line-height:1.55;}
.leg-k{flex:0 0 88px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--slate); padding-top:2px;}
.leg-k-clear{color:#1E3A5F;} .leg-k-break{color:#B23B36;}
.leg-v{color:#191B17; word-break:break-word;} .leg-v .pend{color:var(--gap); font-style:italic;}
/* [v0.11.2 新增] 段内子关口 (leg.sub_gates) 与段级出处的排版。 */
.leg-gate{display:block; margin-bottom:8px;}
.leg-gate:last-child{margin-bottom:0;}
.leg-gate-l{display:block; font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:12px; font-weight:600; color:var(--accent); margin-bottom:2px;}
.leg-gate-r{display:block;}
.leg-gate-a{display:block; margin-top:3px; padding-left:9px; border-left:2px solid var(--rule); color:var(--slate);}
.leg-src{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:1.5; color:var(--slate);}
.corridor-key{margin-top:13px; padding:11px 13px; background:var(--ink); color:var(--paper); border-radius:6px; font-size:13px; line-height:1.6;}
.corridor-key-label{display:block; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; letter-spacing:.06em; color:#B9BCB2; text-transform:uppercase; margin-bottom:5px;}
.corridor-uslink{display:flex; gap:9px; margin-top:11px; font-size:12px; line-height:1.55; color:#565A50;}
.corridor-src{display:flex; gap:9px; margin-top:9px; font-size:11px; line-height:1.5; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; color:var(--slate);}
.corridor-src-v .src-pend{color:var(--gap); font-style:italic;}
@media (max-width:520px){ .head-title{font-size:25px;} .aud-btn{min-width:100%;} .leg-k{flex-basis:64px;} }

/* ---- evidence axes / citable badge / official link / seam / sync (v0.10.1 update) ---- */
.axes{ display:flex; flex-wrap:wrap; gap:6px 14px; margin:6px 0 2px; }
.axis{ display:inline-flex; align-items:baseline; gap:5px; font-size:11px; line-height:1.5; }
.axis-k{ color:var(--slate); text-transform:uppercase; letter-spacing:.04em; font-size:9.5px; }
.axis-v{ color:var(--ink); font-weight:600; }
.axis-v.ax-strong{ color:var(--verify); }
.axis-v.ax-legal{ color:#191B17; }
.axis-v.ax-op{ color:var(--accent); }
.citable-badge{ display:inline-block; font-size:10.5px; font-weight:700; letter-spacing:.02em;
  color:#245C3C; background:#E7F0EA; border:1px solid #C9E4D0; border-radius:5px; padding:1px 7px; margin-right:2px; }
.src-link{ color:var(--verify); text-decoration:none; border-bottom:1px solid #CDD8E4; }
.src-link:hover{ border-bottom-color:var(--verify); }
.axes-legend{ font-size:11.5px; line-height:1.5; color:var(--slate); background:var(--paper2);
  border:1px solid var(--rule); border-radius:7px; padding:8px 11px; margin:0 0 14px; }
.sync{ font-weight:600; }
.sync-ok{ color:var(--verify); }
.sync-off,.sync-wait{ color:var(--slate); }
.seam{ margin-top:18px; padding:15px 16px; border:1px solid var(--rule); border-left:3px solid var(--verify);
  border-radius:8px; background:var(--paper2); }
.seam-h{ font-weight:700; font-size:14px; color:var(--ink); margin-bottom:4px; }
.seam-b{ font-size:12.5px; line-height:1.6; color:var(--slate); }
.seam-btn{ display:inline-block; margin-top:11px; padding:8px 15px; font-size:13px; font-weight:600;
  color:#FBFBF9; background:var(--verify); border-radius:7px; text-decoration:none; }
.seam-btn:hover{ background:#24406A; }

/* ---- scope note / as-of / manual no-AI fallback (v2 review pass) ---- */
.scope-note{ font-size:11.5px; line-height:1.55; color:var(--slate); margin-top:9px; padding-top:9px; border-top:1px dashed var(--rule); }
.asof{ color:var(--accent); font-weight:600; }
.manual{ margin-top:12px; padding:14px 15px; border:1px solid var(--rule); border-left:3px solid var(--accent); border-radius:8px; background:var(--paper2); }
.manual-h{ font-weight:700; font-size:13.5px; color:var(--ink); margin-bottom:4px; }
.manual-b{ font-size:12px; line-height:1.55; color:var(--slate); margin-bottom:10px; }
.manual-grid{ display:grid; grid-template-columns:1fr; gap:7px; }
.manual-opt{ display:flex; gap:8px; align-items:flex-start; font-size:12.5px; color:var(--ink); cursor:pointer; }
.manual-opt input{ margin-top:3px; flex:none; }
.manual-btn{ margin-top:12px; padding:8px 15px; font-size:13px; font-weight:600; color:#FBFBF9; background:var(--accent); border:none; border-radius:7px; cursor:pointer; }
.manual-btn:hover{ background:#B26B12; }
.aioff{ margin:14px 0 4px; padding:13px 15px; border:1px solid #CDD8E4; border-left:3px solid var(--verify); border-radius:8px; background:#E6EBF1; }
.aioff-top{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:7px; }
.aioff-tag{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.08em; text-transform:uppercase; font-weight:600; color:#FBFBF9; background:var(--verify); padding:2px 8px; border-radius:3px; }
.aioff-pill{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.03em; color:var(--verify); border:1px solid #CDD8E4; background:#FBFBF9; padding:1px 7px; border-radius:10px; }
.aioff-b{ font-size:12px; line-height:1.6; color:#3A4E63; margin-bottom:10px; }
.aioff-jump{ font-size:12.5px; font-weight:600; color:#FBFBF9; background:var(--verify); border:none; border-radius:7px; padding:7px 14px; cursor:pointer; }
.aioff-jump:hover{ background:#24406A; }
.aioff-cfg{ margin:2px 0 12px; padding-top:11px; border-top:1px dashed #CDD8E4; }
.aioff-cfg-label{ display:block; font-size:11.5px; font-weight:600; color:#3A4E63; margin-bottom:6px; }
.aioff-cfg-row{ display:flex; gap:7px; flex-wrap:wrap; }
.aioff-cfg-input{ flex:1 1 240px; min-width:0; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; padding:7px 9px; border:1px solid #CDD8E4; border-radius:6px; background:#FBFBF9; color:var(--ink); }
.aioff-cfg-input:focus{ outline:none; border-color:var(--verify); box-shadow:0 0 0 2px rgba(30,58,95,.14); }
.aioff-cfg-btn{ flex:0 0 auto; font-size:12.5px; font-weight:600; color:#FBFBF9; background:var(--verify); border:none; border-radius:6px; padding:7px 15px; cursor:pointer; }
.aioff-cfg-btn:hover{ background:#24406A; }
.aioff-cfg-note{ font-size:11px; line-height:1.55; color:#565A50; margin-top:6px; }
.aioff-cfg-note.ok{ color:#1E3A5F; }
.aioff-cfg-note code{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; background:#E6EBF1; padding:1px 5px; border-radius:3px; word-break:break-all; }
.run-off{ background:var(--verify); }
.run-off:hover{ background:#24406A; }
@media (prefers-reduced-motion: reduce){
  .spin{ animation-duration:0.01ms !important; animation-iteration-count:1 !important; }
  .framebar-fill{ transition:none !important; }
}

/* ---- hidden-question hint + corridor demo (v3 follow-up pass) ---- */
.q-hidden{ margin-top:6px; font-size:11px; color:var(--slate); font-style:italic; }
.corridor-head-tags{ display:flex; gap:6px; align-items:center; }
.corridor-demo-note{ margin:7px 0 2px; font-size:11.5px; line-height:1.5; color:#B26B12; background:#FBFBF9; border:1px solid #E5CFA0; border-radius:6px; padding:6px 9px; }

/* ── v6 layer-coverage additions ───────────────────────────────────────────── */
/* feasibility-class palette (muted, paper-native — no neon) */
.wrap{ --c-open:#2E7D46; --c-open-bg:#E7F0EA; --c-open-bd:#C9E4D0;
  --c-chan:#B26B12; --c-chan-bg:#F3EAD9; --c-chan-bd:#E5CFA0;
  --c-unre:#565A50; --c-unre-bg:#ECEDE9; --c-unre-bd:#C6C8BF;
  --c-trans:#1E3A5F; --c-trans-bg:#E6EBF1; --c-trans-bd:#CDD8E4;
  --c-block:#B23B36; --c-block-bg:#F3E4E3; --c-block-bd:#E0BDBA;
  --c-pre:#8B8E84; --c-pre-bg:#EFF0EC; --c-pre-bd:#DBDDD4; }

/* nav */
.nav{ display:flex; gap:4px; flex-wrap:wrap; margin-bottom:16px; border-bottom:1px solid var(--rule); padding-bottom:2px; }
.nav-btn{ display:flex; flex-direction:column; gap:1px; padding:8px 13px 9px; border:1px solid transparent; border-bottom:none; border-radius:5px 5px 0 0; background:transparent; cursor:pointer; font-family:inherit; text-align:left; margin-bottom:-1px; }
.nav-btn:hover{ background:var(--paper2); }
.nav-btn-t{ font-size:14px; font-weight:600; color:#565A50; letter-spacing:-.005em; }
.nav-btn-s{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; letter-spacing:.04em; color:var(--slate); text-transform:uppercase; }
.nav-on{ background:var(--paper2); border-color:var(--rule); }
.nav-on .nav-btn-t{ color:var(--ink); }
.nav-on{ position:relative; }
.nav-on::after{ content:""; position:absolute; left:0; right:0; top:-1px; height:2px; background:var(--accent); border-radius:2px; }

/* snapshot / liveness banner */
.snapbar{ border:1px solid var(--c-chan-bd); background:#F5F6F2; border-left:3px solid var(--accent); border-radius:5px; padding:9px 13px; margin-bottom:22px; }
.snapbar-live{ border-color:var(--c-open-bd); background:#E7F0EA; border-left-color:var(--c-open); }
.snapbar-fallback{ border-color:#E4C99D; background:#FFF8EC; border-left-color:#B26B12; }
.snapbar-fallback .snapbar-tag{ background:#B26B12; }
.snapbar-fallback .snapbar-disc{ color:#7B4A0A; }
.snapbar-top{ display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; }
.snapbar-tag{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.09em; text-transform:uppercase; font-weight:600; color:#FBFBF9; background:var(--accent); padding:2px 8px; border-radius:3px; }
.snapbar-tag-live{ background:var(--c-open); }
.snapbar-meta{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--slate); letter-spacing:.02em; }
.snapbar-disc{ font-size:12px; line-height:1.55; color:#565A50; margin-top:6px; }
.snapbar-live .snapbar-disc{ color:#2E7D46; }

/* generic view scaffolding */
.view{ margin-bottom:22px; }
.view-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:22px; font-weight:600; letter-spacing:-.01em; margin:2px 0 8px; color:var(--ink); }
.view-lead{ font-size:13.5px; line-height:1.65; color:#565A50; margin:0 0 20px; max-width:760px; }

/* feasibility class chip */
.cls-chip{ display:inline-block; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:600; letter-spacing:.03em; padding:2px 9px; border-radius:3px; white-space:nowrap; border:1px solid; }
.cls-big{ font-size:15px; padding:4px 14px; letter-spacing:.02em; }
.cls-open{ color:var(--c-open); background:var(--c-open-bg); border-color:var(--c-open-bd); }
.cls-chan{ color:var(--c-chan); background:var(--c-chan-bg); border-color:var(--c-chan-bd); }
.cls-unre{ color:var(--c-unre); background:var(--c-unre-bg); border-color:var(--c-unre-bd); }
.cls-trans{ color:var(--c-trans); background:var(--c-trans-bg); border-color:var(--c-trans-bd); }
.cls-block{ color:var(--c-block); background:var(--c-block-bg); border-color:var(--c-block-bd); }
.cls-pre{ color:var(--c-pre); background:var(--c-pre-bg); border-color:var(--c-pre-bd); }

/* class legend */
.clslegend{ border:1px solid var(--rule); border-radius:6px; background:var(--paper2); padding:14px 15px; margin-top:20px; }
.clslegend-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--slate); margin-bottom:11px; }
.clslegend-grid{ display:flex; flex-direction:column; gap:7px; }
.clslegend-row{ display:flex; align-items:flex-start; gap:10px; }
.clslegend-row .cls-chip{ flex-shrink:0; min-width:74px; text-align:center; }
.clslegend-m{ font-size:12px; line-height:1.5; color:#565A50; }
.clslegend-hint{ font-size:11.5px; line-height:1.55; color:var(--slate); margin-top:11px; padding-top:10px; border-top:1px dashed var(--rule); }

/* corridor explorer */
.corr-pick{ display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; }
.corr-pick-col{ flex:1; min-width:0; }
.corr-arrow{ font-size:22px; color:var(--accent); align-self:center; padding-top:18px; flex-shrink:0; }
.corr-jur-grid{ display:grid; grid-template-columns:repeat(6,1fr); gap:5px; }
.corr-jbtn{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:600; padding:7px 0; border:1px solid var(--rule); border-radius:4px; background:#FBFBF9; color:#565A50; cursor:pointer; }
.corr-jbtn:hover{ border-color:var(--verify); }
.corr-jbtn.on{ background:var(--ink); color:var(--paper); border-color:var(--ink); }
.corr-ex{ display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:16px; }
.corr-ex-label{ font-size:11px; color:var(--slate); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; text-transform:uppercase; letter-spacing:.05em; }
.corr-ex-chip{ display:inline-flex; align-items:center; gap:6px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:600; padding:4px 9px; border:1px dashed var(--rule); border-radius:14px; background:transparent; color:#565A50; cursor:pointer; }
.corr-ex-chip:hover{ border-color:var(--accent); color:var(--accent); }
.corr-ex-tag{ font-size:9.5px; font-weight:400; color:var(--slate); text-transform:uppercase; letter-spacing:.03em; }
.corr-empty{ padding:22px; text-align:center; color:var(--slate); font-size:13px; border:1px dashed var(--rule); border-radius:6px; background:var(--paper2); }
.corr-result{ border:1px solid var(--ink); border-radius:7px; overflow:hidden; background:#FBFBF9; }
.corr-main{ padding:16px 18px 15px; border-bottom:1px solid var(--rule); background:var(--paper2); }
.corr-dir-head{ display:flex; align-items:center; gap:12px; }
.corr-dir-pair{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:19px; font-weight:700; color:var(--ink); letter-spacing:.03em; }
.corr-mean{ font-size:13px; line-height:1.55; color:#565A50; margin-top:9px; }
.corr-ovr{ font-size:11.5px; color:var(--c-block); margin-top:7px; font-weight:600; }
.corr-side{ padding:13px 18px; display:flex; flex-direction:column; gap:9px; }
.corr-side-row{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.corr-side-k{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--slate); min-width:120px; }
.corr-asym{ font-size:10.5px; color:var(--accent); font-weight:600; }
.corr-undir-v{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:13px; color:var(--ink); font-weight:600; }
.bloc-chip{ display:inline-block; font-size:11.5px; padding:2px 9px; border-radius:3px; border:1px solid; line-height:1.5; }
.bloc-open{ color:var(--c-open); background:var(--c-open-bg); border-color:var(--c-open-bd); }
.bloc-chan{ color:var(--c-chan); background:var(--c-chan-bg); border-color:var(--c-chan-bd); }
.bloc-trans{ color:var(--c-trans); background:var(--c-trans-bg); border-color:var(--c-trans-bd); }
.bloc-unre{ color:var(--c-unre); background:var(--c-unre-bg); border-color:var(--c-unre-bd); }
.bloc-block{ color:var(--c-block); background:var(--c-block-bg); border-color:var(--c-block-bd); }
.corr-time{ padding:13px 18px; border-top:1px solid var(--rule); }
.corr-time-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--slate); margin-bottom:9px; }
.corr-trans{ display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.corr-trans-dt{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:var(--ink); font-weight:600; min-width:96px; }
.corr-trans-arr{ color:var(--accent); font-weight:700; }
.corr-none{ font-size:12px; color:var(--slate); font-style:italic; }
.corr-wi{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:7px; padding:6px 9px; background:var(--paper2); border-radius:4px; }
.corr-wi-trig{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--accent); font-weight:600; }
.corr-wi-mv{ display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#565A50; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; }
.corr-worked{ margin-top:22px; }
.corr-worked-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:16px; font-weight:600; color:var(--ink); margin-bottom:6px; }
.corr-worked-hint{ font-size:12px; line-height:1.6; color:var(--slate); margin-bottom:12px; padding:9px 11px; background:var(--paper2); border-left:2px solid var(--gap); border-radius:0 4px 4px 0; }

/* map-view computed-corridor nudge */
.mapcorr{ border:1px solid var(--rule); border-radius:6px; padding:13px 15px; margin:16px 0; background:#FBFBF9; }
.mapcorr-h{ display:flex; align-items:center; gap:9px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:var(--slate); margin-bottom:11px; }
.mapcorr-link{ margin-left:auto; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--accent); background:none; border:none; cursor:pointer; letter-spacing:.03em; }
.mapcorr-link:hover{ text-decoration:underline; }
.mapcorr-grid{ display:flex; flex-wrap:wrap; gap:7px; }
.mapcorr-cell{ display:inline-flex; align-items:center; gap:7px; padding:5px 9px; border:1px solid var(--rule); border-radius:5px; background:var(--paper2); cursor:pointer; }
.mapcorr-cell:hover{ border-color:var(--ink); }
.mapcorr-pair{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:700; color:var(--ink); }
.mapcorr-ov{ color:var(--c-block); font-size:11px; }
.mapcorr-hint{ font-size:11.5px; line-height:1.55; color:var(--slate); margin-top:11px; }

/* forward view */
.fwd-sec{ margin-bottom:26px; }
.fwd-sec-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:17px; font-weight:600; color:var(--ink); margin-bottom:5px; }
.fwd-sec-hint{ font-size:12.5px; line-height:1.6; color:var(--slate); margin-bottom:12px; max-width:740px; }
.sens-finding{ font-size:13px; line-height:1.6; color:#565A50; padding:11px 13px; background:var(--paper2); border-left:3px solid var(--accent); border-radius:0 4px 4px 0; margin-bottom:14px; }
.sens-two{ border:1px dashed var(--rule); border-radius:6px; padding:11px 13px; margin-bottom:14px; background:#FBFBF9; }
.sens-two-h{ font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--accent); margin-bottom:8px; }
.sens-two-row{ display:flex; gap:10px; align-items:baseline; padding:3px 0; font-size:12.5px; }
.sens-two-k{ flex:0 0 128px; color:var(--slate); font-weight:600; }
.sens-two-v{ flex:1; color:#2E322C; font-variant-numeric:tabular-nums; }
.sens-two-note{ font-size:11.5px; line-height:1.55; color:var(--slate); margin-top:7px; padding-top:7px; border-top:1px solid var(--rule); }
.sens-grid{ display:flex; flex-direction:column; gap:10px; }
.sens-card{ border:1px solid var(--rule); border-radius:6px; padding:13px 15px; background:#FBFBF9; }
.sens-top{ display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; margin-bottom:8px; }
.sens-rank{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:15px; font-weight:700; color:var(--accent); }
.sens-jur{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:15px; font-weight:700; color:var(--ink); }
.sens-jurname{ font-size:12px; color:var(--slate); }
.sens-both{ font-size:10px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; text-transform:uppercase; letter-spacing:.04em; color:#FBFBF9; background:var(--verify); padding:1px 7px; border-radius:3px; margin-left:auto; }
.sens-edges{ font-size:13px; color:#565A50; margin-bottom:5px; }
.sens-edges b{ font-size:16px; color:var(--ink); }
.sens-fan{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--slate); margin-left:9px; }
.sens-res{ font-size:12px; color:#565A50; margin-bottom:6px; }
.sens-note{ font-size:12px; line-height:1.55; color:var(--slate); }
.sens-insens{ display:flex; flex-direction:column; gap:7px; margin-top:12px; }
.sens-in{ display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; padding:8px 11px; border:1px dashed var(--rule); border-radius:5px; background:var(--paper2); }
.sens-in-jur{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:13px; font-weight:700; color:var(--c-unre); }
.sens-in-lbl{ font-size:11px; color:var(--slate); text-transform:uppercase; letter-spacing:.03em; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; }
.sens-in-note{ font-size:11.5px; line-height:1.5; color:var(--slate); flex-basis:100%; }
.fwd-disagree{ margin-top:14px; font-size:12px; line-height:1.6; color:#565A50; padding:10px 12px; background:#F5F6F2; border:1px solid var(--c-chan-bd); border-radius:5px; }
.fwd-disagree-lbl{ display:block; font-weight:600; color:var(--accent); margin-bottom:4px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
.regtable-wrap{ overflow-x:auto; border:1px solid var(--rule); border-radius:6px; }
.regtable{ width:100%; border-collapse:collapse; font-size:12px; min-width:560px; }
.regtable th{ text-align:left; padding:8px 10px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); background:var(--paper2); border-bottom:1px solid var(--rule); }
.regtable td{ padding:8px 10px; border-bottom:1px solid var(--rule); vertical-align:top; line-height:1.45; color:#565A50; }
.regtable tr:last-child td{ border-bottom:none; }
.reg-moves{ background:#F5F6F2; }
.reg-j .jbadge{ margin:0; }
.reg-k{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--ink); font-weight:600; }
.reg-cls-move{ color:var(--ink); font-weight:600; }
.reg-cert{ color:var(--slate); font-size:11px; }
.fwd-jur-pick{ margin-bottom:14px; }
.fwd-jur-pick-l{ display:block; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); margin-bottom:8px; }
.fwd-jur-grid{ display:grid; grid-template-columns:repeat(6,1fr); gap:5px; max-width:440px; }
.fwd-jur-read{ border:1px solid var(--ink); border-radius:7px; padding:15px 17px; background:#FBFBF9; }
.fwd-jr-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); margin-bottom:9px; }
.fwd-jur-events{ margin-bottom:15px; }
.fwd-ev{ border:1px solid var(--rule); border-left:3px solid var(--gap); border-radius:0 5px 5px 0; padding:10px 12px; margin-bottom:8px; background:var(--paper2); }
.fwd-ev-move{ border-left-color:var(--accent); }
.fwd-ev-access{ border-left-color:var(--verify); }
.fwd-ev-top{ display:flex; align-items:center; gap:9px; margin-bottom:6px; }
.fwd-ev-tag{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; font-weight:600; padding:2px 8px; border-radius:3px; }
.tag-move{ color:#FBFBF9; background:var(--accent); }
.tag-access{ color:#FBFBF9; background:var(--verify); }
.tag-none{ color:var(--slate); background:var(--paper); border:1px solid var(--rule); }
.fwd-ev-date{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--ink); font-weight:600; }
.fwd-ev-title{ font-size:12.5px; line-height:1.5; color:#565A50; }
.fwd-ev-accnote{ font-size:11.5px; line-height:1.55; color:#2E7D46; margin-top:7px; padding-top:7px; border-top:1px dashed var(--c-trans-bd); }
.fwd-jr-cols{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px; }
.fwd-jr-col{ min-width:0; }
.fwd-edge{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:6px; padding:5px 8px; background:var(--paper2); border-radius:4px; }
.fwd-edge-cp{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:600; color:var(--ink); }
.fwd-edge-arr{ color:var(--accent); }
.fwd-edge-via{ font-size:10px; color:var(--slate); flex-basis:100%; }
.fwd-exp{ margin-bottom:14px; }
.fwd-exp-chips{ display:flex; flex-wrap:wrap; gap:6px; }
.fwd-exp-chip{ display:inline-flex; align-items:center; gap:5px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; padding:3px 9px; border:1px solid var(--rule); border-radius:12px; background:var(--paper2); color:#565A50; }
.fwd-exp-chip b{ color:var(--ink); }
.fwd-supervisor{ font-size:12.5px; line-height:1.6; color:#565A50; padding:11px 13px; background:var(--paper2); border-radius:5px; border-left:2px solid var(--ink); }

/* structure view */
.struct-sec{ margin-bottom:28px; padding-bottom:24px; border-bottom:1px solid var(--rule); }
.struct-sec:last-child{ border-bottom:none; }
.struct-sec-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:18px; font-weight:600; color:var(--ink); margin-bottom:7px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.struct-lead{ font-size:12.5px; line-height:1.65; color:#565A50; margin-bottom:14px; max-width:750px; }
.struct-note{ font-size:12px; line-height:1.6; color:var(--slate); margin-top:13px; padding:10px 12px; background:var(--paper2); border-radius:5px; }
.tier2-badge{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; text-transform:uppercase; letter-spacing:.03em; color:var(--gap); background:var(--paper2); border:1px dashed var(--rule); padding:2px 8px; border-radius:3px; font-weight:400; }
.recon-stat{ display:flex; gap:14px; margin-bottom:16px; }
.recon-big{ flex:1; text-align:center; border:1px solid var(--c-open-bd); background:var(--c-open-bg); border-radius:7px; padding:15px; }
.recon-big b{ display:block; font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:30px; font-weight:700; color:var(--c-open); line-height:1; }
.recon-big span{ display:block; font-size:11px; color:#2E7D46; margin-top:6px; letter-spacing:.02em; }
.recon-find{ border-color:var(--c-chan-bd); background:var(--c-chan-bg); }
.recon-find b{ color:var(--accent); }
.recon-find span{ color:#565A50; }
.recon-findings{ display:flex; flex-direction:column; gap:8px; }
.recon-f{ display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; padding:9px 12px; border:1px solid var(--c-chan-bd); border-radius:5px; background:#F5F6F2; }
.recon-f-pair{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:13px; font-weight:700; color:var(--ink); }
.recon-f-cmp{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:#565A50; }
.recon-f-cmp b{ color:var(--accent); }
.recon-f-cause{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--slate); margin-left:auto; }
.setl-blocs{ display:grid; grid-template-columns:1fr 1fr; gap:11px; margin-bottom:14px; }
.setl-bloc{ border:1px solid; border-radius:6px; padding:12px 14px; }
.setl-open{ border-color:var(--c-open-bd); background:var(--c-open-bg); }
.setl-chan{ border-color:var(--c-chan-bd); background:var(--c-chan-bg); }
.setl-trans{ border-color:var(--c-trans-bd); background:var(--c-trans-bg); }
.setl-unre{ border-color:var(--c-unre-bd); background:var(--c-unre-bg); }
.setl-bloc-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:600; letter-spacing:.02em; color:var(--ink); margin-bottom:9px; }
.setl-bloc-members{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
.setl-member{ display:inline-flex; align-items:baseline; gap:4px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:700; color:var(--ink); background:#FBFBF9; padding:2px 7px; border-radius:3px; border:1px solid #FBFBF9; }
.setl-member-n{ font-size:9.5px; font-weight:400; color:var(--slate); }
.setl-exp{ font-size:11px; line-height:1.5; color:#565A50; margin-top:2px; }
.setl-counts{ display:flex; flex-wrap:wrap; align-items:center; gap:9px; margin-bottom:12px; padding:10px 12px; background:var(--paper2); border-radius:5px; }
.setl-counts-l{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--slate); }
.setl-count{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:#565A50; }
.setl-count b{ color:var(--ink); }
.setl-corr{ font-size:12px; line-height:1.6; color:#565A50; padding:10px 12px; background:#F5F6F2; border:1px solid var(--c-chan-bd); border-radius:5px; margin-bottom:10px; }
.setl-corr-l{ font-weight:600; color:var(--accent); margin-right:6px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; }
.setl-finding{ font-size:12.5px; line-height:1.6; color:#565A50; }
.conv-cells{ display:grid; grid-template-columns:repeat(3,1fr); gap:11px; margin-bottom:6px; }
.conv-cell{ border:1px solid var(--rule); border-radius:6px; padding:12px 13px; background:#FBFBF9; }
.conv-anchor{ border-color:var(--c-open-bd); background:var(--c-open-bg); }
.conv-counter{ border-color:var(--c-block-bd); background:var(--c-block-bg); }
.conv-cell-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--slate); margin-bottom:7px; }
.conv-cell-j{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:13px; font-weight:700; color:var(--ink); margin-bottom:8px; }
.conv-cell-axes{ display:flex; flex-wrap:wrap; gap:4px; }
.conv-cell-txt{ font-size:11.5px; line-height:1.5; color:#565A50; }

/* agents view */
.ag-sample{ border:1px solid var(--ink); border-radius:7px; padding:15px 17px; margin-bottom:22px; background:#FBFBF9; }
.ag-sample-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); margin-bottom:11px; }
.ag-call{ display:flex; align-items:center; gap:11px; flex-wrap:wrap; margin-bottom:11px; }
.ag-call-code{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:14px; font-weight:700; color:var(--ink); background:var(--paper2); padding:4px 11px; border-radius:4px; border:1px solid var(--rule); }
.ag-call-arrow{ color:var(--accent); font-size:16px; font-weight:700; }
.ag-call-ret{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:var(--c-open); background:var(--c-open-bg); padding:4px 10px; border-radius:4px; border:1px solid var(--c-open-bd); }
.ag-sample-desc{ font-size:12.5px; line-height:1.6; color:#565A50; margin-bottom:8px; }
.ag-sample-note{ font-size:11.5px; line-height:1.6; color:var(--slate); padding-top:9px; border-top:1px dashed var(--rule); }
.ag-surface-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:17px; font-weight:600; color:var(--ink); margin-bottom:12px; }
.ag-layers{ display:flex; flex-direction:column; gap:11px; margin-bottom:22px; }
.ag-layer{ border:1px solid var(--rule); border-radius:6px; overflow:hidden; }
.ag-layer-head{ display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; padding:9px 13px; background:var(--paper2); border-bottom:1px solid var(--rule); }
.ag-layer-name{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:700; color:var(--ink); letter-spacing:.02em; }
.ag-layer-count{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; color:#FBFBF9; background:var(--slate); padding:1px 7px; border-radius:9px; font-weight:600; }
.ag-layer-who{ margin-left:auto; font-size:11px; color:#565A50; }
.ag-who-l{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--slate); }
.ag-tools{ padding:6px 13px 10px; }
.ag-tool{ display:flex; gap:11px; align-items:baseline; padding:6px 0; border-bottom:1px dotted var(--rule); }
.ag-tool:last-child{ border-bottom:none; }
.ag-tool-n{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:600; color:var(--accent); flex-shrink:0; min-width:150px; }
.ag-tool-s{ font-size:11.5px; line-height:1.5; color:#565A50; }
.ag-guard{ border:1px solid var(--rule); border-radius:6px; padding:13px 15px; background:var(--paper2); }
.ag-guard-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); margin-bottom:9px; }
.ag-guard-list{ margin:0; padding-left:18px; }
.ag-guard-list li{ font-size:12px; line-height:1.6; color:#565A50; margin-bottom:5px; }

/* export + session (map results) */
.sess{ margin-top:20px; border:1px solid var(--rule); border-radius:6px; padding:12px 14px; background:var(--paper2); }
.sess-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); margin-bottom:9px; }
.sess-items{ display:flex; flex-wrap:wrap; gap:8px; }
.sess-item{ display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:#565A50; background:#FBFBF9; border:1px solid var(--rule); border-radius:5px; padding:4px 10px; }
.sess-badge{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:#FBFBF9; background:var(--ink); padding:1px 6px; border-radius:3px; }
.export{ margin-top:16px; padding:15px; border:1px solid var(--accent); border-radius:6px; background:#F5F6F2; }
.export-btn{ font-family:inherit; font-size:14px; font-weight:600; color:#FBFBF9; background:var(--accent); border:none; border-radius:5px; padding:10px 18px; cursor:pointer; }
.export-btn:hover{ background:#B26B12; }
.export-note{ font-size:12px; line-height:1.55; color:#565A50; margin-top:9px; }

/* ── corridor "why": grounded explanation of the computed class ───────────── */
.why{ margin:14px 0 4px; padding:12px 14px; background:#FBFBF9; border:1px solid var(--rule); border-left:3px solid var(--verify); border-radius:5px; }
.why-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--slate); margin-bottom:9px; }
.why-rule{ margin-bottom:9px; }
.why-badge{ display:inline-block; font-size:12px; font-weight:600; line-height:1.4; padding:3px 10px; border-radius:4px; border:1px solid; }
.why-clean{ color:var(--c-open); background:var(--c-open-bg); border-color:var(--c-open-bd); }
.why-dest_gate{ color:var(--c-chan); background:var(--c-chan-bg); border-color:var(--c-chan-bd); }
.why-dest_blocked{ color:var(--c-block); background:var(--c-block-bg); border-color:var(--c-block-bd); }
.why-dest_pre{ color:var(--c-pre); background:var(--c-pre-bg); border-color:var(--c-pre-bd); }
.why-dest_transition{ color:var(--c-trans); background:var(--c-trans-bg); border-color:var(--c-trans-bd); }
.why-origin_drag{ color:var(--c-block); background:var(--c-block-bg); border-color:var(--c-block-bd); }
.why-compose{ color:var(--c-unre); background:var(--c-unre-bg); border-color:var(--c-unre-bd); }
.why-con{ display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.why-con-id{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; font-weight:700; color:#FBFBF9; background:var(--ink); padding:1px 7px; border-radius:3px; }
.why-con-n{ font-size:13px; font-weight:600; color:var(--ink); }
.why-con-j{ font-size:11px; color:var(--slate); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; }
.why-rec{ display:flex; align-items:baseline; gap:7px; flex-wrap:wrap; font-size:12px; line-height:1.5; padding:8px 10px; background:#FBFBF9; border:1px solid var(--rule); border-radius:4px; }
.why-rec-dot{ width:8px; height:8px; border-radius:50%; flex-shrink:0; align-self:center; }
.why-cit{ background:var(--verify); }
.why-pend{ background:var(--accent); }
.why-rec-id{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--verify); }
.why-rec-pin{ color:#565A50; flex:1; min-width:180px; }
.why-rec-src{ font-size:11px; color:var(--accent); text-decoration:none; white-space:nowrap; }
.why-rec-src:hover{ text-decoration:underline; }
.why-clean{ font-size:12.5px; line-height:1.55; color:#2E7D46; }
.why-ovr{ font-size:11.5px; color:var(--c-chan); margin-top:7px; }
.why-note{ font-size:11px; line-height:1.55; color:var(--gap); margin-top:9px; }

/* ── constraint substrate view ────────────────────────────────────────────── */
.sub-tally{ display:flex; gap:10px; flex-wrap:wrap; margin-bottom:22px; }
.sub-tally-c{ flex:1; min-width:120px; text-align:center; padding:12px 10px; background:var(--paper2); border:1px solid var(--rule); border-radius:6px; }
.sub-tally-c b{ display:block; font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:26px; font-weight:600; color:var(--ink); line-height:1; }
.sub-tally-c span{ display:block; font-size:10.5px; line-height:1.4; color:var(--slate); margin-top:6px; }
.sub-tally-c.sub-cit{ border-color:var(--c-trans-bd); background:var(--c-trans-bg); } .sub-tally-c.sub-cit b{ color:var(--verify); }
.sub-tally-c.sub-pend{ border-color:var(--c-chan-bd); background:var(--c-chan-bg); } .sub-tally-c.sub-pend b{ color:var(--accent); }
.sub-sec-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:16px; font-weight:600; color:var(--ink); margin:24px 0 10px; padding-bottom:5px; border-bottom:1px solid var(--rule); }
.sub-cons{ display:grid; grid-template-columns:repeat(4,1fr); gap:7px; margin-bottom:12px; }
.sub-con{ display:flex; flex-direction:column; align-items:flex-start; gap:3px; padding:8px 10px; background:#FBFBF9; border:1px solid var(--rule); border-radius:5px; cursor:pointer; text-align:left; font-family:inherit; }
.sub-con:hover{ border-color:var(--verify); }
.sub-con.on{ border-color:var(--ink); background:var(--ink); }
.sub-con-id{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; color:var(--accent); }
.sub-con.on .sub-con-id{ color:#E5CFA0; }
.sub-con-n{ font-size:11.5px; line-height:1.3; color:var(--ink); }
.sub-con.on .sub-con-n{ color:var(--paper); }
.sub-con-detail{ padding:13px 15px; background:var(--paper2); border:1px solid var(--rule); border-radius:6px; margin-bottom:8px; }
.sub-con-d{ font-size:13.5px; line-height:1.6; color:var(--ink); margin-bottom:9px; }
.sub-con-x{ font-size:12.5px; line-height:1.6; color:#565A50; }
.sub-con-x-l{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--accent); margin-right:6px; }
.sub-con-dims{ margin-top:10px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.sub-con-dims-l{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--slate); }
.sub-con-dim{ font-size:10.5px; color:var(--slate); background:#FBFBF9; border:1px solid var(--rule); border-radius:3px; padding:1px 7px; }
.sub-grid-hint{ font-size:11.5px; line-height:1.55; color:var(--gap); margin-bottom:11px; max-width:760px; }
.sub-grid-wrap{ overflow-x:auto; }
.sub-grid{ border-collapse:separate; border-spacing:3px; }
.sub-grid-corner{ width:34px; }
.sub-grid-ch{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; color:var(--slate); text-align:center; padding:3px 0; cursor:pointer; width:34px; }
.sub-grid-ch.on{ color:var(--accent); }
.sub-grid-rh{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; color:var(--ink); text-align:right; padding-right:7px; cursor:pointer; white-space:nowrap; }
.sub-grid tr.on .sub-grid-rh{ color:var(--accent); }
.sub-cell{ width:34px; height:26px; border-radius:4px; cursor:pointer; text-align:center; vertical-align:middle; border:1px solid transparent; }
.sub-cell:hover{ border-color:var(--ink); }
.sub-cell.sub-sel{ border-color:var(--ink); box-shadow:0 0 0 1px var(--ink); }
.sub-citable{ background:var(--c-trans-bg); } .sub-citable .sub-dot{ background:var(--verify); }
.sub-pending{ background:var(--c-chan-bg); } .sub-pending .sub-dot{ background:var(--accent); }
.sub-other{ background:#F5F6F2; } .sub-other .sub-dot{ background:var(--gap); }
.sub-none{ background:#F5F6F2; } .sub-none .sub-dot{ background:#DBDDD4; }
.sub-dot{ display:inline-block; width:8px; height:8px; border-radius:50%; }
.sub-legend{ display:flex; gap:16px; flex-wrap:wrap; margin:11px 0 4px; }
.sub-leg{ display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--slate); }
.sub-pole{ margin-top:14px; padding:13px 15px; background:#FBFBF9; border:1px solid var(--rule); border-radius:6px; }
.sub-pole-head{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-bottom:10px; margin-bottom:10px; border-bottom:1px solid var(--rule); }
.sub-pole-jur{ font-size:13px; font-weight:600; color:var(--ink); }
.sub-pole-arrow{ color:var(--gap); }
.sub-pole-con{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:var(--accent); }
.sub-pole-stat{ margin-left:auto; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border-radius:3px; }
.sub-stat-citable{ color:var(--verify); background:var(--c-trans-bg); border:1px solid var(--c-trans-bd); }
.sub-stat-pending{ color:var(--accent); background:var(--c-chan-bg); border:1px solid var(--c-chan-bd); }
.sub-stat-other{ color:var(--gap); background:#F5F6F2; border:1px solid var(--rule); }
.sub-stat-none{ color:var(--gap); background:#F5F6F2; border:1px solid var(--rule); }
.sub-rec{ padding:10px 0; border-bottom:1px dotted var(--rule); }
.sub-rec:last-child{ border-bottom:none; padding-bottom:2px; }
.sub-rec-top{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.sub-rec-top .sub-dot{ flex-shrink:0; }
.sub-rec-id{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--verify); }
.sub-rec-auth{ font-size:11px; color:var(--slate); }
.sub-rec-src{ margin-left:auto; font-size:13px; color:var(--accent); text-decoration:none; }
.sub-rec-sum{ font-size:12.5px; line-height:1.6; color:#565A50; }
.sub-rec-tension{ font-size:11.5px; line-height:1.55; color:#8B8E84; margin-top:7px; background:#F5F6F2; border-radius:4px; padding:6px 9px; }
.sub-rec-tension-l{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-block); margin-right:6px; }
.sub-rec-none{ font-size:12px; color:var(--gap); font-style:italic; }
.sub-int-lead{ font-size:12px; line-height:1.55; color:var(--gap); margin-bottom:12px; max-width:760px; }
.sub-ints{ display:grid; grid-template-columns:1fr 1fr; gap:9px; }
.sub-int{ padding:11px 13px; background:var(--paper2); border:1px solid var(--rule); border-radius:6px; }
.sub-int-head{ display:flex; align-items:baseline; gap:7px; flex-wrap:wrap; margin-bottom:7px; }
.sub-int-id{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:15px; font-weight:700; color:var(--accent); }
.sub-int-pair{ display:inline-flex; align-items:center; gap:2px; }
.sub-int-c{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; color:var(--ink); background:#FBFBF9; border:1px solid var(--rule); border-radius:3px; padding:0 5px; cursor:pointer; }
.sub-int-c:hover{ border-color:var(--verify); color:var(--verify); }
.sub-int-x{ color:var(--gap); font-size:10px; margin:0 1px; }
.sub-int-t{ font-size:12px; font-weight:600; color:var(--ink); }
.sub-int-p{ font-size:11.5px; line-height:1.6; color:#565A50; }

/* ── live MCP runner ──────────────────────────────────────────────────────── */
.mcp-run{ margin:16px 0 22px; padding:15px; background:var(--ink); border-radius:7px; }
.mcp-run-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#E5CFA0; margin-bottom:7px; }
.mcp-run-lead{ font-size:12px; line-height:1.6; color:#C6C8BF; margin-bottom:12px; max-width:720px; }
.mcp-run-tools{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:11px; }
.mcp-run-tool{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:#C6C8BF; background:#191B17; border:1px solid #3A4E63; border-radius:5px; padding:5px 11px; cursor:pointer; }
.mcp-run-tool:hover{ border-color:#566A88; color:#FBFBF9; }
.mcp-run-tool.on{ color:var(--ink); background:#E5CFA0; border-color:#E5CFA0; }
.mcp-run-args{ display:flex; gap:14px; flex-wrap:wrap; margin-bottom:11px; }
.mcp-arg{ display:flex; align-items:center; gap:7px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:#9AA0A6; }
.mcp-arg select{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:#FBFBF9; background:#191B17; border:1px solid #3A4E63; border-radius:4px; padding:3px 8px; cursor:pointer; }
.mcp-out{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; line-height:1.55; color:#DCEAD0; background:#0F1210; border:1px solid #191B17; border-radius:5px; padding:12px 14px; margin:0; overflow-x:auto; max-height:340px; overflow-y:auto; }
.mcp-run-note{ font-size:11px; line-height:1.55; color:#8B8E84; margin-top:10px; }

/* ── time-travel slider (compose(as_of)) ─────────────────────────────────── */
.tt{ border:1px solid var(--rule); border-radius:8px; background:#FBFBF9; padding:15px 16px 17px; margin-bottom:18px; }
.tt-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:16px; font-weight:600; color:var(--ink); margin-bottom:4px; }
.tt-hint{ font-size:12px; line-height:1.55; color:var(--slate); margin-bottom:13px; max-width:660px; }
.tt-row{ display:flex; align-items:center; gap:10px; margin-bottom:9px; }
.tt-asof-k{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); }
.tt-asof-v{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:14px; font-weight:600; color:var(--ink); }
.tt-reset{ margin-left:auto; font-size:11px; padding:3px 10px; border:1px solid var(--rule); border-radius:4px; background:#FBFBF9; color:var(--verify); cursor:pointer; font-family:inherit; }
.tt-reset:hover{ border-color:var(--verify); }
.tt-slider{ -webkit-appearance:none; appearance:none; width:100%; height:5px; border-radius:3px; background:linear-gradient(90deg,var(--c-trans-bd),var(--accent)); outline:none; margin:6px 0 4px; cursor:pointer; }
.tt-slider::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:18px; height:18px; border-radius:50%; background:var(--ink); border:3px solid #FBFBF9; box-shadow:none; cursor:pointer; }
.tt-slider::-moz-range-thumb{ width:18px; height:18px; border-radius:50%; background:var(--ink); border:3px solid #FBFBF9; box-shadow:none; cursor:pointer; }
.tt-slider:focus-visible{ outline:2px solid var(--verify); outline-offset:3px; }
.tt-ticks{ display:flex; justify-content:space-between; gap:6px; margin-bottom:14px; }
.tt-tick{ flex:1; display:flex; flex-direction:column; align-items:center; gap:2px; background:none; border:none; cursor:pointer; padding:4px 2px; border-radius:4px; font-family:inherit; }
.tt-tick:hover{ background:#FBFBF9; }
.tt-tick-dt{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--slate); }
.tt-tick-lbl{ font-size:9.5px; line-height:1.25; color:var(--gap); text-align:center; }
.tt-tick.on .tt-tick-dt{ color:var(--ink); font-weight:700; }
.tt-tick.on .tt-tick-lbl{ color:var(--accent); }
.tt-dates{ font-size:11.5px; line-height:1.6; color:var(--slate); background:#FBFBF9; border:1px solid var(--rule); border-radius:5px; padding:8px 11px; margin-bottom:4px; max-width:760px; }
.tt-tick-today .tt-tick-dt{ color:var(--verify); font-weight:700; }
.tt-tick-state{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:8.5px; letter-spacing:.05em; text-transform:uppercase; color:var(--gap); border:1px solid var(--rule); border-radius:3px; padding:0 4px; }
.tt-tick-past .tt-tick-state{ color:var(--verify); border-color:var(--c-trans-bd); }
.framefail{ border:1px solid var(--c-block); border-left:3px solid var(--c-block); border-radius:6px; background:#FDF6F5; padding:13px 15px; margin:14px 0; }
.framefail-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:13.5px; font-weight:600; color:var(--ink); margin-bottom:6px; }
.framefail-b{ font-size:12px; line-height:1.65; color:var(--slate); margin-bottom:7px; }
.framefail-keep{ font-size:11.5px; line-height:1.6; color:var(--verify); margin-bottom:10px; }
.framefail-btn{ font-family:inherit; font-size:12px; font-weight:600; padding:6px 14px; border:1px solid var(--ink); border-radius:4px; background:#FBFBF9; color:var(--ink); cursor:pointer; }
.framefail-btn:hover{ background:var(--ink); color:#FBFBF9; }
.tt-dist{ border-top:1px solid var(--rule); padding-top:12px; }
.tt-dist-h{ display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--slate); margin-bottom:8px; }
.tt-dist-changed{ margin-left:auto; text-transform:none; letter-spacing:0; font-size:11px; font-weight:600; color:var(--accent); }
.tt-dist-changed.zero{ color:var(--gap); font-weight:400; }
.tt-bar{ display:flex; height:26px; border-radius:5px; overflow:hidden; border:1px solid var(--rule); }
.tt-seg{ display:flex; align-items:center; justify-content:center; min-width:0; transition:width .35s cubic-bezier(.4,0,.2,1); }
.tt-seg-n{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; color:#FBFBF9; }
.tt-seg-open{ background:var(--c-open); } .tt-seg-chan{ background:var(--c-chan); } .tt-seg-unre{ background:var(--c-unre); }
.tt-seg-trans{ background:var(--c-trans); } .tt-seg-block{ background:var(--c-block); } .tt-seg-pre{ background:var(--c-pre); }
.tt-legend{ display:flex; flex-wrap:wrap; gap:11px; margin-top:9px; }
.tt-legend-i{ display:flex; align-items:center; gap:5px; font-size:11px; color:var(--slate); }
.tt-legend-i b{ color:var(--ink); }
.tt-dot{ width:10px; height:10px; border-radius:2px; display:inline-block; }
.tt-pending{ margin-top:13px; border-top:1px dashed var(--rule); padding-top:11px; }
.tt-pending-h{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--gap); margin-bottom:7px; }
.tt-pending-row{ display:flex; flex-wrap:wrap; gap:7px; margin-bottom:7px; }
.tt-pending-chip{ display:inline-flex; align-items:center; gap:6px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:var(--slate); background:var(--paper2); border:1px dashed var(--rule); border-radius:4px; padding:3px 9px; }
.tt-pending-chip b{ color:var(--accent); font-size:12px; }
.tt-pending-note{ font-size:11px; line-height:1.5; color:var(--gap); max-width:660px; }

/* ── 12×12 corridor heat matrix ──────────────────────────────────────────── */
.mx{ border:1px solid var(--rule); border-radius:8px; background:#FBFBF9; padding:15px 16px 14px; margin-bottom:20px; }
.mx-h{ font-family:'IBM Plex Sans',-apple-system,system-ui,"Segoe UI",Roboto,sans-serif; font-size:16px; font-weight:600; color:var(--ink); margin-bottom:4px; }
.mx-hint{ font-size:12px; line-height:1.55; color:var(--slate); margin-bottom:13px; max-width:680px; }
.mx-scroll{ overflow-x:auto; -webkit-overflow-scrolling:touch; }
.mx-tbl{ border-collapse:separate; border-spacing:2px; margin:0 auto; }
.mx-corner{ position:relative; width:46px; height:34px; }
.mx-corner-o{ position:absolute; left:3px; bottom:2px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:8.5px; color:var(--gap); }
.mx-corner-d{ position:absolute; right:3px; top:2px; font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:8.5px; color:var(--gap); }
.mx-colh,.mx-rowh{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; color:var(--ink); }
.mx-colh{ padding:3px 0; text-align:center; width:38px; }
.mx-rowh{ padding:0 7px 0 3px; text-align:right; white-space:nowrap; }
.mx-diag{ background:repeating-linear-gradient(45deg,var(--paper2),var(--paper2) 3px,#FBFBF9 3px,#FBFBF9 6px); border-radius:3px; }
.mx-na{ text-align:center; color:var(--gap); font-size:11px; background:var(--paper2); border-radius:3px; }
.mx-cell{ width:38px; height:30px; text-align:center; border-radius:3px; cursor:pointer; border:1px solid transparent; position:relative; transition:transform .1s, box-shadow .1s; }
.mx-cell:hover{ transform:scale(1.12); box-shadow:none; z-index:2; border-color:var(--ink); }
.mx-cell:focus-visible{ outline:2px solid var(--ink); outline-offset:1px; z-index:2; }
.mx-code{ font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; font-size:10px; font-weight:700; }
.mx-open{ background:var(--c-open-bg); color:var(--c-open); } .mx-chan{ background:var(--c-chan-bg); color:var(--c-chan); }
.mx-unre{ background:var(--c-unre-bg); color:var(--c-unre); } .mx-trans{ background:var(--c-trans-bg); color:var(--c-trans); }
.mx-block{ background:var(--c-block-bg); color:var(--c-block); } .mx-pre{ background:var(--c-pre-bg); color:var(--c-pre); }
.mx-flip{ box-shadow:inset 0 0 0 2px var(--accent); }
.mx-flip-dot{ position:absolute; top:1px; right:2px; font-size:7px; color:var(--accent); line-height:1; }
.mx-foot{ display:flex; flex-wrap:wrap; gap:12px; margin-top:12px; padding-top:11px; border-top:1px solid var(--rule); }
.mx-foot-i{ display:flex; align-items:center; gap:5px; font-size:11px; color:var(--slate); }
.mx-dot{ width:12px; height:12px; border-radius:3px; display:inline-block; border:1px solid; }
.mx-foot-i .mx-open{ border-color:var(--c-open-bd); } .mx-foot-i .mx-chan{ border-color:var(--c-chan-bd); }
.mx-foot-i .mx-unre{ border-color:var(--c-unre-bd); } .mx-foot-i .mx-trans{ border-color:var(--c-trans-bd); }
.mx-foot-i .mx-block{ border-color:var(--c-block-bd); } .mx-foot-i .mx-pre{ border-color:var(--c-pre-bd); }
.mx-foot-i .mx-flip-dot{ position:static; font-size:10px; }
.corr-shifted{ display:inline-flex; align-items:center; gap:5px; margin-left:10px; font-size:11px; color:var(--accent); font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace; }

/* ── export bar (CSV / BibTeX) ───────────────────────────────────────────── */
.xbar{ margin:6px 0 20px; }
.xbar-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:11px; }
.xbar-item{ border:1px solid var(--rule); border-radius:6px; background:var(--paper2); padding:11px 12px; }
.xbar-btn{ width:100%; font-size:13px; font-weight:600; padding:9px 12px; border:1px solid var(--ink); border-radius:5px; background:#FBFBF9; color:var(--ink); cursor:pointer; font-family:inherit; }
.xbar-btn:hover{ background:var(--ink); color:var(--paper); }
.xbar-note{ font-size:11px; line-height:1.5; color:var(--slate); margin-top:7px; }

/* responsive */
@media(max-width:640px){
  .tt-tick-lbl{ display:none; }
  .mx-cell,.mx-colh{ width:32px; } .mx-cell{ height:26px; }
  .mx-code{ font-size:9px; }
  .corr-jur-grid,.fwd-jur-grid{ grid-template-columns:repeat(4,1fr); }
  .corr-pick{ flex-direction:column; }
  .corr-arrow{ padding-top:0; align-self:flex-start; transform:rotate(90deg); }
  .fwd-jr-cols,.setl-blocs,.conv-cells{ grid-template-columns:1fr; }
  .sub-cons{ grid-template-columns:repeat(2,1fr); }
  .sub-ints{ grid-template-columns:1fr; }
  .sub-tally-c{ min-width:calc(50% - 5px); }
  .recon-stat{ flex-direction:column; }
  .nav-btn-s{ display:none; }
  .nav-btn{ padding:8px 11px; }
}

`;
