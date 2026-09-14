import { createHash } from "node:crypto";

export const WORKLOAD_PROFILES = Object.freeze([
  {
    id: "general-agent",
    name: "通用 Agent",
    requires: { input: ["text"], output: ["text"], tools: true, minContext: 32_000 },
    policy: { context: "balanced", failover: "before-dispatch-only" },
    evidence: ["generation", "result"],
  },
  {
    id: "agent-code",
    name: "代码与发布",
    requires: { input: ["text"], output: ["text"], tools: true, minContext: 64_000 },
    policy: { context: "workspace-grounded", failover: "before-dispatch-only" },
    evidence: ["generation", "diff", "test"],
  },
  {
    id: "novel-writing",
    name: "小说创作",
    requires: { input: ["text"], output: ["text"], tools: false, minContext: 128_000 },
    policy: { context: "long-form-continuity", failover: "before-dispatch-only" },
    evidence: ["generation", "candidate", "context-pack"],
  },
  {
    id: "kaoyan-system",
    name: "考研辅导",
    requires: { input: ["text"], output: ["text"], tools: false, minContext: 64_000 },
    policy: { context: "source-grounded", failover: "before-dispatch-only" },
    evidence: ["generation", "source", "answer-separation"],
  },
]);

export function workloadProfile(id) {
  return WORKLOAD_PROFILES.find((profile) => profile.id === id) || WORKLOAD_PROFILES[0];
}

export function modelEligibility(model, profileID = "general-agent") {
  const profile = workloadProfile(profileID);
  const input = new Set(model?.modalities?.input || []);
  const output = new Set(model?.modalities?.output || []);
  const reasons = [];
  for (const modality of profile.requires.input) if (!input.has(modality)) reasons.push(`missing-input:${modality}`);
  for (const modality of profile.requires.output) if (!output.has(modality)) reasons.push(`missing-output:${modality}`);
  if (!Number.isSafeInteger(model?.limit?.context) || model.limit.context < profile.requires.minContext) reasons.push("context-too-small");
  if (profile.requires.tools && model?.capabilities?.tools !== true) reasons.push("tools-unverified");
  if (model?.selectable !== true) reasons.push("catalog-not-selectable");
  const runtimeStatus = model?.runtimeCompatibility?.status || "untested";
  if (runtimeStatus !== "verified") reasons.push(`runtime-${runtimeStatus}`);
  return {
    modelId: String(model?.id || ""),
    workload: profile.id,
    lifecycle: {
      discovered: Boolean(model?.id),
      metadataReady: Boolean(model?.limit?.context && input.size && output.size),
      runtime: runtimeStatus,
      workloadApproved: reasons.length === 0,
    },
    eligible: reasons.length === 0,
    reasons,
  };
}

export function evaluateEvidence(profileID, records = []) {
  const profile = workloadProfile(profileID);
  const latestByType = new Map();
  for (const record of records) {
    if (!record || typeof record.type !== "string") continue;
    latestByType.set(record.type, record);
  }
  const checks = profile.evidence.map((type) => {
    const record = latestByType.get(type);
    return {
      type,
      passed: record?.status === "passed",
      reference: record?.reference || null,
      recordedAt: record?.recordedAt || null,
    };
  });
  const generated = latestByType.get("generation")?.status === "passed";
  return {
    workload: profile.id,
    state: checks.every((check) => check.passed) ? "deliverable-ready" : generated ? "generation-settled" : "in-progress",
    interpretation: "recorded-evidence-only",
    userAcceptance: "not-evaluated",
    checks,
    missing: checks.filter((check) => !check.passed).map((check) => check.type),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function buildContextPack({ projectId, revision, sources = [], schema = "general-v1" }) {
  if (!projectId || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Context Pack requires a project and positive revision");
  const normalizedSources = sources.map((source) => {
    if (!source?.path || !source?.version) throw new Error("Context Pack sources require path and version references");
    return { path: String(source.path), version: String(source.version), hash: source.hash ? String(source.hash) : null, kind: String(source.kind || "project-file") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const body = { schema, projectId: String(projectId), revision, sources: normalizedSources };
  return {
    ...body,
    kind: "verified-source-receipt",
    appliedToExecution: false,
    persisted: false,
    hash: createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex"),
  };
}

export function compareReplay(baseline, candidate) {
  const lowerBetter = new Set(["ttftMs", "durationMs", "tokens", "cost"]);
  const keys = new Set([...Object.keys(baseline?.metrics || {}), ...Object.keys(candidate?.metrics || {})]);
  const metrics = {};
  for (const key of keys) {
    const before = Number(baseline?.metrics?.[key]);
    const after = Number(candidate?.metrics?.[key]);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const delta = after - before;
    metrics[key] = { baseline: before, candidate: after, delta, improved: lowerBetter.has(key) ? delta < 0 : delta > 0 };
  }
  return {
    kind: "metric-snapshot-comparison",
    executedReplay: false,
    persisted: false,
    baselineId: baseline?.id || null,
    candidateId: candidate?.id || null,
    metrics,
  };
}

export function runtimeBudget(options = {}) {
  const totalMemoryMb = Number(options.totalMemoryMb ?? 16 * 1024);
  const reservedMemoryMb = Number(options.reservedMemoryMb ?? 6 * 1024);
  const systemWorkerMb = Number(options.systemWorkerMb ?? 500);
  const interactiveWorkerMb = Number(options.interactiveWorkerMb ?? 500);
  const usableMemoryMb = Math.max(0, totalMemoryMb - reservedMemoryMb - systemWorkerMb);
  const maxInteractiveWorkers = Math.max(0, Math.floor(usableMemoryMb / interactiveWorkerMb));
  const requested = Math.max(0, Number(options.requestedInteractiveWorkers ?? 0));
  return {
    totalMemoryMb,
    reservedMemoryMb,
    systemWorkerMb,
    interactiveWorkerMb,
    usableMemoryMb,
    maxInteractiveWorkers,
    requestedInteractiveWorkers: requested,
    withinBudget: requested <= maxInteractiveWorkers,
    overflowWorkers: Math.max(0, requested - maxInteractiveWorkers),
  };
}
