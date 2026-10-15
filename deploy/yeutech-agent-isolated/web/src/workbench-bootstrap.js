import { migrationApi, workbenchApi } from "./api.js";
import { sortSessionsByUpdatedAt } from "./session-ordering.js";
import { isHistoricalConversation, readableStatus } from "./workbench-helpers.js";

export function createWorkbenchBootstrap({ cachedSelection, projects, setProjects, conversations, setConversations, standaloneSessions, setStandaloneSessions, setSelected, setSelectedProject, setExpandedProjects, setRuntimeSessions, setRuntimeEnabledSessions, setModels, setModel, setReasoningPreferences, setServiceTierPreferences, setModelReload, setRunning, setRunningSessionIds, setStatus, setBootstrapping, setBootstrapError, refreshVersion, selectedRef }) {
  const refresh = async () => {
    const currentRefresh = ++refreshVersion.current;
    if (!projects.length && !conversations.length && !standaloneSessions.length) setBootstrapping(true);
    setBootstrapError("");
    const migrationResults = Promise.allSettled([migrationApi.projects(), migrationApi.conversations()]);
    try {
      const bootstrap = await workbenchApi.bootstrap();
      if (currentRefresh !== refreshVersion.current) return;
      const remoteSessions = Array.isArray(bootstrap.sessions) ? bootstrap.sessions : [];
      const workspaceProjects = Array.isArray(bootstrap.projects) ? bootstrap.projects : [];
      const states = bootstrap.states || {};
      const catalog = Array.isArray(bootstrap.models) ? bootstrap.models : [];
      const selectable = catalog.filter((item) => item.selectable);
      setModels(catalog);
      setModelReload(bootstrap.reload || { status: "unknown" });
      setModel((current) => selectable.some((item) => item.id === current) ? current : bootstrap.defaultModel?.id || selectable[0]?.id || "");
      setReasoningPreferences(Object.fromEntries(Object.entries(bootstrap.sessionPreferences || {}).map(([id, value]) => [id, value.reasoningEffort || ""])));
      setServiceTierPreferences(Object.fromEntries(Object.entries(bootstrap.sessionPreferences || {}).map(([id, value]) => [id, value.serviceTier || ""])));
      const runtimeSession = (item) => ({ id: item.id, ...(item.projectId ? { projectId: item.projectId } : {}), title: item.title || "新会话", model: bootstrap.sessionPreferences?.[item.id]?.modelId || item.model?.modelID || item.model?.id || bootstrap.defaultModel?.id || selectable[0]?.id, updatedAt: Number(item.time?.updated || item.time?.created), runtimeSessionId: item.id });
      const initialConversations = sortSessionsByUpdatedAt(remoteSessions.filter((item) => item.projectId).map(runtimeSession));
      const initialStandalone = sortSessionsByUpdatedAt(remoteSessions.filter((item) => !item.projectId).map(runtimeSession));
      const initialIDs = new Set([...initialConversations, ...initialStandalone].map((item) => item.id));
      const desiredSelection = selectedRef.current;
      const initialSelection = initialIDs.has(desiredSelection) || isHistoricalConversation(desiredSelection)
        ? desiredSelection
        : initialConversations[0]?.id || initialStandalone[0]?.id || "";
      const initialProject = initialConversations.find((item) => item.id === initialSelection)?.projectId || (isHistoricalConversation(initialSelection) ? cachedSelection.projectId : "");
      const initialRunning = new Set([...initialConversations, ...initialStandalone].filter((item) => Boolean(states[item.id])).map((item) => item.id));
      setProjects(workspaceProjects);
      setConversations(initialConversations);
      setStandaloneSessions(initialStandalone);
      setRuntimeSessions({});
      setRunningSessionIds(initialRunning);
      setRuntimeEnabledSessions(initialRunning);
      setSelected(initialSelection);
      setSelectedProject(initialProject);
      selectedRef.current = initialSelection;
      if (initialProject) setExpandedProjects((current) => new Set([...current, initialProject]));
      setRunning(Boolean(states[initialSelection]));
      setStatus(readableStatus(states[initialSelection]));
      setBootstrapping(false);

      const [migrationProjectsResult, migrationConversationsResult] = await migrationResults;
      if (currentRefresh !== refreshVersion.current) return;
      const historicalProjects = migrationProjectsResult.status === "fulfilled" ? migrationProjectsResult.value : [];
      const historicalConversations = migrationConversationsResult.status === "fulfilled" ? migrationConversationsResult.value : [];
      const projectMap = new Map(historicalProjects.filter((value) => !value.id.startsWith("standalone:")).map((item) => [item.id, { ...item, registered: true }]));
      for (const item of workspaceProjects) projectMap.set(item.id || `directory:${item.workspaceDirectory}`, { ...(item.id ? projectMap.get(item.id) : null), ...item, availableLocally: true });
      const nextRuntime = Object.fromEntries(historicalConversations.filter((item) => item.runtimeSessionId).map((item) => [item.id, item.runtimeSessionId]));
      const mappedIDs = new Set(Object.values(nextRuntime));
      const remoteByID = new Map(remoteSessions.map((item) => [item.id, item]));
      const currentHistorical = historicalConversations.map((item) => {
        const remote = item.runtimeSessionId ? remoteByID.get(item.runtimeSessionId) : null;
        const preferredModel = bootstrap.sessionPreferences?.[item.id]?.modelId || bootstrap.sessionPreferences?.[item.runtimeSessionId]?.modelId;
        if (!remote) return preferredModel ? { ...item, model: preferredModel } : item;
        return {
          ...item,
          title: remote.title || item.title,
          model: preferredModel || remote.model?.modelID || remote.model?.id || item.model,
          updatedAt: Math.max(Number(item.updatedAt || 0), Number(remote.time?.updated || remote.time?.created || 0)),
        };
      });
      const nextConversations = sortSessionsByUpdatedAt([
        ...currentHistorical.filter((item) => !String(item.projectId || "").startsWith("standalone:")),
        ...remoteSessions.filter((item) => item.projectId && !mappedIDs.has(item.id)).map(runtimeSession),
      ]);
      const nextStandalone = sortSessionsByUpdatedAt([
        ...currentHistorical.filter((item) => String(item.projectId || "").startsWith("standalone:")),
        ...remoteSessions.filter((item) => !item.projectId && !mappedIDs.has(item.id)).map(runtimeSession),
      ]);
      const nextRunningSessionIds = new Set([...nextConversations, ...nextStandalone].filter((item) => {
        const runtimeID = nextRuntime[item.id] || (!isHistoricalConversation(item.id) && !item.id.startsWith("ses_local") ? item.id : "");
        return runtimeID && Boolean(states[runtimeID]);
      }).map((item) => item.id));
      const validIDs = new Set([...nextConversations.map((item) => item.id), ...nextStandalone.map((item) => item.id)]);
      const fallback = nextConversations[0]?.id || nextStandalone[0]?.id || "";
      const nextSelected = validIDs.has(selectedRef.current) ? selectedRef.current : fallback;
      const activeConversation = nextConversations.find((item) => item.id === nextSelected);
      setProjects([...projectMap.values()]); setConversations(nextConversations); setRuntimeSessions(nextRuntime); setStandaloneSessions(nextStandalone); setRunningSessionIds(nextRunningSessionIds); setRuntimeEnabledSessions(nextRunningSessionIds); setSelected(nextSelected);
      selectedRef.current = nextSelected;
      const activeProjectID = activeConversation && !activeConversation.projectId.startsWith("standalone:") ? activeConversation.projectId : "";
      setSelectedProject(activeProjectID);
      if (activeProjectID) setExpandedProjects((current) => new Set([...current, activeProjectID]));
      const activeRuntimeID = nextRuntime[nextSelected] || nextSelected;
      setRunning(Boolean(states[activeRuntimeID])); setStatus(readableStatus(states[activeRuntimeID]));
      const historyFailures = [migrationProjectsResult, migrationConversationsResult].filter((item) => item.status === "rejected");
      if (historyFailures.length) setStatus("工作区已可用，但部分历史会话读取超时；可稍后刷新。");
    } catch (error) {
      if (currentRefresh !== refreshVersion.current) return;
      const message = error instanceof Error ? error.message : "本地 Agent 暂时无法连接。";
      setBootstrapError(message);
      setStatus(message);
    } finally {
      if (currentRefresh === refreshVersion.current) setBootstrapping(false);
    }
  };

  return { refresh };
}
