/**
 * Register API contract and fail-closed snapshot synchronisation.
 *
 * The mapper's corridor and analytical layers are generated against one exact
 * register build.  A newer records response cannot safely be combined with
 * those older derived layers, even when its shape looks compatible.  This
 * module therefore prepares a complete replacement only when records.json,
 * meta.json and every bundled snapshot identify the same version and build
 * date.  Callers apply the returned value only after this function succeeds.
 */

export const DEFAULT_REGISTER_API =
  "https://yunjiefanresearch-hub.github.io/cross-border-stablecoin-register/api";

export const STRUCTURAL_GATE = Object.freeze({
  claim_class: "tier1_legal",
  status: "in_force",
  evidence_tier: "resolution_text",
});

export const DECISION_READY_GATE = Object.freeze({
  ...STRUCTURAL_GATE,
  source_disposition: "official",
  review_status: "current",
  review_stage: "reconciled",
});

export function normalizeRegisterApi(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/** An explicit empty browser override disables remote verification. */
export function configuredRegisterApi(scope = globalThis) {
  const override = scope && scope.__CBSR_REGISTER_API__;
  if (typeof override === "string") return normalizeRegisterApi(override);
  return DEFAULT_REGISTER_API;
}

function contractError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function object(value, endpoint) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError("invalid_envelope", `${endpoint} must return a JSON object`);
  }
  return value;
}

function isoBuildDate(value, label, allowTimestamp = false) {
  if (typeof value !== "string") {
    throw contractError("invalid_identity", `${label} must be an ISO date`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) {
      return value;
    }
  }
  if (
    allowTimestamp &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  throw contractError("invalid_identity", `${label} is not a valid ISO date${allowTimestamp ? " or timestamp" : ""}`);
}

function readAxis(record, key) {
  if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
    return record[key];
  }
  const freshness = record.freshness;
  return freshness && freshness[key] !== undefined ? freshness[key] : undefined;
}

export function matchesGate(record, gate) {
  return Object.entries(gate).every(([key, expected]) => readAxis(record, key) === expected);
}

function projectRecord(remote, bundled) {
  const source = remote.source && typeof remote.source === "object" ? remote.source : {};
  const projected = {
    ...bundled,
    authority: remote.authority ?? bundled.authority,
    instrument_label_local: remote.instrument_label_local ?? bundled.instrument_label_local,
    requirement_summary: remote.requirement_summary ?? bundled.requirement_summary,
    status: remote.status,
    source_primary: source.primary ?? bundled.source_primary,
    pinpoint: source.pinpoint ?? bundled.pinpoint,
    url: remote.url ?? source.url ?? bundled.url,
    interpretation_note: remote.interpretation_note ?? bundled.interpretation_note,
    tension: remote.tension ?? bundled.tension,
    resolution_channel: remote.resolution_channel ?? bundled.resolution_channel,
    confidence: remote.confidence ?? bundled.confidence,
    claim_class: readAxis(remote, "claim_class"),
    evidence_tier: readAxis(remote, "evidence_tier"),
    binding_status: readAxis(remote, "binding_status"),
    source_disposition: readAxis(remote, "source_disposition"),
    review_status: readAxis(remote, "review_status"),
    review_stage: readAxis(remote, "review_stage"),
  };
  projected.structural_candidate = matchesGate(projected, STRUCTURAL_GATE);
  projected.decision_ready = matchesGate(projected, DECISION_READY_GATE);
  projected.citable = projected.decision_ready;
  return projected;
}

function requireSame(label, values) {
  const present = values.filter((value) => value !== undefined && value !== null && value !== "");
  if (present.length !== values.length) {
    throw contractError("missing_identity", `${label} is required on every snapshot layer`);
  }
  if (new Set(present).size !== 1) {
    throw contractError("snapshot_mismatch", `${label} differs: ${present.join(" / ")}`);
  }
  return present[0];
}

/**
 * Validate both API envelopes and return a complete, immutable-to-the-caller
 * replacement.  No mutation occurs here: a rejected response leaves DATA
 * byte-for-byte on the bundled, internally consistent snapshot.
 */
