export const DEFAULT_MODEL_ID = "gpt-5.6-sol";

const IMAGE_MODEL_PATTERN = /(?:^|[-_.])image(?:$|[-_.])/i;

export function isConversationModel(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id !== "codex-auto-review" &&
    !IMAGE_MODEL_PATTERN.test(id)
  );
}

export function normalizeModelCatalog(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new TypeError("Model catalog must contain a data array");
  }

  const ids = payload.data
    .map((entry) => entry?.id)
    .filter(isConversationModel);

  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export async function fetchModelCatalog({ baseURL, token, signal }) {
  const response = await fetch(new URL("/v1/models", baseURL), {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Model catalog request failed (${response.status}): ${detail}`);
  }

  return normalizeModelCatalog(await response.json());
}
