const READ_ONLY_TOOLS = Object.freeze(["read", "glob", "grep", "list", "lsp"]);

export const REPLAY_POLICY_VERSION = "replay-readonly-v1";
export const REPLAY_READ_ONLY_TOOLS = READ_ONLY_TOOLS;

function toolId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw Object.assign(new Error("Replay tool ID is invalid"), { statusCode: 400, code: "replay_tool_invalid" });
  }
  return id;
}

export function isReplayToolAllowed(value) {
  try { return READ_ONLY_TOOLS.includes(toolId(value)); }
  catch { return false; }
}

export function buildReplayToolPolicy(discoveredToolIds = []) {
  if (!Array.isArray(discoveredToolIds)) {
    throw Object.assign(new Error("Replay tool catalog must be an array"), { statusCode: 400, code: "replay_tool_catalog_invalid" });
  }
  const discovered = [...new Set(discoveredToolIds.map(toolId))].sort();
  const tools = { "*": false };
  for (const id of discovered) if (!isReplayToolAllowed(id)) tools[id] = false;
  for (const id of READ_ONLY_TOOLS) tools[id] = true;
  return {
    version: REPLAY_POLICY_VERSION,
    mode: "deny-by-default",
    tools,
    allow: [...READ_ONLY_TOOLS],
    deniedDiscovered: discovered.filter((id) => !isReplayToolAllowed(id)),
    externalSideEffects: "deny",
    workspaceBoundary: "isolated-replay-directory",
  };
}

export function buildReplayPrompt({ modelId, prompt, discoveredToolIds = [], sourceSessionId = null }) {
  const model = String(modelId || "").trim();
  const text = String(prompt || "").trim();
  if (!model || model.length > 300) throw Object.assign(new Error("Replay model is invalid"), { statusCode: 400, code: "replay_model_invalid" });
  if (!text || text.length > 2_000_000) throw Object.assign(new Error("Replay prompt is invalid"), { statusCode: 400, code: "replay_prompt_invalid" });
  const policy = buildReplayToolPolicy(discoveredToolIds);
  return {
    policy,
    body: {
      model: { providerID: "yeutech", modelID: model },
      tools: policy.tools,
      parts: [{
        type: "text",
        text: `[YEUTECH Replay Lab ${REPLAY_POLICY_VERSION}]\nThis is an isolated, read-only replay${sourceSessionId ? ` of ${String(sourceSessionId)}` : ""}. Use only read, glob, grep, list, and lsp. Do not write files, execute commands, call networks or external services, create tasks, ask questions, or access outside the replay directory.\n[/YEUTECH Replay Lab]\n\n${text}`,
      }],
    },
  };
}

export function auditReplayTrajectory(trajectory = []) {
  if (!Array.isArray(trajectory)) throw new TypeError("Replay trajectory must be an array");
  const violations = [];
  for (const item of trajectory) {
    if (item?.type !== "tool") continue;
    const id = String(item.tool || item.name || item.toolName || "").trim();
    if (!id || !isReplayToolAllowed(id)) {
      violations.push({
        id: item.id ? String(item.id) : null,
        tool: id || "unknown",
        status: item.status ? String(item.status) : null,
        reason: id ? "tool-not-read-only" : "tool-identity-missing",
      });
    }
  }
  return {
    policyVersion: REPLAY_POLICY_VERSION,
    compliant: violations.length === 0,
    violations,
  };
}
