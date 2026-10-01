// Only the authenticated gateway catalog may declare supported reasoning levels.
export function reasoningVariant(model, value) {
  if (value === undefined || value === null || value === "" || value === "default") return undefined;
  if (typeof value !== "string" || !model?.reasoningEfforts?.includes(value)) {
    throw Object.assign(new Error("该模型不支持所选推理强度，请重新选择；不会自动降档"), { statusCode: 400, code: "reasoning_effort_unsupported" });
  }
  return value;
}
