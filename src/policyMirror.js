/* ============================================================================
   policyMirror.js — a faithful, offline mirror of cbsr_mcp/policy.py

   WHY A MIRROR AND NOT A CALL
   ---------------------------
   The mapper is a static build with no server. The authoritative engine is
   `evaluate_policy()` in the Python package, reached over MCP. This module
   reproduces its GATE ORDER and OUTCOME VOCABULARY exactly so the mapper can
   demonstrate the decision surface offline, with no model call and no network.

   It is labelled `preview: true` in every result and it never claims to be the
   engine. Where the Python engine and this mirror could disagree, the Python
   engine wins; `engine_parity` records which engine version this was written
   against so a drift is visible rather than silent.

   WHAT IT DELIBERATELY DOES NOT DO
   --------------------------------
   * It does not authorize anything. `execution_authorized` is a hard false.
   * It does not invent evidence. Evidence rows come from the register snapshot.
   * It does not soften an outcome. A missing field is insufficient_evidence,
     not a guess.
   ========================================================================= */

export const ENGINE_VERSION = "cbsr-policy-engine/1.1.0";
export const RULESET_VERSION = "cbsr-stablecoin-rules/1.1.0";
export const MIRROR_VERSION = "cbsr-policy-mirror/1.1.0";

export const OUTCOMES = [
  "allow",
  "allow_with_conditions",
  "review_required",
  "prohibited",
  "insufficient_evidence",
];

/* The stablecoin domain pack's default dimension set and obligation catalog,
   transcribed from domain_packs/stablecoin/manifest.json. Kept as data so a
   second pack can be dropped in beside it without touching the gate logic. */
export const STABLECOIN_PACK = {
  name: "stablecoin",
  ruleset_version: RULESET_VERSION,
  default_dimensions: [
    "issuer_pathway",
    "reserve_backing",
    "redemption",
    "aml_kyc",
    "cross_border_data",
    "distribution",
  ],
  obligations: {
    aml_kyc: "verify_applicable_aml_kyc_and_sanctions_controls",
    cross_border_data: "verify_cross_border_data_transfer_basis",
    distribution: "verify_distribution_and_offering_permissions",
    issuer_pathway: "verify_issuer_and_intermediary_authorizations",
    reserve_backing: "verify_reserve_composition_custody_and_attestation",
    redemption: "verify_redemption_rights_timing_and_par_value",
    permitted_activity_yield: "verify_yield_and_interest_restrictions",
    capital_requirements: "verify_capital_liquidity_and_safeguarding",
  },
};

const UNCERTAINTY_ORDER = { low: 0, medium: 1, mixed: 2, high: 3, unknown: 4 };

const uniqSorted = (values) =>
  Array.from(new Set(values.filter((v) => v !== undefined && v !== null && v !== ""))).sort();

function isoDate(value) {
  if (typeof value !== "string" || value.length < 10) return null;
  const d = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : value.slice(0, 10);
}

function freshnessSnapshot(rows, asOf) {
  const counts = { current: 0, due_for_review: 0, stale: 0, unknown: 0 };
  rows.forEach((r) => {
    const key = r.review_status || "unknown";
    if (counts[key] === undefined) counts.unknown += 1;
    else counts[key] += 1;
  });
  return { as_of: asOf, ...counts };
}

function worstUncertainty(rows) {
  if (!rows.length) return "unknown";
  return rows.reduce((worst, r) => {
    const v = r.confidence === "low" ? "high" : r.confidence === "high" ? "low" : "medium";
    return (UNCERTAINTY_ORDER[v] ?? 4) > (UNCERTAINTY_ORDER[worst] ?? 4) ? v : worst;
  }, "low");
}

/* Project one snapshot record into the rule-evidence shape a receipt carries.
   Every field here already exists on the record; nothing is derived. */
