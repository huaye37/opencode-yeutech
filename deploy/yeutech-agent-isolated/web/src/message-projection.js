function attachmentKey(attachments = []) {
  return attachments.map((item) => item.workspacePath || item.path || item.name || "").join("\u0001");
}

function projectionKey(message) {
  return [message.role, Number(message.createdAt || 0), String(message.text || "").trim(), attachmentKey(message.attachments)].join("\u0000");
}

const preference = { runtime: 4, ephemeral: 3, optimistic: 2, passive: 1, history: 0 };

export function dedupeProjectedMessages(messages = []) {
  const selected = new Map();
  for (const message of messages) {
    const key = projectionKey(message);
    const previous = selected.get(key);
    if (!previous || (preference[message.origin] ?? 0) > (preference[previous.origin] ?? 0)) selected.set(key, message);
  }
  return [...selected.values()].sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
}

export function latestProjectedMessageWindow(messages = [], limit = 10) {
  const ordered = dedupeProjectedMessages(messages);
  const size = Math.max(1, Number(limit) || 10);
  const start = Math.max(0, ordered.length - size);
  return { visible: ordered.slice(start), overflow: ordered.slice(0, start) };
}

export function trajectoryForVisibleMessages(trajectory = [], messages = []) {
  if (!messages.length) return [];
  const messageIDs = messages.map((message) => String(message.id || "").replace(/^(?:passive-runtime-|passive-|runtime-)/, "")).filter(Boolean);
  const timestamps = messages.map((message) => Number(message.createdAt || 0)).filter((value) => value > 0);
  const earliest = timestamps.length ? Math.min(...timestamps) : 0;
  return trajectory.filter((item) => {
    if (item?.type === "tool") return messageIDs.some((id) => String(item.id || "").startsWith(`tool:${id}:`));
    if (item?.type === "subagent") return !earliest || Number(item.at || item.createdAt || 0) >= earliest;
    return false;
  });
}
