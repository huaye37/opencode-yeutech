import { useEffect } from "react";
import { workbenchApi } from "./api.js";
import { reconcileAfterTerminal } from "./message-scroll.js";
import { PERMISSION_MODE_STORAGE_KEY, storedProjectionCursor, storeProjectionCursor, timestampPermissions, isImmediateProjectionEvent, isSettledSessionEvent, runtimeEventError, ephemeralTool, isHistoricalConversation, readableStatus } from "./workbench-helpers.js";

export function useProjectionEvents({ activeRuntimeID, setPermissions, reconcileRef, selected, setMessagesBySession, setPermissionMode, setInsightsBySession, setRunning, updateRunningSession, setStatus, messagesBySession, messageRolesRef }) {
  useEffect(() => {
    if (!activeRuntimeID) {
      setPermissions([]);
      reconcileRef.current = async () => null;
      return undefined;
    }
    let current = true;
    let fallbackTimer;
    let inFlight;
    let settled = false;
    const displayID = selected;
    const historical = isHistoricalConversation(displayID);
    const reconcile = () => {
      if (inFlight) return inFlight;
      inFlight = workbenchApi.snapshot(activeRuntimeID).then((snapshot) => {
        if (!current) return snapshot;
        const runtimeMessages = [
          ...(snapshot.messages || []).map((message) => ({ ...message, id: `runtime-${message.id}`, origin: "runtime" })),
          ...(snapshot.inbox || []).map((message) => ({ ...message, id: `inbox-${message.id}`, origin: "runtime" })),
        ];
        setMessagesBySession((all) => ({ ...all, [displayID]: historical ? [...(all[displayID] || []).filter((item) => item.origin === "history"), ...runtimeMessages] : runtimeMessages }));
        if (["ask", "smart", "full"].includes(snapshot.session?.permissionMode)) {
          setPermissionMode(snapshot.session.permissionMode);
          try { window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, snapshot.session.permissionMode); } catch { /* Preference persistence is optional. */ }
        }
        setPermissions((current) => timestampPermissions(snapshot.permissions, current));
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...snapshot, graph: snapshot.graph || all[displayID]?.graph } }));
        setRunning(Boolean(snapshot.session?.status));
        updateRunningSession(displayID, Boolean(snapshot.session?.status));
        setStatus(snapshot.session?.error?.message || readableStatus(snapshot.session?.status));
        return snapshot;
      }).finally(() => { inFlight = undefined; });
      return inFlight;
    };
    reconcileRef.current = reconcile;
    const cursorKey = `yeutech-agent-workbench:projection:${activeRuntimeID}`;
    const hasCachedProjection = (messagesBySession[displayID] || []).some((item) => item.origin === "runtime" || item.origin === "ephemeral");
    const resumeCursor = hasCachedProjection ? storedProjectionCursor(cursorKey) : 0;
    const events = workbenchApi.events(activeRuntimeID, resumeCursor);
    events.onopen = () => { window.clearInterval(fallbackTimer); fallbackTimer = undefined; setStatus((value) => value === "实时连接中断，正在恢复…" ? "" : value); };
    events.addEventListener("ready", (event) => {
      try { storeProjectionCursor(cursorKey, JSON.parse(event.data)?.cursor); }
      catch { /* A malformed ready marker must not interrupt live events. */ }
    });
    events.addEventListener("durable", (event) => {
      const envelope = JSON.parse(event.data);
      storeProjectionCursor(cursorKey, envelope.cursor);
      if (envelope.type === "message.upsert") {
        const projected = { ...envelope.data, id: `runtime-${envelope.data.id}`, origin: "runtime" };
        messageRolesRef.current.set(envelope.data.id, envelope.data.role);
        setMessagesBySession((all) => {
          const existing = all[displayID] || [];
          const passiveID = `passive-${envelope.data.id}`;
          const next = existing.filter((item) => item.id !== projected.id && item.id !== passiveID && !(["optimistic", "runtime"].includes(item.origin) && item.role === projected.role && item.text === projected.text && (item.origin === "optimistic" || item.queue)));
          return { ...all, [displayID]: [...next, projected].sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0)) };
        });
      } else if (envelope.type === "inbox.queued" && envelope.data.message) {
        const queued = { ...envelope.data.message, id: `inbox-${envelope.data.message.id}`, origin: "runtime" };
        setMessagesBySession((all) => {
          const existing = all[displayID] || [];
          const optimistic = [...existing].reverse().find((item) => item.origin === "optimistic" && item.role === "user" && item.text === queued.text);
          const next = existing.filter((item) => item.id !== queued.id && item.id !== optimistic?.id);
          return { ...all, [displayID]: [...next, queued].sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0)) };
        });
      } else if (envelope.type === "inbox.submitted" && envelope.data.id) {
        setMessagesBySession((all) => ({ ...all, [displayID]: (all[displayID] || []).filter((item) => item.id !== `inbox-${envelope.data.id}`) }));
        if (envelope.data.delivery === "steer") setStatus("补充要求已送入当前任务，Agent 将在下一处理边界吸收。");
      } else if (envelope.type === "session.state") {
        setRunning(Boolean(envelope.data.status)); updateRunningSession(displayID, Boolean(envelope.data.status)); setStatus(envelope.data.error?.message || readableStatus(envelope.data.status));
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...(all[displayID] || {}), session: envelope.data } }));
      } else if (envelope.type === "trajectory.upsert") {
        setInsightsBySession((all) => { const value = all[displayID] || {}; const existing = value.trajectory || []; const previous = existing.find((item) => item.id === envelope.data.id); const projected = { ...previous, ...envelope.data }; const trajectory = [...existing.filter((item) => item.id !== envelope.data.id), projected].sort((a, b) => a.ordinal - b.ordinal); return { ...all, [displayID]: { ...value, trajectory, activity: trajectory } }; });
      } else if (envelope.type === "projection.meta") {
        setPermissions((current) => timestampPermissions(envelope.data.permissions, current));
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...(all[displayID] || {}), ...envelope.data } }));
      } else if (envelope.type === "context.receipt") {
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...(all[displayID] || {}), executionContextReceipt: envelope.data } }));
      }
    });
    events.addEventListener("ephemeral", (event) => {
      const payload = JSON.parse(event.data)?.data;
      const eventType = String(payload?.type || "");
      const eventProperties = payload?.properties || {};
      if (eventType === "permission.asked" && eventProperties.id) {
        setPermissions((current) => {
          const previous = current.find((request) => request.id === eventProperties.id);
          return [...current.filter((request) => request.id !== eventProperties.id), { ...eventProperties, createdAt: previous?.createdAt || Date.now() }];
        });
      } else if (eventType === "permission.replied" && eventProperties.requestID) {
        setPermissions((current) => current.filter((request) => request.id !== eventProperties.requestID));
      }
      const info = payload?.properties?.info;
      if (payload?.type === "message.updated" && info?.id && info?.role) messageRolesRef.current.set(info.id, info.role);
      const part = payload?.properties?.part;
      const messageID = part?.messageID || part?.messageId;
      const hasText = typeof part?.text === "string";
      const hasDelta = typeof part?.delta === "string";
      if (part?.type === "text" && messageID && (hasText || hasDelta)) {
        const id = `runtime-${messageID}`;
        setMessagesBySession((all) => {
          const existing = all[displayID] || [];
          const currentMessage = existing.find((item) => item.id === id);
          const role = messageRolesRef.current.get(messageID) || currentMessage?.role;
          if (role !== "assistant") return all;
          const segmentID = String(part.id || "text");
          const currentSegments = Array.isArray(currentMessage?.segments) ? currentMessage.segments : [];
          const previousSegment = currentSegments.find((segment) => segment.id === segmentID);
          const segmentText = hasText ? part.text : `${previousSegment?.text || ""}${part.delta}`;
          const segment = { ...previousSegment, id: segmentID, type: "text", text: segmentText, at: previousSegment?.at || Number(part?.time?.start || Date.now()), completedAt: Number(part?.time?.end || 0) || null };
          const segments = [...currentSegments.filter((item) => item.id !== segmentID), segment].sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
          const text = segments.filter((item) => item.type === "text").map((item) => item.text).join("");
          const projected = currentMessage
            ? { ...currentMessage, text, segments, streamUpdatedAt: Date.now() }
            : { id, role: "assistant", text, segments, createdAt: Date.now(), streamUpdatedAt: Date.now(), origin: "ephemeral" };
          return { ...all, [displayID]: currentMessage ? existing.map((item) => item.id === id ? projected : item) : [...existing, projected] };
        });
      }
      if (part?.type === "reasoning" && messageID && (hasText || hasDelta)) {
        const id = `runtime-${messageID}`;
        setMessagesBySession((all) => {
          const existing = all[displayID] || [];
          const currentMessage = existing.find((item) => item.id === id);
          const role = messageRolesRef.current.get(messageID) || currentMessage?.role;
          if (role !== "assistant") return all;
          const segmentID = String(part.id || "reasoning");
          const currentSegments = Array.isArray(currentMessage?.segments) ? currentMessage.segments : [];
          const previousSegment = currentSegments.find((segment) => segment.id === segmentID);
          const segmentText = hasText ? part.text : `${previousSegment?.text || ""}${part.delta}`;
          const segment = { ...previousSegment, id: segmentID, type: "reasoning", text: segmentText, at: previousSegment?.at || Number(part?.time?.start || Date.now()), completedAt: Number(part?.time?.end || 0) || null };
          const segments = [...currentSegments.filter((item) => item.id !== segmentID), segment].sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
          const reasoning = segments.filter((item) => item.type === "reasoning").map((item) => item.text).join("");
          const projected = currentMessage
            ? { ...currentMessage, reasoning, segments, reasoningUpdatedAt: Date.now() }
            : { id, role: "assistant", text: "", reasoning, segments, createdAt: Date.now(), reasoningUpdatedAt: Date.now(), origin: "ephemeral" };
          return { ...all, [displayID]: currentMessage ? existing.map((item) => item.id === id ? projected : item) : [...existing, projected] };
        });
      }
      if (part?.type === "tool" && messageID) {
        setInsightsBySession((all) => {
          const value = all[displayID] || {};
          const id = `tool:${messageID}:${part.id || "live"}`;
          const existing = value.trajectory || [];
          const previous = existing.find((item) => item.id === id);
          const projected = { ...ephemeralTool(part, messageID, previous), ordinal: previous?.ordinal || Math.max(0, ...existing.map((item) => Number(item.ordinal || 0))) + 1 };
          const trajectory = [...existing.filter((item) => item.id !== id), projected].sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0));
          return { ...all, [displayID]: { ...value, trajectory, activity: trajectory } };
        });
      }
      if (isImmediateProjectionEvent(payload)) setStatus("正在同步持久事件…");
      if (isSettledSessionEvent(payload)) {
        settled = true;
        setRunning(false);
        updateRunningSession(displayID, false);
        setStatus(runtimeEventError(payload) || "");
        void reconcileAfterTerminal(inFlight, () => current ? reconcile() : null).catch((error) => {
          if (current) setStatus(`最终结果同步失败：${error instanceof Error ? error.message : "未知错误"}`);
        });
      } else if (String(payload?.type || "").startsWith("session.")) {
        settled = false;
      }
    });
    events.onerror = () => {
      if (!current) return;
      if (settled) { setStatus(""); return; }
      setStatus("实时连接中断，正在恢复…");
      void reconcile().catch(() => {});
      if (!fallbackTimer) fallbackTimer = window.setInterval(() => { void reconcile().catch(() => {}); }, 15_000);
    };
    return () => {
      current = false;
      if (reconcileRef.current === reconcile) reconcileRef.current = async () => null;
      events.close(); window.clearInterval(fallbackTimer);
    };
  }, [activeRuntimeID, selected]);
}