function ruleEvidence(rec) {
  return {
    rule_id: rec.dimension + "@" + rec.jur,
    record_id: rec.id,
    jurisdiction: rec.jur,
    dimension: rec.dimension,
    claim_class: rec.claim_class,
    evidence_tier: rec.evidence_tier,
    binding_status: rec.binding_status,
    status: rec.status,
    source_disposition: rec.source_disposition,
    review_status: rec.review_status,
    review_stage: rec.review_stage,
    source_url: rec.url || null,
    pinpoint: rec.pinpoint || null,
    decision_ready: !!rec.decision_ready,
  };
}

function result(outcome, reasons, rows, opts) {
  const o = opts || {};
  const rules = rows
    .map(ruleEvidence)
    .sort((a, b) => (a.rule_id + a.record_id).localeCompare(b.rule_id + b.record_id));
  return {
    outcome,
    /* The non-negotiable boundary. Not a field the caller can influence. */
    execution_authorized: false,
    preview: true,
    reasons: uniqSorted(reasons),
    conditions: uniqSorted(o.conditions || []),
    obligations: uniqSorted(o.obligations || []),
    assumptions: uniqSorted(o.assumptions || []),
    conflicts: o.conflicts || [],
    applicable_rules: rules,
    evidence_ids: uniqSorted(rules.map((r) => r.record_id)),
    source_urls: uniqSorted(rules.map((r) => r.source_url)),
    freshness_snapshot: freshnessSnapshot(rules, o.as_of),
    uncertainty: worstUncertainty(rows),
    mandate_id: o.mandate_id || null,
    mandate_version: o.mandate_version || null,
    engine_version: ENGINE_VERSION,
    ruleset_version: RULESET_VERSION,
    mirror_version: MIRROR_VERSION,
    engine_parity: "mirrors " + ENGINE_VERSION + "; the Python engine is authoritative",
    requested_as_of: o.as_of,
    evaluated_at: o.as_of + "T00:00:00Z",
    non_legal_advice_notice:
      "Decision support only. This is not legal advice, transaction approval, or execution authority.",
  };
}

function inputFailure(reason, asOf) {
  return result("insufficient_evidence", [reason], [], {
    as_of: asOf || "1970-01-01",
    assumptions: ["caller_input_is_untrusted", "offline_snapshot_only"],
  });
}

/**
 * Evaluate an action against a mandate and the register's evidence.
 * Gate order is transcribed from policy.py and must not be reordered:
 * input completeness -> mandate validity -> mandate scope -> evidence presence
 * -> regulatory prohibition -> evidence-quality reasons -> conditions.
 */
