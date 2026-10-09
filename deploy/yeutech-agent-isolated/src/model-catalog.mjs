export function isConversationModel(modelOrID) {
  const id = typeof modelOrID === "string" ? modelOrID : modelOrID?.id;
  if (typeof id !== "string" || id.length === 0) return false;
  if (typeof modelOrID === "string") return true;
  if (Array.isArray(modelOrID?.supportedWorkloads) && !modelOrID.supportedWorkloads.includes("agent")) return false;
  const input = modelOrID?.modalities?.input;
  const output = modelOrID?.modalities?.output;
  return Array.isArray(input) && input.includes("text") && Array.isArray(output) && output.length === 1 && output[0] === "text";
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const CAPABILITY_FIELDS = new Set([
  "id", "object", "created", "owned_by", "type", "display_name", "description",
  "context_length", "max_input_tokens", "max_output_tokens", "supported_parameters",
  "supported_input_modalities", "supported_output_modalities", "supported_workloads", "thinking", "supports_web_search",
  "available", "selectable", "unavailable_reason", "capability_status", "service_tiers",
]);
const CAPABILITY_STATUSES = new Set(["incomplete", "complete", "ready"]);
const CAPABILITY_MODALITIES = new Set(["text", "image", "audio", "video"]);
const CAPABILITY_WORKLOADS = new Set(["conversation", "agent", "review", "image_generation"]);
const UNAVAILABLE_REASONS = new Set(["auth_unavailable", "model_not_found", "credits_required", "cooldown"]);
const UNAVAILABLE_REASON_MESSAGES = {
  auth_unavailable: "当前没有可用的登录授权或 API 凭据",
  model_not_found: "当前路由不支持该模型",
  credits_required: "当前渠道需要补充用量额度",
  cooldown: "当前渠道处于冷却期",
};

function capabilityError(path, message) {
  return new TypeError(`Model capability catalog ${path} ${message}`);
}

function validateInteger(value, field, index) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw capabilityError(`data[${index}].${field}`, "must be a non-negative safe integer");
  }
}

function validateModalities(value, field, index) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw capabilityError(`data[${index}].${field}`, "must be an array");
  if (new Set(value).size !== value.length) throw capabilityError(`data[${index}].${field}`, "must not contain duplicates");
  for (const modality of value) {
    if (!CAPABILITY_MODALITIES.has(modality)) {
      throw capabilityError(`data[${index}].${field}`, `contains unsupported modality: ${String(modality)}`);
    }
  }
}

function validateStringArray(value, field, index) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw capabilityError(`data[${index}].${field}`, "must be an array");
  if (new Set(value).size !== value.length) throw capabilityError(`data[${index}].${field}`, "must not contain duplicates");
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw capabilityError(`data[${index}].${field}`, "must contain non-empty strings");
  }
}

function validateThinking(value, index) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw capabilityError(`data[${index}].thinking`, "must be an object");
  }
  const allowed = new Set(["min", "max", "zero_allowed", "dynamic_allowed", "levels"]);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw capabilityError(`data[${index}].thinking.${unknown}`, "is not allowed by capability-v1");
  for (const field of ["min", "max"]) validateInteger(value[field], `thinking.${field}`, index);
  for (const field of ["zero_allowed", "dynamic_allowed"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw capabilityError(`data[${index}].thinking.${field}`, "must be a boolean");
    }
  }
  validateStringArray(value.levels, "thinking.levels", index);
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    throw capabilityError(`data[${index}].thinking`, "min must not exceed max");
  }
}

function validateServiceTiers(value, index) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw capabilityError(`data[${index}].service_tiers`, "must be an array");
  const ids = value.map((item) => typeof item === "string" ? item : item?.id);
  if (ids.some((id) => id !== "priority" && id !== "ultrafast")) throw capabilityError(`data[${index}].service_tiers`, "contains an unsupported service tier");
  if (new Set(ids).size !== ids.length) throw capabilityError(`data[${index}].service_tiers`, "must not contain duplicates");
}

