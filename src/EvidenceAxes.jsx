/* ============================================================================
   EvidenceAxes.jsx — the components that make the evidence state impossible to
   misread.

   Two exports:

     <EvidenceLedger/>  the register's headline state, always as a fraction.
                        Replaces every place the UI used to print a bare
                        "46 citable". A count without a denominator is what
                        produced the v0.10.1 defect; this component cannot
                        render one.

     <RecordAxes/>      one record's six orthogonal axes, side by side, with
                        the axis that is holding it back marked. This is the
                        most persuasive artifact the project has and it was
                        previously buried behind a badge.

   Both are presentation only. Neither derives a legal conclusion; every value
   shown is read straight off the snapshot.
   ========================================================================= */

import React from "react";

/* The six axes, in the order a reader should resolve them: what kind of claim
   is this → is the instrument actually in force → how well is it sourced →
   is the source official → has it been checked recently → has a second
   reviewer reconciled it. Order encodes the dependency, not preference. */
export const AXES = [
  {
    key: "claim_class",
    label: "claim",
    zh: "主张类型",
    pass: (v) => v === "tier1_legal",
    explain: {
      tier1_legal: "a proposition of law",
      tier2_operational: "a market fact, not law",
    },
  },
  {
    key: "binding_status",
    label: "instrument",
    zh: "文书效力",
    pass: (v) => v === "in_force_enacted",
    explain: {
      in_force_enacted: "enacted and in force",
      made_not_commenced: "made, not commenced",
      finalized_policy_pending: "final policy, no statute",
      pending_proposal: "a bill",
      prohibition: "a prohibition",
      no_regime: "no regime",
    },
  },
  {
    key: "evidence_tier",
    label: "provenance",
    zh: "出处强度",
    pass: (v) => v === "resolution_text",
    explain: {
      resolution_text: "read against official text",
      mixed: "core point confirmed",
      firm_summary: "practitioner-corroborated",
      unset: "no tier earned",
    },
  },
  {
    key: "source_disposition",
    label: "source",
    zh: "来源",
    pass: (v) => v === "official",
    explain: { official: "official", unavailable: "not obtainable", secondary: "secondary" },
  },
  {
    key: "review_status",
    label: "freshness",
    zh: "时效",
    pass: (v) => v === "current",
    explain: {
      current: "checked within SLA",
      stale: "past SLA",
      due_for_review: "due",
      unknown: "never checked",
    },
  },
  {
    key: "review_stage",
    label: "review",
    zh: "复核",
    pass: (v) => v === "reconciled",
    explain: {
      reconciled: "two reviewers reconciled",
      primary_reviewed_second_pending: "one reviewer",
      unreviewed: "no reviewer",
    },
  },
];

const has = (o, k) => o && o[k] !== undefined && o[k] !== null && o[k] !== "";

/**
 * The register's state as a fraction, never as a single number.
 * `decision_ready / structural_candidates / records`.
 */
