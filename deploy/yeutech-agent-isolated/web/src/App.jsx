import { useEffect, useRef, useState } from "react";
import { migrationApi, workbenchApi } from "./api.js";
import { WorkbenchHeader, WorkbenchTabs, WorkbenchMore } from "./workbench-header.jsx";
import { syncPortalAppearance } from "./portal-appearance.js";
import { dedupeProjectedMessages, latestProjectedMessageWindow } from "./message-projection.js";
import { SIDEBAR_WIDTH_STORAGE_KEY, FILE_PANEL_WIDTH_STORAGE_KEY, PERMISSION_MODE_STORAGE_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, FILE_PANEL_MIN_WIDTH, CONVERSATION_MIN_WIDTH, clamp, storedWidth, storeWidth, storedFilePanelState, storeFilePanelState, isHistoricalConversation, storedSelectionContext, storedSelection, storeSelection } from "./workbench-helpers.js";
import { SurfaceBoundary, PanelResizer } from "./workbench-primitives.jsx";
import { Sidebar } from "./workbench-sidebar.jsx";
import { ProjectDiscoveryDialog, ProjectDialog, CapabilityCenter, PluginCenter, ControlCenter } from "./workbench-dialogs.jsx";
import { DiffPanel } from "./workbench-timeline.jsx";
import { FilePanel } from "./workbench-files.jsx";
import { Conversation } from "./workbench-conversation.jsx";

import { createWorkbenchBootstrap } from "./workbench-bootstrap.js";
import { useProjectionEvents } from "./use-projection-events.js";
import { createWorkbenchActions } from "./workbench-actions.js";