export function validateCapabilityCatalog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw capabilityError("payload", "must be an object");
  }
  const topLevel = Object.keys(payload);
  const unknownTopLevel = topLevel.find((field) => field !== "data" && field !== "object" && field !== "generation");
  if (unknownTopLevel) throw capabilityError(`payload.${unknownTopLevel}`, "is not allowed by capability-v1");
  if (payload.object !== undefined && payload.object !== "list") throw capabilityError("payload.object", "must be list");
  if (payload.generation !== undefined && (!Number.isSafeInteger(payload.generation) || payload.generation < 0)) {
    throw capabilityError("payload.generation", "must be a non-negative safe integer");
  }
  if (!Array.isArray(payload.data)) throw capabilityError("payload.data", "must be an array");
  payload.data.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw capabilityError(`data[${index}]`, "must be an object");
    const unknown = Object.keys(entry).find((field) => !CAPABILITY_FIELDS.has(field));
    if (unknown) throw capabilityError(`data[${index}].${unknown}`, "is not allowed by capability-v1");
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(entry.id)) {
      throw capabilityError(`data[${index}].id`, "must be a valid model identifier");
    }
    if (entry.object !== undefined && entry.object !== "model_capability") {
      throw capabilityError(`data[${index}].object`, "must be model_capability");
    }
    validateInteger(entry.created, "created", index);
    for (const field of ["owned_by", "type"]) {
      if (entry[field] !== undefined && typeof entry[field] !== "string") {
        throw capabilityError(`data[${index}].${field}`, "must be a string");
      }
    }
    if (entry.display_name !== undefined && (typeof entry.display_name !== "string" || !entry.display_name.trim() || entry.display_name.length > 200)) {
      throw capabilityError(`data[${index}].display_name`, "must be a non-empty string of at most 200 characters");
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw capabilityError(`data[${index}].description`, "must be a string");
    }
    for (const field of ["context_length", "max_input_tokens", "max_output_tokens"]) validateInteger(entry[field], field, index);
    validateStringArray(entry.supported_parameters, "supported_parameters", index);
    for (const field of ["supported_input_modalities", "supported_output_modalities"]) validateModalities(entry[field], field, index);
    validateStringArray(entry.supported_workloads, "supported_workloads", index);
    for (const workload of entry.supported_workloads ?? []) {
      if (!CAPABILITY_WORKLOADS.has(workload)) {
        throw capabilityError(`data[${index}].supported_workloads`, `contains unsupported workload: ${String(workload)}`);
      }
    }
    validateThinking(entry.thinking, index);
    validateServiceTiers(entry.service_tiers, index);
    if (entry.supports_web_search !== undefined && typeof entry.supports_web_search !== "boolean") {
      throw capabilityError(`data[${index}].supports_web_search`, "must be a boolean");
    }
    for (const field of ["available", "selectable"]) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") throw capabilityError(`data[${index}].${field}`, "must be a boolean");
    }
    if (entry.capability_status !== undefined && !CAPABILITY_STATUSES.has(entry.capability_status)) {
      throw capabilityError(`data[${index}].capability_status`, "has an unsupported status");
    }
    if (entry.unavailable_reason !== undefined && !UNAVAILABLE_REASONS.has(entry.unavailable_reason)) {
      throw capabilityError(`data[${index}].unavailable_reason`, "has an unsupported reason");
    }
    if (entry.capability_status === "incomplete" && entry.selectable === true) {
      throw capabilityError(`data[${index}].selectable`, "must be false when capability_status is incomplete");
    }
    if (entry.selectable === true) {
      const required = ["context_length", "max_output_tokens", "supported_input_modalities", "supported_output_modalities"];
      const missing = required.find((field) => entry[field] === undefined);
      if (missing) throw capabilityError(`data[${index}].${missing}`, "is required when selectable is true");
      if (entry.context_length < 1) throw capabilityError(`data[${index}].context_length`, "must be positive when selectable is true");
      if (entry.max_output_tokens < 1) throw capabilityError(`data[${index}].max_output_tokens`, "must be positive when selectable is true");
      if (entry.supported_input_modalities.length === 0) throw capabilityError(`data[${index}].supported_input_modalities`, "must not be empty when selectable is true");
      if (entry.supported_output_modalities.length === 0) throw capabilityError(`data[${index}].supported_output_modalities`, "must not be empty when selectable is true");
    }
  });
  return payload;
}