export function EvidenceLedger({ meta, ui, compact }) {
  const zh = ui === "zh";
  const ready = meta.decision_ready_count != null ? meta.decision_ready_count : 0;
  const structural = meta.structural_candidate_count != null ? meta.structural_candidate_count : 0;
  const total = meta.record_count || 0;
  const fresh = meta.freshness_counts || {};

  return (
    <section className={"ev-ledger" + (compact ? " ev-compact" : "")} aria-label="Evidence state">
      <header className="ev-head">
        <span className="ev-title">{zh ? "证据状态" : "Evidence state"}</span>
        <span className="ev-stamp">
          v{meta.version} · {meta.as_of}
        </span>
      </header>

      <div className="ev-fraction">
        <span className="ev-num" data-state={ready > 0 ? "some" : "none"}>
          {ready}
        </span>
        <span className="ev-slash">/</span>
        <span className="ev-den">{structural}</span>
        <span className="ev-slash">/</span>
        <span className="ev-den ev-total">{total}</span>
      </div>

      <dl className="ev-legend">
        <div>
          <dt>{zh ? "可作决策依据" : "decision-ready"}</dt>
          <dd>
            {zh
              ? "六轴全部通过。citable_law() 只暴露这一层。"
              : "all six axes pass. citable_law() exposes only this."}
          </dd>
        </div>
        <div>
          <dt>{zh ? "结构性候选" : "structural candidates"}</dt>
          <dd>
            {zh
              ? "清单筛选，不是「可作为现行法引用」的陈述。"
              : "an inventory filter, not a statement that a record may be cited as law."}
          </dd>
        </div>
        <div>
          <dt>{zh ? "已记录命题" : "recorded propositions"}</dt>
          <dd>{zh ? "十二法域 × 十五维度。" : "twelve jurisdictions × fifteen dimensions."}</dd>
        </div>
      </dl>

      {!compact && (
        <p className="ev-read">
          {zh ? (
            <>
              目前 <b>{ready}</b> 条记录可作决策依据。原因写在下面这条上：
              <b> {fresh.current || 0}</b> 条来源检查为 current，
              <b> {meta.review_coverage ? meta.review_coverage.reconciled : 0}</b> 条完成独立二审。
              这是 fail-closed 的正确结果，不是覆盖率失败。
            </>
          ) : (
            <>
              <b>{ready}</b> records are decision-ready today. The reason is on the record itself:{" "}
              <b>{fresh.current || 0}</b> source checks are current and{" "}
              <b>{meta.review_coverage ? meta.review_coverage.reconciled : 0}</b> have a reconciled
              independent second review. Fail-closed is the correct result here, not a coverage
              failure.
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * One record's six axes. The first failing axis is marked as the binding one,
 * because that is the axis a contributor would have to move to change the
 * record's status — the actionable fact, not just a red dot.
 */
export function RecordAxes({ record, ui, dense }) {
  const zh = ui === "zh";
  const rows = AXES.map((axis) => {
    const value = has(record, axis.key) ? record[axis.key] : "unset";
    return { axis, value, ok: axis.pass(value) };
  });
  const bindingIndex = rows.findIndex((r) => !r.ok);
  const ready = bindingIndex === -1;

  return (
    <div className={"ax-strip" + (dense ? " ax-dense" : "")}>
      <div className="ax-row" role="list">
        {rows.map((r, i) => (
          <div
            key={r.axis.key}
            role="listitem"
            className={
              "ax-cell" + (r.ok ? " ax-ok" : " ax-no") + (i === bindingIndex ? " ax-binding" : "")
            }
            title={(r.axis.explain[r.value] || r.value) + " — " + r.axis.key + "=" + r.value}
          >
            <span className="ax-label">{zh ? r.axis.zh : r.axis.label}</span>
            <span className="ax-value">{r.value}</span>
          </div>
        ))}
      </div>
      <p className="ax-verdict" data-ready={ready ? "yes" : "no"}>
        {ready ? (
          zh ? (
            "六轴全部通过 — 可作决策依据。"
          ) : (
            "All six axes pass — decision-ready."
          )
        ) : zh ? (
          <>
            受限于 <b>{rows[bindingIndex].axis.zh}</b>（{rows[bindingIndex].value}）。
            这一格要变成可引用，需要先移动这一轴。
          </>
        ) : (
          <>
            Held by <b>{rows[bindingIndex].axis.label}</b> ({rows[bindingIndex].value}). That is the
            axis a contributor would have to move first.
          </>
        )}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ styles --
   Injected once. Uses the mapper's existing ink/paper values so this reads as
   part of the instrument rather than a bolted-on widget. Monospaced numerals,
   square corners, hairline rules: a ledger, not a dashboard card. */
export const EVIDENCE_AXES_CSS = `
.ev-ledger{border:1px solid var(--line,#DBDDD4);background:var(--surface,#FBFBF9);padding:18px 20px 16px}
.ev-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  padding-bottom:10px;border-bottom:1px solid var(--line,#DBDDD4)}
.ev-title{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2,#565A50)}
.ev-stamp{font-family:var(--mono,monospace);font-size:12px;color:var(--muted,#8B8E84)}
.ev-fraction{display:flex;align-items:baseline;gap:10px;margin:16px 0 4px;
  font-family:var(--mono,monospace);font-variant-numeric:tabular-nums;line-height:1}
.ev-num{font-size:clamp(40px,7vw,62px);font-weight:500;color:var(--ink,#191B17)}
.ev-num[data-state="none"]{color:var(--gate,#B26B12)}
.ev-slash{font-size:26px;color:var(--muted,#8B8E84)}
.ev-den{font-size:26px;color:var(--ink-2,#565A50)}
.ev-den.ev-total{color:var(--muted,#8B8E84)}
.ev-legend{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:14px 0 0;padding:0}
.ev-legend div{margin:0;min-width:0}
.ev-legend dt{font-family:var(--mono,monospace);font-size:11px;letter-spacing:.06em;
  color:var(--ink,#191B17);margin:0 0 3px}
.ev-legend dd{margin:0;font-size:12.5px;line-height:1.45;color:var(--ink-2,#565A50)}
.ev-read{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--line,#DBDDD4);
  font-size:13.5px;line-height:1.6;color:var(--ink-2,#565A50)}
.ev-read b{font-family:var(--mono,monospace);color:var(--ink,#191B17)}
.ev-compact .ev-legend,.ev-compact .ev-read{display:none}
@media(max-width:640px){.ev-legend{grid-template-columns:1fr}}

.ax-strip{margin:10px 0 0}
.ax-row{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;
  background:var(--line,#DBDDD4);border:1px solid var(--line,#DBDDD4)}
.ax-cell{background:var(--surface,#FBFBF9);padding:7px 8px;min-width:0}
.ax-label{display:block;font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted,#8B8E84)}
.ax-value{display:block;font-family:var(--mono,monospace);font-size:11px;margin-top:2px;
  color:var(--ink-2,#565A50);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ax-ok .ax-value{color:var(--clear,#2E7D46)}
.ax-no .ax-value{color:var(--ink-2,#565A50)}
.ax-binding{box-shadow:inset 0 -2px 0 var(--gate,#B26B12)}
.ax-binding .ax-value{color:var(--gate,#B26B12)}
.ax-verdict{margin:8px 0 0;font-size:12.5px;line-height:1.5;color:var(--ink-2,#565A50)}
.ax-verdict[data-ready="yes"]{color:var(--clear,#2E7D46)}
.ax-verdict b{font-weight:600}
.ax-dense .ax-cell{padding:5px 6px}
@media(max-width:720px){.ax-row{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:400px){.ax-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