export function App() {
  const cachedSelection = storedSelectionContext();
  const cachedFilePanel = storedFilePanelState(cachedSelection.sessionId);
  const [projects, setProjects] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [standaloneSessions, setStandaloneSessions] = useState([]);
  const [selected, setSelected] = useState(storedSelection);
  const [selectedProject, setSelectedProject] = useState(cachedSelection.projectId);
  const [expandedProjects, setExpandedProjects] = useState(() => new Set());
  const [messagesBySession, setMessagesBySession] = useState({});
  const [messageCursors, setMessageCursors] = useState({});
  const [runtimeSessions, setRuntimeSessions] = useState({});
  const [runtimeEnabledSessions, setRuntimeEnabledSessions] = useState(() => new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [reasoningPreferences, setReasoningPreferences] = useState({});
  const [serviceTierPreferences, setServiceTierPreferences] = useState({});
  const [permissionMode, setPermissionMode] = useState(() => {
    try { const value = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY); return ["ask", "smart", "full"].includes(value) ? value : "smart"; }
    catch { return "smart"; }
  });
  const [modelReload, setModelReload] = useState({ status: "unknown" });
  const [running, setRunning] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState(() => new Set());
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth <= 880);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => storedWidth(SIDEBAR_WIDTH_STORAGE_KEY, 300, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
  const [filePanelWidth, setFilePanelWidth] = useState(() => storedWidth(FILE_PANEL_WIDTH_STORAGE_KEY, 520, FILE_PANEL_MIN_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, window.innerWidth * .46)));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [permissions, setPermissions] = useState([]);
  const [insightsBySession, setInsightsBySession] = useState({});
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [skills, setSkills] = useState([]);
  const [skillReport, setSkillReport] = useState({ reported: false, workerActive: false });
  const [pluginOpen, setPluginOpen] = useState(false);
  const [pluginLoading, setPluginLoading] = useState(false);
  const [pluginError, setPluginError] = useState("");
  const [plugins, setPlugins] = useState([]);
  const [filePanelOpen, setFilePanelOpen] = useState(cachedFilePanel.open);
  const [filePanelProjectId, setFilePanelProjectId] = useState(cachedFilePanel.projectId);
  const [filePanelRequest, setFilePanelRequest] = useState(() => cachedFilePanel.path ? { path: cachedFilePanel.path, key: `restore:${cachedFilePanel.path}` } : null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffItems, setDiffItems] = useState([]);
  const [controlOpen, setControlOpen] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const preserveAttachmentsOnNextSelection = useRef(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectMutationBusy, setProjectMutationBusy] = useState(false);
  const [projectMutationError, setProjectMutationError] = useState("");
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryBusyProjectId, setDiscoveryBusyProjectId] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState("");
  const pollVersion = useRef(0);
  const refreshVersion = useRef(0);
  const selectedRef = useRef(selected);
  const reconcileRef = useRef(async () => null);
  const resizeCleanupRef = useRef(null);
  const messageRolesRef = useRef(new Map());
  const bufferedOlderMessagesRef = useRef(new Map());
  const modelPreferenceWritesRef = useRef(Promise.resolve());

  useEffect(() => { messageRolesRef.current.clear(); }, [selected]);

  useEffect(() => {
    const refreshAppearance = () => { void syncPortalAppearance(); };
    const onVisibility = () => { if (document.visibilityState === "visible") refreshAppearance(); };
    const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    refreshAppearance();
    window.addEventListener("focus", refreshAppearance);
    document.addEventListener("visibilitychange", onVisibility);
    colorScheme?.addEventListener?.("change", refreshAppearance);
    return () => {
      window.removeEventListener("focus", refreshAppearance);
      document.removeEventListener("visibilitychange", onVisibility);
      colorScheme?.removeEventListener?.("change", refreshAppearance);
    };
  }, []);

  const updateRunningSession = (sessionID, active) => {
    if (!sessionID) return;
    setRunningSessionIds((current) => {
      const next = new Set(current);
      if (active) next.add(sessionID); else next.delete(sessionID);
      return next;
    });
  };

  const filePanelMaxWidth = () => Math.max(FILE_PANEL_MIN_WIDTH, Math.min(viewportWidth * .55, viewportWidth - (sidebarCollapsed ? 0 : sidebarWidth) - CONVERSATION_MIN_WIDTH - 46));
  const updateSidebarWidth = (value, persist = true) => {
    const next = clamp(value, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
    setSidebarWidth(next);
    if (persist) storeWidth(SIDEBAR_WIDTH_STORAGE_KEY, next);
  };
  const updateFilePanelWidth = (value, persist = true) => {
    const next = clamp(value, FILE_PANEL_MIN_WIDTH, filePanelMaxWidth());
    setFilePanelWidth(next);
    if (persist) storeWidth(FILE_PANEL_WIDTH_STORAGE_KEY, next);
  };
  const beginResize = (kind, event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = kind === "sidebar" ? sidebarWidth : filePanelWidth;
    const move = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      if (kind === "sidebar") updateSidebarWidth(startWidth + delta, false);
      else updateFilePanelWidth(startWidth - delta, false);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("panel-resizing");
      resizeCleanupRef.current = null;
    };
    const finish = (finishEvent) => {
      const delta = finishEvent.clientX - startX;
      if (kind === "sidebar") updateSidebarWidth(startWidth + delta);
      else updateFilePanelWidth(startWidth - delta);
      cleanup();
    };
    document.body.classList.add("panel-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    resizeCleanupRef.current = cleanup;
  };
  useEffect(() => {
    const keepWidthsInRange = () => {
      setViewportWidth(window.innerWidth);
      setSidebarWidth((current) => clamp(current, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
    };
    window.addEventListener("resize", keepWidthsInRange);
    return () => { window.removeEventListener("resize", keepWidthsInRange); resizeCleanupRef.current?.(); };
  }, []);
  useEffect(() => {
    setFilePanelWidth((current) => clamp(current, FILE_PANEL_MIN_WIDTH, filePanelMaxWidth()));
  }, [sidebarWidth, sidebarCollapsed, viewportWidth]);

  const { refresh } = createWorkbenchBootstrap({ refreshVersion, projects, conversations, standaloneSessions, setBootstrapping, setBootstrapError, setModels, setModelReload, setModel, setReasoningPreferences, setServiceTierPreferences, selectedRef, cachedSelection, setProjects, setConversations, setStandaloneSessions, setRuntimeSessions, setRunningSessionIds, setRuntimeEnabledSessions, setSelected, setSelectedProject, setExpandedProjects, setRunning, setStatus });
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    if (!selected) return;
    storeSelection({ scope: selectedProject ? "project" : "session", projectId: selectedProject, sessionId: selected });
  }, [selected, selectedProject]);
  useEffect(() => {
    storeFilePanelState({ open: filePanelOpen, sessionId: selected, projectId: filePanelProjectId, path: filePanelRequest?.path || "" });
  }, [filePanelOpen, filePanelProjectId, filePanelRequest?.path, selected]);
  useEffect(() => {
    if (preserveAttachmentsOnNextSelection.current) preserveAttachmentsOnNextSelection.current = false;
    else setAttachments([]);
    setStopping(false); setDiffOpen(false); setDiffItems([]); setDiffError("");
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    if (isHistoricalConversation(selected)) {
      const mappedRuntimeID = runtimeSessions[selected];
      // A migrated conversation can already have a live OpenCode continuation.
      // Its projection-event cache contains only a recent page, while snapshot
      // reads the authoritative session history.  Using the cache here made
      // today's continued messages look as if they had disappeared.
      Promise.all([migrationApi.messages(selected), mappedRuntimeID ? workbenchApi.snapshot(mappedRuntimeID).catch(() => null) : Promise.resolve(null)]).then(([history, runtime]) => {
        if (!current) return;
        const historicalRecords = history.records.map((item) => ({ ...item, origin: "history" }));
        const runtimeRecords = (runtime?.messages || [])
          .filter((item) => !(item.role === "user" && String(item.text || "").startsWith("[历史会话迁移上下文]")))
          .map((item) => ({ ...item, id: `passive-runtime-${item.id}`, origin: "passive-runtime" }));
        const queuedRecords = (runtime?.inbox || []).map((item) => ({ ...item, id: `inbox-${item.id}`, origin: "runtime" }));
        // The initial API page is intentionally only the latest ten records.
        // A mapped runtime snapshot can be larger, so apply the same boundary
        // before rendering and keep everything else for upward pagination.
        const window = latestProjectedMessageWindow([...historicalRecords, ...runtimeRecords, ...queuedRecords], 10);
        if (window.overflow.length) bufferedOlderMessagesRef.current.set(selected, { records: window.overflow, cursor: history.cursor });
        else bufferedOlderMessagesRef.current.delete(selected);
        setMessagesBySession((all) => ({ ...all, [selected]: window.visible }));
        setMessageCursors((all) => ({ ...all, [selected]: window.overflow.length ? `buffered:${selected}` : history.cursor }));
        if (runtime) setInsightsBySession((all) => ({ ...all, [selected]: {
          ...(all[selected] || {}), session: runtime.session, artifacts: runtime.artifacts || [],
          permissions: runtime.permissions || [], childTree: runtime.childTree || [], plan: runtime.plan || [],
          outline: runtime.outline || [], trajectory: runtime.trajectory || [], activity: runtime.activity || runtime.trajectory || [],
          stats: runtime.stats, context: runtime.context, coverage: runtime.coverage, graph: runtime.graph, evidence: runtime.evidence || [],
        } }));
      }).catch((error) => { if (current) setStatus(error.message); });
    } else if (!selected.startsWith("ses_local") && !runtimeEnabledSessions.has(selected)) {
      workbenchApi.messages(selected).then((history) => {
        if (!current) return;
        const records = history.records.map((item) => ({ ...item, id: `passive-${item.id}`, origin: "passive" }));
        const queuedRecords = (history.inbox || []).map((item) => ({ ...item, id: `inbox-${item.id}`, origin: "runtime" }));
        setMessagesBySession((all) => ({ ...all, [selected]: [...records, ...queuedRecords] }));
        setMessageCursors((all) => ({ ...all, [selected]: history.cursor ? `passive:${history.cursor}` : null }));
        setInsightsBySession((all) => ({ ...all, [selected]: {
          ...(all[selected] || {}), session: history.session, artifacts: history.artifacts || [],
          permissions: history.permissions || [], childTree: history.childTree || [], plan: history.plan || [],
          outline: history.outline || [], trajectory: history.trajectory || [], activity: history.activity || history.trajectory || [],
          stats: history.stats, context: history.context, coverage: history.coverage, graph: history.graph, evidence: history.evidence || [],
        } }));
      }).catch((error) => { if (current) setStatus(error.message); });
    }
    return () => { current = false; };
  }, [selected, runtimeSessions[selected]]);

  const session = conversations.find((item) => item.id === selected) || standaloneSessions.find((item) => item.id === selected);
  const project = projects.find((item) => item.id === session?.projectId);
  const messages = dedupeProjectedMessages(messagesBySession[selected] || []).filter((message) =>
    message.role === "user" || String(message.text || "").trim() || String(message.reasoning || "").trim() || message.error
  );
  const reasoningEffort = reasoningPreferences[selected] || "";
  const serviceTier = serviceTierPreferences[selected] || "";
  const changeReasoningEffort = (value) => {
    if (!session) return;
    const selectedModel = models.find(item => item.id === model);
    if (value && !selectedModel?.reasoningEfforts?.includes(value)) return;
    const id = session.id;
    modelPreferenceWritesRef.current = modelPreferenceWritesRef.current.catch(() => undefined)
      .then(() => workbenchApi.updateSessionPreference(id, model, value, serviceTier))
      .then(() => setReasoningPreferences(current => ({ ...current, [id]: value })))
      .catch(error => setStatus(`推理强度保存失败：${error.message}`));
  };
  const changeServiceTier = (value) => {
    if (!session) return;
    const selectedModel = models.find(item => item.id === model);
    if (value && !selectedModel?.serviceTiers?.includes(value)) return;
    const id = session.id;
    modelPreferenceWritesRef.current = modelPreferenceWritesRef.current.catch(() => undefined)
      .then(() => workbenchApi.updateSessionPreference(id, model, reasoningEffort, value))
      .then(() => setServiceTierPreferences(current => ({ ...current, [id]: value })))
      .catch(error => setStatus(`响应速度保存失败：${error.message}`));
  };
  const authoritativeSessionModel = session?.model || insightsBySession[selected]?.context?.model;
  useEffect(() => {
    if (authoritativeSessionModel && models.some((item) => item.id === authoritativeSessionModel)) setModel(authoritativeSessionModel);
  }, [selected, authoritativeSessionModel, models]);
  const changeModel = (modelId) => {
    if (!session || !models.some((item) => item.id === modelId && item.selectable)) return;
    const sessionID = session.id;
    setModel(modelId);
    setReasoningPreferences(current => ({ ...current, [sessionID]: "" }));
    setServiceTierPreferences(current => ({ ...current, [sessionID]: "" }));
    const updateSessionModel = (items) => items.map((item) => item.id === sessionID ? { ...item, model: modelId } : item);
    setConversations(updateSessionModel);
    setStandaloneSessions(updateSessionModel);
    modelPreferenceWritesRef.current = modelPreferenceWritesRef.current
      .catch(() => undefined)
      .then(() => workbenchApi.updateSessionPreference(sessionID, modelId))
      .catch((error) => {
        if (selectedRef.current === sessionID) setStatus(`模型选择保存失败：${error instanceof Error ? error.message : "未知错误"}`);
      });
  };
  const knownRuntimeID = runtimeSessions[selected] || (!selected.startsWith("ses_local") && !isHistoricalConversation(selected) ? selected : "");
  const activeRuntimeID = runtimeEnabledSessions.has(selected) ? knownRuntimeID : "";
  useProjectionEvents({ activeRuntimeID, setPermissions, reconcileRef, selected, setMessagesBySession, setPermissionMode, setInsightsBySession, setRunning, updateRunningSession, setStatus, messagesBySession, messageRolesRef });
  const { loadOlder, createSession, createProjectSession, createProject, registerProject, selectSession, send, stop, replyPermission, changePermissionMode, selectProject, renameProject, deleteProject, renameSession, deleteSession, forkSession, openDiff, openProjectFiles, openCurrentFiles, openCapabilities, openPlugins, changePlugin, panoramaAction, openControl, attachFile, removeAttachment, removeDeletedAttachment, exportConversation } = createWorkbenchActions({ messageCursors, selected, loadingOlder, setLoadingOlder, bufferedOlderMessagesRef, setMessagesBySession, setMessageCursors, pollVersion, model, setStandaloneSessions, setSelected, setSelectedProject, setFilePanelOpen, setRunning, updateRunningSession, setStopping, setStatus, setConversations, setExpandedProjects, setProjectMutationBusy, setProjectMutationError, setProjects, setProjectDialogOpen, setDiscoveryBusyProjectId, setDiscoveryError, runningSessionIds, conversations, session, runtimeSessions, setRuntimeSessions, setReasoningPreferences, setServiceTierPreferences, project, setRunningSessionIds, preserveAttachmentsOnNextSelection, setAttachments, setRuntimeEnabledSessions, permissionMode, reasoningEffort, serviceTier, stopping, reconcileRef, setPermissions, activeRuntimeID, setPermissionMode, standaloneSessions, setDiffOpen, setDiffLoading, setDiffError, setDiffItems, setFilePanelProjectId, setFilePanelRequest, setSidebarOpen, setFocusMode, setCapabilityOpen, setCapabilityLoading, setCapabilityError, setProfiles, setSkills, setSkillReport, setPluginOpen, setPluginLoading, setPluginError, setPlugins, setInsightsBySession, setControlOpen, messages });
  const selectableModelCount = models.filter((item) => item.selectable).length;
  const reloadLabel = modelReload.status === "pending-idle" ? " · 目录更新待空闲加载" : modelReload.status === "reloading" ? " · 正在安全加载" : "";
  const searchDirectory = () => { setSidebarCollapsed(false); setSidebarOpen(true); window.requestAnimationFrame(() => document.querySelector('.search input')?.focus()); };
  return <div className="portal-shell yt-page workspace-v3 workspace-v33">
    <WorkbenchHeader loading={bootstrapping} onRefresh={refresh} onSearch={searchDirectory} />
    <main className={`workspace ${focusMode ? "focus-mode" : ""}`}>
      <WorkbenchTabs directoryOpen={sidebarOpen} filesOpen={filePanelOpen} onDirectory={() => { setFilePanelOpen(false); setSidebarCollapsed(false); setSidebarOpen(true); }} onConversation={() => { setFilePanelOpen(false); setSidebarOpen(false); }} onFiles={() => { setSidebarOpen(false); openCurrentFiles(); }} onControl={openControl} />
      <header className="workbench-summary"><h1>AI 工作台</h1><p>{bootstrapping ? "正在同步工作区…" : bootstrapError ? "连接失败，请检查连接后重新同步" : `会话、项目与文件 · ${selectableModelCount} 个可用模型${reloadLabel}`}</p></header>
      <div className="home-workbench-layout"><div className="task-content">
      <section className={`command-stage ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${filePanelOpen ? "files-open" : ""} ${filePanelOpen && filePanelWidth <= 560 ? "file-panel-compact" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--file-panel-width": `${filePanelWidth}px` }}>

        <SurfaceBoundary label="项目栏" resetKey={`${projects.length}:${standaloneSessions.length}`}><Sidebar projects={projects} conversations={conversations} standaloneSessions={standaloneSessions} selected={selected} selectedProject={selectedProject} expandedProjects={expandedProjects} runningSessionIds={runningSessionIds} runtimeSessions={runtimeSessions} modelCount={`${selectableModelCount}/${models.length}`} loading={bootstrapping} onSelect={(id) => { selectSession(id); setSidebarOpen(false); }} onSelectProject={selectProject} onNew={() => { void createSession(); setSidebarOpen(false); }} onNewProject={() => { setProjectMutationError(""); setProjectDialogOpen(true); }} onDiscoverProjects={() => { setDiscoveryError(""); setDiscoveryOpen(true); void refresh(); }} onNewProjectSession={async (item) => { if (await createProjectSession(item)) setSidebarOpen(false); }} onOpenProjectFiles={(item) => void openProjectFiles(item)} onRenameProject={(item) => void renameProject(item)} onDeleteProject={(item) => void deleteProject(item)} onRenameSession={(item) => void renameSession(item)} onDeleteSession={(item) => void deleteSession(item)} onForkSession={(item) => void forkSession(item)} onCapabilities={() => void openCapabilities()} onPlugins={() => void openPlugins()} onControl={openControl} onCollapse={() => setSidebarCollapsed(true)} /></SurfaceBoundary>
        <PanelResizer className="sidebar-resizer" label="调整项目目录宽度" controls="project-sidebar" value={sidebarWidth} min={SIDEBAR_MIN_WIDTH} max={SIDEBAR_MAX_WIDTH} onPointerDown={(event) => beginResize("sidebar", event)} onChange={updateSidebarWidth} />
        <SurfaceBoundary label="会话区" resetKey={selected}><Conversation session={session} project={project} messages={messages} permissions={permissions} insight={insightsBySession[selected]} hasRuntime={Boolean(knownRuntimeID)} attachments={attachments} olderCursor={messageCursors[selected]} loadingOlder={loadingOlder} models={models} model={model} permissionMode={permissionMode} reasoningEffort={reasoningEffort} serviceTier={serviceTier} onReasoningEffortChange={changeReasoningEffort} onServiceTierChange={changeServiceTier} running={running} stopping={stopping} status={status} bootstrapping={bootstrapping} bootstrapError={bootstrapError} focusMode={focusMode} sidebarCollapsed={sidebarCollapsed} onLoadOlder={loadOlder} onModelChange={changeModel} onPermissionModeChange={changePermissionMode} onSend={send} onStop={stop} onAttach={attachFile} onRemoveAttachment={removeAttachment} onOpenControl={openControl} onOpenCapabilities={() => void openCapabilities()} onPanoramaOpen={panoramaAction} onPermissionReply={replyPermission} onExport={exportConversation} onOpenFiles={openCurrentFiles} onOpenDiff={() => void openDiff()} onOpenSidebar={() => setSidebarOpen(true)} onExpandSidebar={() => setSidebarCollapsed(false)} onToggleFocus={() => setFocusMode((current) => { if (!current) setFilePanelOpen(false); return !current; })} /></SurfaceBoundary>
        {filePanelOpen ? <PanelResizer className="file-panel-resizer" label="调整项目文件宽度" controls="project-file-panel" value={filePanelWidth} min={FILE_PANEL_MIN_WIDTH} max={filePanelMaxWidth()} keyboardDirection={-1} onPointerDown={(event) => beginResize("files", event)} onChange={updateFilePanelWidth} /> : null}
        <SurfaceBoundary label="文件预览" resetKey={`${selected}:${filePanelProjectId}:${filePanelOpen}`}><FilePanel session={session} project={projects.find((item) => item.id === filePanelProjectId) || project} open={filePanelOpen} requestedFile={filePanelRequest} canAttach={!filePanelProjectId || filePanelProjectId === project?.id} onClose={() => { setFilePanelOpen(false); setFilePanelProjectId(""); setFilePanelRequest(null); }} onAttach={attachFile} onDeleted={removeDeletedAttachment} onActiveFileChange={(path) => setFilePanelRequest((current) => ({ path, key: current?.key || `browse:${selected}` }))} /></SurfaceBoundary>
      </section>
      </div>
      <WorkbenchMore loading={bootstrapping} error={bootstrapError} modelCount={selectableModelCount} reloadLabel={reloadLabel} onRefresh={refresh} />
      </div>
    </main>
    <CapabilityCenter open={capabilityOpen} loading={capabilityLoading} error={capabilityError} profiles={profiles} skills={skills} skillReport={skillReport} models={models} onClose={() => setCapabilityOpen(false)} onRetry={() => void openCapabilities()} />
    <PluginCenter open={pluginOpen} loading={pluginLoading} error={pluginError} plugins={plugins} project={project} onClose={() => setPluginOpen(false)} onRetry={() => void openPlugins()} onChange={(plugin, update) => void changePlugin(plugin, update)} />
    <ControlCenter open={controlOpen} onClose={() => setControlOpen(false)} project={project} session={session} runtimeSessionId={activeRuntimeID} insight={insightsBySession[selected]} attachments={attachments} hasRuntime={Boolean(activeRuntimeID)} model={model} />
    <ProjectDialog open={projectDialogOpen} busy={projectMutationBusy} error={projectMutationError} onClose={() => setProjectDialogOpen(false)} onCreate={createProject} />
    <ProjectDiscoveryDialog open={discoveryOpen} projects={projects.filter((item) => item.registered === false)} busyProjectId={discoveryBusyProjectId} error={discoveryError} onClose={() => setDiscoveryOpen(false)} onRegister={(item) => void registerProject(item)} onRescan={() => { setDiscoveryError(""); void refresh(); }} />
    <DiffPanel open={diffOpen} loading={diffLoading} error={diffError} items={diffItems} session={session} onClose={() => setDiffOpen(false)} onRetry={() => void openDiff()} />
  </div>;
}