function adaptLegacyCapabilityCatalog(payload) {
  if (!payload || payload.object !== "list" || !Number.isSafeInteger(payload.generation) || !Array.isArray(payload.data)) {
    return payload;
  }
  return {
    ...payload,
    data: payload.data.map((entry) => {
      if (
        !entry || entry.object !== "model_capability" || entry.selectable !== true ||
        (entry.capability_status !== "ready" && entry.capability_status !== "complete") ||
        !positiveInteger(entry.context_length) || !positiveInteger(entry.max_output_tokens) ||
        entry.supported_input_modalities !== undefined || entry.supported_output_modalities !== undefined
      ) return entry;
      // The deployed pre-capability-v1 producer identifies bounded, ready
      // conversation routes but predates explicit modality fields. Preserve
      // that contract as text-only; never infer image/audio support from IDs.
      return {
        ...entry,
        supported_input_modalities: ["text"],
        supported_output_modalities: ["text"],
      };
    }),
  };
}

export function normalizeModelCatalog(payload) {
  payload = adaptLegacyCapabilityCatalog(payload);
  validateCapabilityCatalog(payload);

  const seen = new Set();
  const models = payload.data.flatMap((entry) => {
    if (typeof entry?.id !== "string" || entry.id.length === 0) return [];
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);

    const output = positiveInteger(entry.max_output_tokens);
    const context = positiveInteger(entry.context_length);
    // Preserve the provider's standalone input ceiling. The OpenCode config
    // generator reserves response space when deriving its compaction trigger.
    const hasDeclaredInput = Object.hasOwn(entry, "max_input_tokens");
    const declaredInput = positiveInteger(entry.max_input_tokens);
    const input = !context || !output || context <= output ? null
      : hasDeclaredInput ? (declaredInput ? Math.min(declaredInput, context) : null) : context;
    const modalities = {
      input: Array.isArray(entry.supported_input_modalities) ? entry.supported_input_modalities : [],
      output: Array.isArray(entry.supported_output_modalities) ? entry.supported_output_modalities : [],
    };
    const supportedWorkloads = Array.isArray(entry.supported_workloads) ? entry.supported_workloads : undefined;
    const normalized = { id: entry.id, modalities, ...(supportedWorkloads ? { supportedWorkloads } : {}) };
    const explicitlyNonConversation = (supportedWorkloads || (modalities.input.length > 0 && modalities.output.length > 0)) && !isConversationModel(normalized);
    let disabledReason = "";
    if (entry.available === false) disabledReason = UNAVAILABLE_REASON_MESSAGES[entry.unavailable_reason] || "模型当前不可用";
    else if (explicitlyNonConversation) disabledReason = "当前工作台不支持该模型类型";
    else if (entry.selectable === false || entry.capability_status === "incomplete" || !context || !input || !output) {
      disabledReason = "能力信息待补全";
    } else if (!isConversationModel(normalized)) {
      disabledReason = "当前工作台不支持该模型类型";
    }

    return [{
      id: entry.id,
      name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : entry.id,
      available: entry.available !== false,
      selectable: disabledReason === "",
      disabledReason: disabledReason || null,
      limit: context && input && output ? { context, input, output } : null,
      modalities,
      ...(entry.thinking?.levels?.length ? { reasoningEfforts: [...entry.thinking.levels] } : {}),
      ...(entry.service_tiers?.length ? { serviceTiers: entry.service_tiers.map((item) => typeof item === "string" ? item : item.id) } : {}),
      ...(supportedWorkloads ? { supportedWorkloads } : {}),
    }];
  });

  return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function runnableModels(models) {
  return models.filter((model) => isConversationModel(model) && model.selectable && model.limit?.context > 0);
}

export function selectDefaultModel(models, preferredID) {
  const runnable = runnableModels(models);
  const preferred = preferredID ? runnable.find((model) => model.id === preferredID) : null;
  if (preferred) return { id: preferred.id, reason: "configured_preference" };
  if (runnable[0]) return { id: runnable[0].id, reason: "first_runnable" };
  return { id: null, reason: "no_runnable_model" };
}

export async function fetchModelCatalog({ baseURL, token, signal, timeoutMs = 5_000 }) {
  const response = await fetch(new URL("/v1/model-capabilities", baseURL), {
    headers: { authorization: `Bearer ${token}` },
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Model catalog request failed (${response.status}): ${detail}`);
  }

  return normalizeModelCatalog(await response.json());
}
