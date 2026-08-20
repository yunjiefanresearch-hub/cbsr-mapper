/* ============================================================================
   EvaluateView.jsx — the mapper's lead view.

   WHY THIS IS FIRST
   -----------------
   The other six views tour the register's layers. They explain. This one is
   the only surface that does the thing nobody else can do: take a proposed
   agent action and return a decision, a receipt, and the exact evidence the
   decision rested on — including, and especially, when the answer is "not
   enough evidence to authorize this."

   The default scenario is deliberately one that returns `review_required`.
   That is the demonstration: on the 2026-08-20 snapshot, a well-formed,
   in-mandate, in-scope request still does not clear, because source checks
   are not current and no independent second review is reconciled. A system
   that returned `allow` here would be the broken one.

   Nothing here calls a model or the network. Every outcome is derived from the
   committed snapshot by policyMirror.js.
   ========================================================================= */

import React, { useMemo, useState } from "react";
import { evaluateAction, createReceipt, verifyReceipt } from "./policyMirror.js";
import { RecordAxes } from "./EvidenceAxes.jsx";

/* Three scenarios, each chosen to exercise a different gate in the engine.
   They are not marketing examples: each maps onto a named scenario in
   research/AGENTICFI_EVALUATION_REPORT.md. */
const SCENARIOS = [
  {
    key: "settlement",
    label: { en: "B2B settlement, HK → BR", zh: "B2B 结算，香港 → 巴西" },
    note: {
      en: "In mandate, in scope, well formed. Exercises the evidence-quality gate.",
      zh: "在授权范围内、格式完整。用于检验证据质量关口。",
    },
    action: {
      action_id: "act-2026-0820-001",
      origin: "HK",
      destination: "BR",
      asset: "USD payment stablecoin",
      amount: 250000,
      actor: "agent:treasury-bot@example.com",
      counterparty: "acme-br",
      requires_kyc: true,
      mandate: {
        mandate_id: "mnd-treasury-001",
        version: "1.0.0",
        active: true,
        jurisdictions: ["HK", "BR"],
        assets: ["USD payment stablecoin"],
        counterparties: ["acme-br"],
        max_amount: 500000,
        human_review: { amount_threshold: 100000 },
      },
    },
  },
  {
    key: "prohibition",
    label: { en: "Inbound to a prohibition regime", zh: "流入禁止性法域" },
    note: {
      en: "A destination prohibition ends the evaluation before evidence quality is reached.",
      zh: "目的地禁止会在到达证据质量判断之前终止评估。",
    },
    action: {
      action_id: "act-2026-0820-002",
      origin: "HK",
      destination: "CN",
      asset: "USD payment stablecoin",
      amount: 50000,
      actor: "agent:treasury-bot@example.com",
      counterparty: "acme-cn",
      mandate: {
        mandate_id: "mnd-treasury-001",
        version: "1.0.0",
        active: true,
        jurisdictions: ["HK", "CN"],
        assets: ["USD payment stablecoin"],
        counterparties: ["acme-cn"],
        max_amount: 500000,
        human_review: {},
      },
    },
  },
  {
    key: "over_limit",
    label: { en: "Over the mandate ceiling", zh: "超出授权上限" },
    note: {
      en: "Mandate scope is checked before evidence is read at all.",
      zh: "授权范围在读取证据之前就被检查。",
    },
    action: {
      action_id: "act-2026-0820-003",
      origin: "SG",
      destination: "JP",
      asset: "USD payment stablecoin",
      amount: 9000000,
      actor: "agent:treasury-bot@example.com",
      counterparty: "acme-jp",
      mandate: {
        mandate_id: "mnd-treasury-001",
        version: "1.0.0",
        active: true,
        jurisdictions: ["SG", "JP"],
        assets: ["USD payment stablecoin"],
        counterparties: ["acme-jp"],
        max_amount: 500000,
        human_review: {},
      },
    },
  },
];

const OUTCOME_COPY = {
  allow: {
    en: ["Allow", "Every axis cleared on every rule read."],
    zh: ["允许", "所读取的每条规则六轴全部通过。"],
  },
  allow_with_conditions: {
    en: ["Allow with conditions", "Cleared, but the mandate attaches conditions before execution."],
    zh: ["附条件允许", "已通过，但授权在执行前附加了条件。"],
  },
  review_required: {
    en: ["Review required", "The evidence chain is incomplete. A human has to close it."],
    zh: ["需人工复核", "证据链不完整，须由人工闭合。"],
  },
  prohibited: {
    en: ["Prohibited", "A mandate term or an operative legal prohibition blocks this."],
    zh: ["禁止", "授权条款或现行法律禁止阻断此动作。"],
  },
  insufficient_evidence: {
    en: ["Insufficient evidence", "The request or the record set cannot support any verdict."],
    zh: ["证据不足", "请求本身或记录集不足以支撑任何结论。"],
  },
};