export function evaluateAction(action, records, asOf) {
  const today = isoDate(asOf) || isoDate(new Date().toISOString());

  /* ---- 1. input completeness ------------------------------------------- */
  const required = ["action_id", "origin", "destination", "asset", "amount", "actor", "mandate"];
  const missing = required.filter((k) => {
    const v = action[k];
    return v === undefined || v === null || v === "" || (typeof v === "object" && !Object.keys(v).length);
  });
  if (missing.length) return inputFailure("missing_context:" + missing.sort().join(","), today);

  const origin = String(action.origin || "").toUpperCase();
  const destination = String(action.destination || "").toUpperCase();
  if (origin.length !== 2 || destination.length !== 2)
    return inputFailure("jurisdiction_codes_must_be_iso_alpha_2", today);
  if (origin === destination) return inputFailure("domain_validation:origin_and_destination_must_differ", today);
  if (!String(action.asset || "").trim())
    return inputFailure("domain_validation:stablecoin_asset_is_required", today);

  const amount = Number(action.amount);
  if (!Number.isFinite(amount)) return inputFailure("amount_must_be_non_negative_number", today);
  if (amount < 0) return inputFailure("amount_must_be_non_negative_number", today);

  const mandate = action.mandate || {};
  const mandateGaps = [];
  if (!mandate.mandate_id) mandateGaps.push("mandate_id");
  if (!mandate.version) mandateGaps.push("version");
  if (mandateGaps.length) return inputFailure("incomplete_mandate:" + mandateGaps.join(","), today);

  /* ---- 2. select the evidence the action actually depends on ------------ */
  const dimensions = (action.required_dimensions && action.required_dimensions.length
    ? action.required_dimensions
    : STABLECOIN_PACK.default_dimensions
  ).slice();
  const rows = records.filter(
    (r) => (r.jur === origin || r.jur === destination) && dimensions.indexOf(r.dimension) !== -1
  );

  const obligations = dimensions
    .map((d) => STABLECOIN_PACK.obligations[d])
    .filter(Boolean);
  const assumptions = [
    "evaluation_as_of:" + today,
    "offline_committed_snapshot",
    "audit_identity_is_asserted_not_authenticated_by_cbsr",
  ];
  const base = {
    as_of: today,
    obligations,
    assumptions,
    mandate_id: mandate.mandate_id,
    mandate_version: mandate.version,
  };
  const decided = (outcome, reason, extra) =>
    result(outcome, [reason], rows, Object.assign({}, base, extra || {}));

  /* ---- 3. mandate validity --------------------------------------------- */
  if (mandate.revoked || mandate.active === false)
    return decided("prohibited", "mandate_revoked_or_inactive");
  if (mandate.valid_from && isoDate(mandate.valid_from) > today)
    return decided("prohibited", "mandate_not_yet_valid");
  if (mandate.valid_until && isoDate(mandate.valid_until) < today)
    return decided("prohibited", "mandate_expired");

  /* ---- 4. mandate scope ------------------------------------------------- */
  const requested = [origin, destination];
  const prohibited = mandate.prohibited_jurisdictions || [];
  if (requested.some((j) => prohibited.indexOf(j) !== -1))
    return decided("prohibited", "prohibited_jurisdiction_in_mandate");
  if (mandate.max_amount != null && amount > Number(mandate.max_amount))
    return decided("prohibited", "amount_exceeds_mandate");
  if (mandate.assets && mandate.assets.length && mandate.assets.indexOf(action.asset) === -1)
    return decided("prohibited", "asset_outside_mandate");
  if (
    mandate.jurisdictions &&
    mandate.jurisdictions.length &&
    !requested.every((j) => mandate.jurisdictions.indexOf(j) !== -1)
  )
    return decided("prohibited", "jurisdiction_outside_mandate");
  if (
    mandate.counterparties &&
    mandate.counterparties.length &&
    mandate.counterparties.indexOf(action.counterparty) === -1
  )
    return decided("prohibited", "counterparty_outside_mandate");

  /* ---- 5. evidence must exist before anything is allowed ---------------- */
  if (!rows.length)
    return result("insufficient_evidence", ["no_applicable_regulatory_evidence"], [], base);

  /* ---- 6. a standing prohibition ends the evaluation --------------------- */
  if (rows.some((r) => r.binding_status === "prohibition"))
    return decided("prohibited", "applicable_regulatory_prohibition");

  /* ---- 7. evidence-quality reasons -> review_required -------------------
     This is the block that produces the register's headline result. With
     review_status unknown/stale across the snapshot and no reconciled second
     review anywhere, a well-formed request correctly lands on review_required
     rather than allow. That is the system working, not failing.            */
  const reasons = [];
  const conditions = [];
  const review = mandate.human_review || {};

  if (
    review.required ||
    (review.amount_threshold != null && amount >= Number(review.amount_threshold)) ||
    (review.jurisdictions || []).some((j) => requested.indexOf(j) !== -1) ||
    (review.dimensions || []).some((d) => dimensions.indexOf(d) !== -1)
  )
    conditions.push("obtain_human_approval");
  if (action.requires_kyc) conditions.push("complete_kyc_before_execution");

  if (rows.some((r) => ["stale", "due_for_review", "unknown", null, undefined].indexOf(r.review_status) !== -1))
    reasons.push("evidence_not_current");
  if (rows.some((r) => r.review_stage !== "reconciled"))
    reasons.push("independent_second_review_incomplete");
  if (rows.some((r) => ["proposed", "consultation", "transitional", "superseded"].indexOf(r.status) !== -1))
    reasons.push("non_final_transitional_or_superseded_rule");
  if (
    rows.some(
      (r) =>
        ["pending_proposal", "made_not_commenced", "finalized_policy_pending", "no_regime"].indexOf(
          r.binding_status
        ) !== -1
    )
  )
    reasons.push("rule_not_operative");

  /* declared and detected conflicts, per (jurisdiction × dimension) cell */
  const cells = {};
  rows.forEach((r) => {
    const key = r.jur + "\u0000" + r.dimension;
    (cells[key] = cells[key] || []).push(r);
  });
  const conflicts = [];
  Object.keys(cells)
    .sort()
    .forEach((key) => {
      const cell = cells[key];
      const statuses = uniqSorted(cell.map((r) => r.binding_status));
      if (statuses.length > 1) {
        const [jurisdiction, dimension] = key.split("\u0000");
        conflicts.push({
          jurisdiction,
          dimension,
          binding_statuses: statuses,
          record_ids: uniqSorted(cell.map((r) => r.id)),
        });
      }
    });
  if (conflicts.length) reasons.push("conflicting_evidence");

  if (reasons.length)
    return result(
      "review_required",
      reasons,
      rows,
      Object.assign({}, base, { conditions, conflicts })
    );

  if (conditions.length)
    return result(
      "allow_with_conditions",
      ["operative_current_reconciled_evidence"],
      rows,
      Object.assign({}, base, { conditions })
    );

  return result("allow", ["operative_current_reconciled_evidence"], rows, base);
}

