// Only the authenticated gateway catalog may declare supported reasoning levels.
export function reasoningVariant(model, value) {
  if (value === undefined || value === null || value === "" || value === "default") return undefined;
  if (typeof value !== "string" || !model?.reasoningEfforts?.includes(value)) {
    throw Object.assign(new Error("该模型不支持所选推理强度，请重新选择；不会自动降档"), { statusCode: 400, code: "reasoning_effort_unsupported" });
  }
  return value;
}

export function serviceTier(model, value) {
  if (value === undefined || value === null || value === "" || value === "default") return undefined;
  if (typeof value !== "string" || !model?.serviceTiers?.includes(value)) {
    throw Object.assign(new Error("该模型不支持所选响应速度，请重新选择；不会自动回退"), { statusCode: 400, code: "service_tier_unsupported" });
  }
  return value;
}

export function modelVariant(model, reasoningValue, serviceTierValue) {
  const reasoning = reasoningVariant(model, reasoningValue);
  const tier = serviceTier(model, serviceTierValue);
  if (!tier) return reasoning;
  return reasoning ? `${reasoning}--service-${tier}` : `service-${tier}`;
}