const REASON_COPY = {
  evidence_not_current: {
    en: "at least one rule's source check is stale or was never made",
    zh: "至少一条规则的来源检查已过期或从未进行",
  },
  independent_second_review_incomplete: {
    en: "no independent second reviewer has reconciled these cells",
    zh: "这些格位尚无独立第二审阅人完成 reconcile",
  },
  non_final_transitional_or_superseded_rule: {
    en: "a rule read here is transitional, proposed, or superseded",
    zh: "所读规则中存在过渡性、草案或已被取代的条文",
  },
  rule_not_operative: {
    en: "a rule read here rests on an instrument that is not yet operative",
    zh: "所读规则依据的文书尚未生效",
  },
  conflicting_evidence: {
    en: "two records in the same cell disagree on binding status",
    zh: "同一格位内两条记录的效力状态相互冲突",
  },
  applicable_regulatory_prohibition: {
    en: "an applicable record carries binding_status=prohibition",
    zh: "适用记录的 binding_status 为 prohibition",
  },
  amount_exceeds_mandate: { en: "amount is above the mandate ceiling", zh: "金额超出授权上限" },
  no_applicable_regulatory_evidence: {
    en: "the register holds no record for this jurisdiction and dimension pair",
    zh: "登记册中没有该法域与维度组合的记录",
  },
  operative_current_reconciled_evidence: {
    en: "operative, current, reconciled evidence",
    zh: "文书生效、来源现行、复核已闭合",
  },
};

const CONDITION_COPY = {
  obtain_human_approval: { en: "Obtain human approval", zh: "取得人工批准" },
  complete_kyc_before_execution: { en: "Complete KYC before execution", zh: "执行前完成 KYC" },
};