/* ---------------------------------------------------------------- receipt --
   A receipt is a deterministic restatement of the decision plus the evidence
   it rested on. It is NOT a signature and NOT an authorization: it exists so a
   later reader can reconstruct why a decision came out the way it did, and
   detect if any field was altered afterwards.                              */

/* FNV-1a over the canonical JSON. A checksum, not a cryptographic digest —
   it detects accidental mutation, and the label says exactly that. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ("00000000" + hash.toString(16)).slice(-8);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}

export function createReceipt(action, decision, datasetVersion) {
  const body = {
    schema: "cbsr/policy-receipt/v1",
    action: {
      action_id: action.action_id,
      origin: String(action.origin || "").toUpperCase(),
      destination: String(action.destination || "").toUpperCase(),
      asset: action.asset,
      amount: action.amount,
      actor: action.actor,
      counterparty: action.counterparty || null,
    },
    decision: {
      outcome: decision.outcome,
      execution_authorized: false,
      reasons: decision.reasons,
      conditions: decision.conditions,
      uncertainty: decision.uncertainty,
    },
    applicable_rules: decision.applicable_rules.map((r) => r.record_id),
    source_urls: decision.source_urls,
    freshness_snapshot: decision.freshness_snapshot,
    assumptions: decision.assumptions,
    mandate_id: decision.mandate_id,
    mandate_version: decision.mandate_version,
    audit_identity: {
      asserted_by: action.actor,
      authenticated_by_cbsr: false,
    },
    dataset_version: datasetVersion,
    engine_version: decision.engine_version,
    ruleset_version: decision.ruleset_version,
    mirror_version: decision.mirror_version,
    requested_as_of: decision.requested_as_of,
    generated_at: decision.evaluated_at,
    non_legal_advice_notice: decision.non_legal_advice_notice,
  };
  return Object.assign({}, body, {
    integrity: {
      algorithm: "fnv1a-32-over-canonical-json",
      note: "tamper-evidence checksum, not a cryptographic signature",
      checksum: fnv1a(canonical(body)),
    },
  });
}

export function verifyReceipt(receipt) {
  if (!receipt || !receipt.integrity) return { valid: false, reason: "no_integrity_block" };
  const { integrity, ...body } = receipt;
  const recomputed = fnv1a(canonical(body));
  return recomputed === integrity.checksum
    ? { valid: true, checksum: recomputed }
    : { valid: false, reason: "checksum_mismatch", expected: integrity.checksum, recomputed };
}