export function prepareRegisterSync({ recordsPayload, metaPayload, bundledData, compute }) {
  const recordsEnvelope = object(recordsPayload, "records.json");
  const metaEnvelope = object(metaPayload, "meta.json");
  const remoteRecords = recordsEnvelope.data;
  const remoteMeta = metaEnvelope.data;
  if (!Array.isArray(remoteRecords)) {
    throw contractError("invalid_envelope", "records.json.data must be an array");
  }
  object(remoteMeta, "meta.json.data");

  const bundledMeta = object(bundledData && bundledData.meta, "bundled DATA.meta");
  const computeMeta = object(compute && compute._artifact, "bundled COMPUTE._artifact");
  const version = requireSame("version", [
    recordsEnvelope.version,
    metaEnvelope.version,
    remoteMeta.version,
    bundledMeta.version,
    computeMeta.register_version,
  ]);
  const generated = requireSame("generated date", [
    isoBuildDate(recordsEnvelope.generated, "records.json.generated"),
    isoBuildDate(metaEnvelope.generated, "meta.json.generated"),
    isoBuildDate(bundledMeta.generated || bundledMeta.as_of, "DATA.meta.generated", true),
    isoBuildDate(computeMeta.generated, "COMPUTE._artifact.generated", true),
  ]);

  const expectedRecords = bundledData.records || [];
  const declaredCount = remoteMeta.record_count;
  if (!Number.isInteger(declaredCount) || declaredCount !== remoteRecords.length) {
    throw contractError(
      "record_count_mismatch",
      `meta declares ${declaredCount}; records.json contains ${remoteRecords.length}`,
    );
  }
  if (remoteRecords.length !== expectedRecords.length) {
    throw contractError(
      "snapshot_mismatch",
      `remote record count ${remoteRecords.length} differs from bundled ${expectedRecords.length}`,
    );
  }

  const remoteById = new Map();
  for (const record of remoteRecords) {
    if (!record || typeof record.id !== "string" || !record.id) {
      throw contractError("invalid_record", "every API record must have a non-empty id");
    }
    if (remoteById.has(record.id)) {
      throw contractError("duplicate_record", `duplicate API record id ${record.id}`);
    }
    remoteById.set(record.id, record);
  }

  const projected = expectedRecords.map((bundled) => {
    const remote = remoteById.get(bundled.id);
    if (!remote) throw contractError("snapshot_mismatch", `API omitted bundled record ${bundled.id}`);
    remoteById.delete(bundled.id);
    return projectRecord(remote, bundled);
  });
  if (remoteById.size) {
    throw contractError("snapshot_mismatch", `API added unknown record ${remoteById.keys().next().value}`);
  }

  const structural = projected.filter((record) => record.structural_candidate).length;
  const ready = projected.filter((record) => record.decision_ready).length;
  const declaredStructural = remoteMeta.structural_citable_candidates;
  const declaredReady = remoteMeta.citable_count;
  if (!Number.isInteger(declaredStructural) || !Number.isInteger(declaredReady)) {
    throw contractError(
      "missing_gate_counts",
      "meta.json.data must declare integer structural_citable_candidates and citable_count",
    );
  }
  if (declaredStructural !== structural) {
    throw contractError(
      "gate_count_mismatch",
      `meta structural_citable_candidates=${declaredStructural}; six-axis projection=${structural}`,
    );
  }
  if (declaredReady !== ready) {
    throw contractError(
      "gate_count_mismatch",
      `meta citable_count=${declaredReady}; six-axis projection=${ready}`,
    );
  }

  return {
    records: projected,
    meta: {
      ...bundledMeta,
      version,
      generated,
      as_of: generated,
      record_count: projected.length,
      structural_candidate_count: structural,
      decision_ready_count: ready,
      citable_count: ready,
      review_coverage: remoteMeta.review_coverage ?? bundledMeta.review_coverage,
      freshness_counts: remoteMeta.freshness_counts ?? bundledMeta.freshness_counts,
      source_disposition_counts:
        remoteMeta.source_disposition_counts ?? bundledMeta.source_disposition_counts,
    },
    sync: { status: "verified", ok: true, n: projected.length, version, as_of: generated },
  };
}