function download(name, text, type) {
  const blob = new Blob([text], { type: type || "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function EvaluateView({ DATA, ui }) {
  const zh = ui === "zh";
  const t = (pair) => (zh ? pair.zh : pair.en);

  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[0].key);
  const [draft, setDraft] = useState(() => JSON.stringify(SCENARIOS[0].action, null, 2));
  const [showReceipt, setShowReceipt] = useState(false);

  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) || SCENARIOS[0];

  const parsed = useMemo(() => {
    try {
      return { ok: true, value: JSON.parse(draft) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }, [draft]);

  const decision = useMemo(() => {
    if (!parsed.ok) return null;
    return evaluateAction(parsed.value, DATA.records, DATA.meta.as_of);
  }, [parsed, DATA]);

  const receipt = useMemo(() => {
    if (!decision || !parsed.ok) return null;
    return createReceipt(parsed.value, decision, DATA.meta.version);
  }, [decision, parsed, DATA]);

  const integrity = receipt ? verifyReceipt(receipt) : null;

  const pick = (key) => {
    const s = SCENARIOS.find((x) => x.key === key);
    setScenarioKey(key);
    if (s) setDraft(JSON.stringify(s.action, null, 2));
    setShowReceipt(false);
  };

  const recordsById = useMemo(() => {
    const map = {};
    DATA.records.forEach((r) => (map[r.id] = r));
    return map;
  }, [DATA]);

  const copy = decision ? OUTCOME_COPY[decision.outcome] : null;

  return (
    <div className="eval">
      <header className="eval-intro">
        <h2 className="eval-h">
          {zh ? "评估一个动作。拿回一张回执。" : "Evaluate an action. Get a receipt."}
        </h2>
        <p className="eval-lede">
          {zh
            ? "把一个拟议的 agent 动作交给策略引擎，它会返回结论、依据的每一条规则，以及一张可核验的回执。它永远不会执行任何东西：execution_authorized 恒为 false。"
            : "Hand a proposed agent action to the policy engine. It returns a verdict, every rule the verdict rested on, and a checkable receipt. It never executes anything: execution_authorized is a hard false."}
        </p>
      </header>

      <div className="eval-scen" role="group" aria-label={zh ? "示例场景" : "Example scenarios"}>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={"eval-tab" + (s.key === scenarioKey ? " on" : "")}
            onClick={() => pick(s.key)}
          >
            {t(s.label)}
          </button>
        ))}
      </div>
      <p className="eval-note">{t(scenario.note)}</p>

      <div className="eval-grid">
        <section className="eval-pane">
          <div className="eval-pane-h">
            <span>{zh ? "动作请求" : "Action request"}</span>
            <span className="eval-schema">cbsr/policy-action/v1</span>
          </div>
          <textarea
            className="eval-input"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={zh ? "动作请求 JSON" : "Action request JSON"}
          />
          {!parsed.ok && (
            <p className="eval-err">
              {zh ? "JSON 无法解析：" : "This JSON does not parse: "}
              {parsed.error}
            </p>
          )}
        </section>

        <section className="eval-pane">
          <div className="eval-pane-h">
            <span>{zh ? "结论" : "Decision"}</span>
            <span className="eval-schema">
              {decision ? decision.engine_version : "cbsr-policy-engine"}
            </span>
          </div>

          {decision && copy && (
            <div className="eval-out">
              <div className="eval-verdict" data-outcome={decision.outcome}>
                <span className="eval-outcome">{t({ en: copy.en[0], zh: copy.zh[0] })}</span>
                <code className="eval-code">{decision.outcome}</code>
              </div>
              <p className="eval-say">{t({ en: copy.en[1], zh: copy.zh[1] })}</p>

              <div className="eval-exec">
                <span className="eval-exec-k">execution_authorized</span>
                <span className="eval-exec-v">false</span>
              </div>

              {!!decision.reasons.length && (
                <div className="eval-block">
                  <h4>{zh ? "理由" : "Because"}</h4>
                  <ul className="eval-list">
                    {decision.reasons.map((r) => (
                      <li key={r}>
                        <code>{r}</code>
                        <span>{REASON_COPY[r] ? t(REASON_COPY[r]) : ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!!decision.conditions.length && (
                <div className="eval-block">
                  <h4>{zh ? "执行前必须满足" : "Before execution"}</h4>
                  <ul className="eval-list">
                    {decision.conditions.map((c) => (
                      <li key={c}>
                        <code>{c}</code>
                        <span>{CONDITION_COPY[c] ? t(CONDITION_COPY[c]) : ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="eval-fresh">
                <span>{zh ? "所读规则的时效分布" : "Freshness of the rules read"}</span>
                <b>
                  current {decision.freshness_snapshot.current} · stale{" "}
                  {decision.freshness_snapshot.stale} · unknown{" "}
                  {decision.freshness_snapshot.unknown}
                </b>
              </div>

              <div className="eval-acts">
                <button type="button" className="eval-btn" onClick={() => setShowReceipt((v) => !v)}>
                  {showReceipt
                    ? zh
                      ? "收起回执"
                      : "Hide receipt"
                    : zh
                    ? "查看回执"
                    : "Show receipt"}
                </button>
                <button
                  type="button"
                  className="eval-btn"
                  disabled={!receipt}
                  onClick={() =>
                    download(
                      "cbsr-receipt-" + (parsed.value.action_id || "action") + ".json",
                      JSON.stringify(receipt, null, 2)
                    )
                  }
                >
                  {zh ? "下载回执 JSON" : "Download receipt JSON"}
                </button>
              </div>

              {showReceipt && receipt && (
                <div className="eval-receipt">
                  <div className="eval-int" data-valid={integrity && integrity.valid ? "yes" : "no"}>
                    <span>
                      {zh ? "完整性校验" : "Integrity"} · {receipt.integrity.algorithm}
                    </span>
                    <b>
                      {integrity && integrity.valid
                        ? (zh ? "通过 " : "verified ") + receipt.integrity.checksum
                        : zh
                        ? "不匹配"
                        : "mismatch"}
                    </b>
                  </div>
                  <p className="eval-int-note">
                    {zh
                      ? "这是防篡改校验和，不是密码学签名。它能发现回执被改动，不能证明是谁签发的。"
                      : "A tamper-evidence checksum, not a cryptographic signature. It detects alteration; it does not prove who issued the receipt."}
                  </p>
                  <pre className="eval-json">{JSON.stringify(receipt, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {!decision && (
            <p className="eval-empty">
              {zh
                ? "修正上面的 JSON 后，结论会立即在这里出现。"
                : "Fix the JSON above and the verdict appears here."}
            </p>
          )}
        </section>
      </div>

      {decision && !!decision.applicable_rules.length && (
        <section className="eval-rules">
          <h3 className="eval-rules-h">
            {zh ? "结论所依据的规则" : "The rules this verdict rested on"}
            <span>
              {decision.applicable_rules.length} {zh ? "条" : "records"}
            </span>
          </h3>
          <p className="eval-rules-lede">
            {zh
              ? "每一条都摊开六轴。橙色那一轴是把这条记录挡在 decision-ready 之外的那一轴。"
              : "Each is shown across all six axes. The marked axis is the one holding that record short of decision-ready."}
          </p>
          <ul className="eval-rule-list">
            {decision.applicable_rules.map((rule) => {
              const rec = recordsById[rule.record_id];
              if (!rec) return null;
              return (
                <li key={rule.record_id} className="eval-rule">
                  <div className="eval-rule-h">
                    <code className="eval-rid">{rec.id}</code>
                    <span className="eval-rauth">{rec.authority}</span>
                  </div>
                  <p className="eval-rsum">{rec.requirement_summary}</p>
                  {rec.pinpoint && <p className="eval-rpin">{rec.pinpoint}</p>}
                  <RecordAxes record={rec} ui={ui} dense />
                  {rec.url && (
                    <a className="eval-rurl" href={rec.url} target="_blank" rel="noreferrer">
                      {zh ? "官方文书" : "Official instrument"} ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="eval-foot">
        <p>
          {zh
            ? "本视图完全离线运行，不调用任何模型。结论由 policyMirror.js 从已提交快照推导，它复刻了 Python 策略引擎的关口顺序；两者若有分歧，以 Python 引擎为准。"
            : "This view runs entirely offline and calls no model. Verdicts are derived from the committed snapshot by policyMirror.js, which reproduces the Python engine's gate order. Where they could differ, the Python engine is authoritative."}
        </p>
        <p>
          {zh
            ? "决策支持，非法律意见、非交易批准、非执行授权。"
            : "Decision support only. Not legal advice, transaction approval, or execution authority."}
        </p>
      </footer>
    </div>
  );
}

export const EVALUATE_VIEW_CSS = `
.eval{max-width:1080px}
.eval-intro{margin:0 0 20px}
.eval-h{font-family:var(--serif,Georgia,serif);font-size:clamp(21px,2.6vw,28px);
  line-height:1.24;margin:0 0 8px;font-weight:600}
.eval-lede{margin:0;max-width:64ch;font-size:14.5px;line-height:1.62;color:var(--ink-2,#565A50)}
.eval-scen{display:flex;flex-wrap:wrap;gap:1px;margin:20px 0 0;background:var(--line,#DBDDD4);
  border:1px solid var(--line,#DBDDD4);width:fit-content;max-width:100%}
.eval-tab{font-family:var(--mono,monospace);font-size:12px;padding:8px 14px;border:0;
  background:var(--surface,#FBFBF9);color:var(--ink-2,#565A50);cursor:pointer;line-height:1.3}
.eval-tab:hover{color:var(--ink,#191B17)}
.eval-tab.on{background:var(--ink,#191B17);color:#fff}
.eval-note{margin:8px 0 0;font-size:12.5px;color:var(--muted,#8B8E84)}
.eval-grid{display:grid;grid-template-columns:minmax(0,0.9fr) minmax(0,1.1fr);gap:20px;margin:18px 0 0}
@media(max-width:900px){.eval-grid{grid-template-columns:1fr}}
.eval-pane{border:1px solid var(--line,#DBDDD4);background:var(--surface,#FBFBF9);display:flex;
  flex-direction:column;min-width:0}
.eval-pane-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  padding:9px 12px;border-bottom:1px solid var(--line,#DBDDD4);font-size:12px;
  letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2,#565A50)}
.eval-schema{font-family:var(--mono,monospace);font-size:10.5px;letter-spacing:0;
  text-transform:none;color:var(--muted,#8B8E84)}
.eval-input{font-family:var(--mono,monospace);font-size:12px;line-height:1.55;border:0;
  background:transparent;color:var(--ink,#191B17);padding:12px;min-height:340px;resize:vertical;
  width:100%}
.eval-input:focus{outline:2px solid var(--accent,#1E3A5F);outline-offset:-2px}
.eval-err{margin:0;padding:10px 12px;border-top:1px solid var(--line,#DBDDD4);
  font-family:var(--mono,monospace);font-size:11.5px;color:var(--block,#B23B36)}
.eval-out{padding:14px 12px 16px}
.eval-verdict{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  padding-bottom:10px;border-bottom:2px solid var(--ink,#191B17)}
.eval-outcome{font-family:var(--serif,Georgia,serif);font-size:clamp(20px,3vw,27px);font-weight:600}
.eval-verdict[data-outcome="allow"] .eval-outcome{color:var(--clear,#2E7D46)}
.eval-verdict[data-outcome="allow_with_conditions"] .eval-outcome{color:var(--clear,#2E7D46)}
.eval-verdict[data-outcome="review_required"] .eval-outcome{color:var(--gate,#B26B12)}
.eval-verdict[data-outcome="prohibited"] .eval-outcome{color:var(--block,#B23B36)}
.eval-verdict[data-outcome="insufficient_evidence"] .eval-outcome{color:var(--ink-2,#565A50)}
.eval-code{font-family:var(--mono,monospace);font-size:11.5px;color:var(--muted,#8B8E84)}
.eval-say{margin:10px 0 0;font-size:13.5px;line-height:1.6;color:var(--ink-2,#565A50)}
.eval-exec{display:flex;justify-content:space-between;gap:10px;margin:14px 0 0;padding:7px 9px;
  border:1px solid var(--line-strong,#C6C8BF);font-family:var(--mono,monospace);font-size:11.5px}
.eval-exec-k{color:var(--ink-2,#565A50)}
.eval-exec-v{color:var(--block,#B23B36);font-weight:500}
.eval-block{margin:16px 0 0}
.eval-block h4{margin:0 0 6px;font-family:var(--mono,monospace);font-size:10.5px;
  letter-spacing:.12em;text-transform:uppercase;color:var(--muted,#8B8E84);font-weight:400}
.eval-list{list-style:none;margin:0;padding:0}
.eval-list li{display:flex;gap:9px;flex-wrap:wrap;align-items:baseline;padding:5px 0;
  border-top:1px solid var(--line,#DBDDD4);font-size:12.5px;color:var(--ink-2,#565A50)}
.eval-list code{font-family:var(--mono,monospace);font-size:11px;color:var(--ink,#191B17);flex:none}
.eval-fresh{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:16px 0 0;
  padding-top:10px;border-top:1px solid var(--line,#DBDDD4);font-size:12px;color:var(--muted,#8B8E84)}
.eval-fresh b{font-family:var(--mono,monospace);font-weight:400;color:var(--ink-2,#565A50)}
.eval-acts{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 0}
.eval-btn{font-family:var(--mono,monospace);font-size:11.5px;padding:7px 12px;cursor:pointer;
  border:1px solid var(--line-strong,#C6C8BF);background:var(--paper,#EDEFEB);color:var(--ink,#191B17)}
.eval-btn:hover:not(:disabled){border-color:var(--accent,#1E3A5F);color:var(--accent,#1E3A5F)}
.eval-btn:disabled{opacity:.45;cursor:not-allowed}
.eval-receipt{margin:14px 0 0;border-top:1px solid var(--line,#DBDDD4);padding-top:12px}
.eval-int{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;
  font-family:var(--mono,monospace);font-size:11px;color:var(--muted,#8B8E84)}
.eval-int[data-valid="yes"] b{color:var(--clear,#2E7D46);font-weight:400}
.eval-int[data-valid="no"] b{color:var(--block,#B23B36);font-weight:400}
.eval-int-note{margin:6px 0 10px;font-size:11.5px;line-height:1.5;color:var(--muted,#8B8E84)}
.eval-json{font-family:var(--mono,monospace);font-size:10.5px;line-height:1.5;margin:0;
  padding:10px;background:var(--paper,#EDEFEB);border:1px solid var(--line,#DBDDD4);
  max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.eval-empty{padding:20px 12px;margin:0;font-size:13px;color:var(--muted,#8B8E84)}
.eval-rules{margin:30px 0 0;padding-top:22px;border-top:2px solid var(--ink,#191B17)}
.eval-rules-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  font-family:var(--serif,Georgia,serif);font-size:19px;font-weight:600;margin:0}
.eval-rules-h span{font-family:var(--mono,monospace);font-size:12px;font-weight:400;
  color:var(--muted,#8B8E84)}
.eval-rules-lede{margin:6px 0 16px;max-width:64ch;font-size:13px;color:var(--ink-2,#565A50)}
.eval-rule-list{list-style:none;margin:0;padding:0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.eval-rule{border:1px solid var(--line,#DBDDD4);background:var(--surface,#FBFBF9);padding:12px;
  min-width:0}
.eval-rule-h{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline}
.eval-rid{font-family:var(--mono,monospace);font-size:11px;color:var(--ink,#191B17)}
.eval-rauth{font-size:11px;color:var(--muted,#8B8E84);text-align:right}
.eval-rsum{margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--ink-2,#565A50);
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.eval-rpin{margin:6px 0 0;font-family:var(--mono,monospace);font-size:10.5px;line-height:1.45;
  color:var(--muted,#8B8E84)}
.eval-rurl{display:inline-block;margin:8px 0 0;font-size:11.5px}
.eval-foot{margin:28px 0 0;padding-top:14px;border-top:1px solid var(--line,#DBDDD4)}
.eval-foot p{margin:0 0 6px;max-width:74ch;font-size:12px;line-height:1.6;color:var(--muted,#8B8E84)}
`;
