import { agentApi, migrationApi, workbenchApi } from "./api.js";
import { removeDeletedAttachmentReferences } from "./attachment-state.js";
import { projectFilePath } from "./project-file-reference.js";
import { PERMISSION_MODE_STORAGE_KEY, timestampPermissions, isHistoricalConversation, attachmentIdentity, attachmentFileIdentity } from "./workbench-helpers.js";

export function createWorkbenchActions({ messageCursors, selected, loadingOlder, setLoadingOlder, bufferedOlderMessagesRef, setMessagesBySession, setMessageCursors, pollVersion, model, setStandaloneSessions, setSelected, setSelectedProject, setFilePanelOpen, setRunning, updateRunningSession, setStopping, setStatus, setConversations, setExpandedProjects, setProjectMutationBusy, setProjectMutationError, setProjects, setProjectDialogOpen, setDiscoveryBusyProjectId, setDiscoveryError, runningSessionIds, conversations, session, runtimeSessions, setRuntimeSessions, setReasoningPreferences, setServiceTierPreferences, project, setRunningSessionIds, preserveAttachmentsOnNextSelection, setAttachments, setRuntimeEnabledSessions, permissionMode, reasoningEffort, serviceTier, stopping, reconcileRef, setPermissions, activeRuntimeID, setPermissionMode, standaloneSessions, setDiffOpen, setDiffLoading, setDiffError, setDiffItems, setFilePanelProjectId, setFilePanelRequest, setSidebarOpen, setFocusMode, setCapabilityOpen, setCapabilityLoading, setCapabilityError, setProfiles, setSkills, setSkillReport, setPluginOpen, setPluginLoading, setPluginError, setPlugins, setInsightsBySession, setControlOpen, messages }) {
  const loadOlder = async () => {
    const cursor = messageCursors[selected];
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      if (String(cursor).startsWith("buffered:")) {
        const buffered = bufferedOlderMessagesRef.current.get(selected);
        if (!buffered) return;
        setMessagesBySession((current) => {
          const existing = new Set((current[selected] || []).map((item) => item.id));
          return { ...current, [selected]: [...buffered.records.filter((item) => !existing.has(item.id)), ...(current[selected] || [])] };
        });
        bufferedOlderMessagesRef.current.delete(selected);
        setMessageCursors((current) => ({ ...current, [selected]: buffered.cursor || null }));
        return;
      }
      const passive = String(cursor).startsWith("passive:");
      if (!passive && !isHistoricalConversation(selected)) return;
      const page = passive ? await workbenchApi.messages(selected, String(cursor).slice("passive:".length)) : await migrationApi.messages(selected, cursor);
      const older = page.records.map((item) => ({ ...item, id: passive ? `passive-${item.id}` : item.id, origin: passive ? "passive" : "history" }));
      setMessagesBySession((current) => {
        const existing = new Set((current[selected] || []).map((item) => item.id));
        return { ...current, [selected]: [...older.filter((item) => !existing.has(item.id)), ...(current[selected] || [])] };
      });
      setMessageCursors((current) => ({ ...current, [selected]: page.cursor ? `${passive ? "passive:" : ""}${page.cursor}` : null }));
    } finally { setLoadingOlder(false); }
  };
  const createSession = async () => {
    pollVersion.current += 1;
    try {
      const draft = (await workbenchApi.createSessionDraft({ title: "新会话", modelId: model })).data;
      const next = { id: draft.id, title: draft.title, model: draft.model?.id || model, updatedAt: Number(draft.time?.updated || Date.now()), fileScope: draft.id, draft: true };
      setStandaloneSessions((current) => [next, ...current.filter((item) => item.id !== next.id)]); setMessagesBySession((current) => ({ ...current, [next.id]: [] })); setSelected(next.id); setSelectedProject(""); setFilePanelOpen(false); setRunning(false); updateRunningSession(next.id, false); setStopping(false); setStatus("");
      return next;
    } catch (error) { setStatus(`新建会话失败：${error instanceof Error ? error.message : "未知错误"}`); return null; }
  };
  const createProjectSession = async (targetProject, title = "新项目会话") => {
    if (!targetProject?.registered) return;
    try {
      const draft = (await workbenchApi.createSessionDraft({ projectId: targetProject.id, title, modelId: model })).data;
      const next = { id: draft.id, projectId: targetProject.id, title: draft.title, model: draft.model?.id || model, updatedAt: Number(draft.time?.updated || Date.now()), draft: true };
      setConversations((current) => [next, ...current.filter((item) => item.id !== next.id)]); setMessagesBySession((current) => ({ ...current, [next.id]: [] }));
      setSelectedProject(targetProject.id); setExpandedProjects((current) => new Set([...current, targetProject.id])); setSelected(next.id); setFilePanelOpen(false); setRunning(false); updateRunningSession(next.id, false); setStatus("");
      return next;
    } catch (error) { setStatus(`新建项目会话失败：${error instanceof Error ? error.message : "未知错误"}`); return null; }
  };
  const createProject = async (name) => {
    setProjectMutationBusy(true); setProjectMutationError("");
    try {
      const result = await workbenchApi.createProject(name);
      const nextProject = { ...result.data, availableLocally: true, conversationCount: 0 };
      setProjects((current) => [...current.filter((item) => item.id !== nextProject.id), nextProject]);
      setProjectDialogOpen(false);
      await createProjectSession(nextProject);
    } catch (error) { setProjectMutationError(error instanceof Error ? error.message : "项目创建失败"); }
    finally { setProjectMutationBusy(false); }
  };
  const registerProject = async (targetProject) => {
    const mutationID = targetProject.id || targetProject.workspaceDirectory;
    setDiscoveryBusyProjectId(mutationID);
    setDiscoveryError("");
    setStatus(`正在接入 ${targetProject.name}…`);
    try {
      const result = await workbenchApi.registerProject(targetProject.workspaceDirectory || targetProject.name);
      const registered = { ...targetProject, ...result.data, availableLocally: true };
      setProjects((current) => current.map((item) => (item.id || item.workspaceDirectory) === (targetProject.id || targetProject.workspaceDirectory) ? registered : item));
      setExpandedProjects((current) => new Set([...current, registered.id]));
      setStatus(`${registered.name} 已接入，可以创建项目会话。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setDiscoveryError(`项目接入失败：${message}`);
      setStatus(`项目接入失败：${message}`);
    } finally { setDiscoveryBusyProjectId(""); }
  };
  const selectSession = (id, keepFilePanelOpen = false) => {
    pollVersion.current += 1;
    setSelected(id); setRunning(runningSessionIds.has(id)); setStopping(false); setStatus(""); setLoadingOlder(false);
    if (!keepFilePanelOpen) setFilePanelOpen(false);
    const item = conversations.find((value) => value.id === id);
    const nextProjectID = item?.projectId?.startsWith("standalone:") ? "" : item?.projectId || "";
    setSelectedProject(nextProjectID);
    if (nextProjectID) setExpandedProjects((current) => new Set([...current, nextProjectID]));
  };
  const send = async (text, selectedAttachments = []) => {
    if (!session) return { sent: false, sessionID: selected };
    const currentPoll = pollVersion.current + 1;
    pollVersion.current = currentPoll;
    const localID = selected;
    let runtimeDisplayID = localID;
    const historical = isHistoricalConversation(localID);
    const title = (text.trim() || selectedAttachments[0]?.name || selectedAttachments[0]?.path || "新会话").slice(0, 28);
    const message = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      text,
      attachments: selectedAttachments.map((item) => ({ name: item.name, path: item.path, workspacePath: item.workspacePath })),
      createdAt: Date.now(),
      origin: "optimistic",
    };
    const markRecentlyActive = (items) => items.map((item) => item.id === localID ? { ...item, updatedAt: message.createdAt } : item);
    setConversations(markRecentlyActive);
    setStandaloneSessions(markRecentlyActive);
    setMessagesBySession((current) => ({ ...current, [localID]: [...(current[localID] || []), message] })); setRunning(true); updateRunningSession(localID, true); setStatus(historical && !runtimeSessions[localID] ? "正在后台接续原会话…" : "正在通过 CLIProxyAPI 调用模型…");
    try {
      let remoteID = runtimeSessions[localID];
      if (historical && !remoteID) {
        const result = await migrationApi.continue(localID);
        remoteID = result.session.id;
        setRuntimeSessions((current) => ({ ...current, [localID]: remoteID }));
        setConversations((current) => current.map((item) => item.id === localID ? { ...item, runtimeSessionId: remoteID } : item));
      } else if (!historical) {
        if (localID.startsWith("ses_local")) {
          if (title !== session.title) await workbenchApi.renameSessionDraft(localID, title);
          const remote = (await workbenchApi.materializeSessionDraft(localID)).data;
          remoteID = remote.id;
          runtimeDisplayID = remote.id;
          setReasoningPreferences((current) => ({ ...current, [remote.id]: current[localID] || "" }));
          setServiceTierPreferences((current) => ({ ...current, [remote.id]: current[localID] || "" }));
          if (project) setConversations((current) => current.map((item) => item.id === localID ? { ...item, id: remote.id, title, model, updatedAt: message.createdAt, runtimeSessionId: remote.id } : item));
          else setStandaloneSessions((current) => current.map((item) => item.id === localID ? { ...item, id: remote.id, title, model, updatedAt: message.createdAt } : item));
          setMessagesBySession((current) => { const next = { ...current, [remote.id]: current[localID] || [message] }; delete next[localID]; return next; });
          setRunningSessionIds((current) => { const next = new Set(current); next.delete(localID); next.add(remote.id); return next; });
          preserveAttachmentsOnNextSelection.current = true;
          setAttachments((current) => current.map((item) => item.ownerSessionID === localID ? { ...item, ownerSessionID: remote.id } : item));
          setSelected(remote.id);
        } else remoteID = localID;
      }
      setRuntimeEnabledSessions((current) => new Set([...current, runtimeDisplayID]));
      const promptResult = await agentApi.prompt(remoteID, text, model, selectedAttachments, { project: project?.workspaceDirectory || project?.name || null, workload: "general-agent", permissionMode, reasoningEffort, serviceTier });
      if (promptResult?.data?.queued) setStatus(promptResult.data.delivery === "steer" ? "补充要求正在送入当前任务…" : `已加入待执行队列（第 ${promptResult.data.position} 条）。`);
      const sentIdentities = new Set(selectedAttachments.map(attachmentFileIdentity));
      const sentOwnerIDs = new Set([localID, runtimeDisplayID]);
      setAttachments((current) => current.filter((item) => !sentOwnerIDs.has(item.ownerSessionID) || !sentIdentities.has(attachmentFileIdentity(item))));
      return { sent: true, sessionID: runtimeDisplayID };
    } catch (error) {
      if (pollVersion.current === currentPoll) {
        const failureMessage = error instanceof Error ? error.message : "请求失败";
        const failure = { id: `send-error-${Date.now()}`, role: "assistant", text: "", error: { code: error?.code || "submit_failed", message: `消息未能提交给模型：${failureMessage}` }, createdAt: Date.now(), origin: "local-error" };
        setMessagesBySession((current) => ({ ...current, [runtimeDisplayID]: [...(current[runtimeDisplayID] || []), failure] }));
        setRunning(false); updateRunningSession(runtimeDisplayID, false); setStatus(failure.error.message);
      }
      return { sent: false, sessionID: runtimeDisplayID };
    }
  };
  const stop = async () => {
    const remoteID = runtimeSessions[selected] || (!selected.startsWith("ses_local") ? selected : "");
    if (!remoteID || stopping) return;
    setStopping(true);
    setStatus("正在请求 Agent 停止…");
    try {
      await agentApi.abort(remoteID);
      const snapshot = await reconcileRef.current();
      if (snapshot?.session?.status) {
        setRunning(true);
        setStatus("停止请求已确认，正在等待当前执行退出…");
      } else {
        setRunning(false);
        updateRunningSession(selected, false);
        setStatus("已停止，会话内容已保留。");
      }
    } catch (error) {
      await reconcileRef.current().catch(() => null);
      setStatus(`停止失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setStopping(false);
    }
  };
  const replyPermission = async (requestID, reply) => {
    setPermissions((current) => current.filter((request) => request.id !== requestID));
    try {
      if (reply === "always" && activeRuntimeID) {
        const result = await workbenchApi.updateSessionPermission(activeRuntimeID, "full");
        setPermissionMode("full");
        try { window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, "full"); } catch { /* Preference persistence is optional. */ }
        setPermissions((current) => current.filter((request) => request.sessionID !== activeRuntimeID));
        setStatus(`当前任务已启用完全访问${result?.data?.clearedPermissions ? `，并处理 ${result.data.clearedPermissions} 个待确认操作` : ""}。`);
        return;
      }
      await agentApi.replyPermission(requestID, reply);
      setStatus(reply === "always" ? "已允许本任务后续同类操作。" : reply === "once" ? "已允许本次操作。" : "已拒绝该操作。");
    } catch (error) {
      setStatus(error.message);
      const pending = await agentApi.permissions().catch(() => []);
      setPermissions((current) => timestampPermissions(pending.filter((request) => request.sessionID === activeRuntimeID), current));
    }
  };
  const changePermissionMode = async (value) => {
    if (!["ask", "smart", "full"].includes(value)) return;
    const previous = permissionMode;
    setPermissionMode(value);
    try { window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, value); } catch { /* Preference persistence is optional. */ }
    if (!activeRuntimeID) { setStatus("已选择下次请求权限；发送后由执行端确认。"); return; }
    setStatus("正在保存下次请求权限…");
    try {
      const result = await workbenchApi.updateSessionPermission(activeRuntimeID, value);
      const receipt = result?.data?.permissionPolicy;
      setInsightsBySession((all) => ({ ...all, [selected]: { ...all[selected], session: { ...all[selected]?.session, permissionMode: value, permissionPolicy: receipt } } }));
      setStatus(receipt?.activeTask
        ? "已保存，供下次请求使用；当前活动任务及待审批操作未改变。"
        : receipt?.runtimeMatchesRequest ? "已保存并由执行端回读确认；下次请求使用此策略。" : "请求配置已保存；执行端规则未确认一致，发送前将重新下发。");
    } catch (error) {
      setPermissionMode(previous);
      try { window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, previous); } catch { /* Preference persistence is optional. */ }
      setStatus(`权限更新失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };
  const selectProject = (projectID) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectID)) next.delete(projectID); else next.add(projectID);
      return next;
    });
  };

  const renameProject = async (targetProject) => {
    const name = window.prompt("输入新的项目名称", targetProject.name)?.trim();
    if (!name || name === targetProject.name) return;
    setStatus(`正在重命名 ${targetProject.name}…`);
    try {
      const result = await workbenchApi.renameProject(targetProject.id, name);
      const updated = result?.data || { ...targetProject, name };
      setProjects((current) => current.map((item) => item.id === targetProject.id ? { ...item, ...updated } : item));
      setStatus(`项目已重命名为 ${updated.name || name}。`);
    } catch (error) { setStatus(`项目重命名失败：${error instanceof Error ? error.message : "未知错误"}`); }
  };

  const deleteProject = async (targetProject) => {
    if (!window.confirm(`取消登记项目“${targetProject.name}”？NAS 文件不会被删除，之后仍可重新接入。`)) return;
    setStatus(`正在取消登记项目 ${targetProject.name}…`);
    try {
      await workbenchApi.removeProject(targetProject.id);
      const removedSessionIDs = new Set(conversations.filter((item) => item.projectId === targetProject.id).map((item) => item.id));
      const remainingConversations = conversations.filter((item) => item.projectId !== targetProject.id);
      setProjects((current) => current.filter((item) => item.id !== targetProject.id));
      setConversations(remainingConversations);
      setExpandedProjects((current) => { const next = new Set(current); next.delete(targetProject.id); return next; });
      setRunningSessionIds((current) => new Set([...current].filter((id) => !removedSessionIDs.has(id))));
      if (removedSessionIDs.has(selected)) {
        const fallback = remainingConversations[0]?.id || standaloneSessions[0]?.id || "";
        setSelected(fallback);
        setSelectedProject(remainingConversations.find((item) => item.id === fallback)?.projectId || "");
        setFilePanelOpen(false);
      }
      setStatus(`项目 ${targetProject.name} 已取消登记，NAS 文件保持不变。`);
    } catch (error) { setStatus(`取消项目登记失败：${error instanceof Error ? error.message : "未知错误"}`); }
  };

  const renameSession = async (targetSession) => {
    const runtimeID = runtimeSessions[targetSession.id] || (!isHistoricalConversation(targetSession.id) && !targetSession.id.startsWith("ses_local") ? targetSession.id : "");
    if (!runtimeID && !targetSession.id.startsWith("ses_local")) { setStatus("历史会话尚未建立运行时映射，暂不能重命名。"); return; }
    const title = window.prompt("输入新的会话名称", targetSession.title)?.trim();
    if (!title || title === targetSession.title) return;
    setStatus(`正在重命名会话…`);
    try {
      const result = targetSession.id.startsWith("ses_local")
        ? await workbenchApi.renameSessionDraft(targetSession.id, title)
        : await workbenchApi.renameSession(runtimeID, title);
      if (isHistoricalConversation(targetSession.id)) await migrationApi.rename(targetSession.id, title);
      const updated = result?.data || { ...targetSession, title };
      setConversations((current) => current.map((item) => item.id === targetSession.id ? { ...item, ...updated } : item));
      setStandaloneSessions((current) => current.map((item) => item.id === targetSession.id ? { ...item, ...updated } : item));
      setStatus(`会话已重命名为 ${updated.title || title}。`);
    } catch (error) { setStatus(`会话重命名失败：${error instanceof Error ? error.message : "未知错误"}`); }
  };

  const deleteSession = async (targetSession) => {
    const runtimeID = runtimeSessions[targetSession.id] || (!isHistoricalConversation(targetSession.id) && !targetSession.id.startsWith("ses_local") ? targetSession.id : "");
    if (!runtimeID && !targetSession.id.startsWith("ses_local")) { setStatus("历史会话尚未建立运行时映射，暂不能删除。"); return; }
    if (!window.confirm(`删除会话“${targetSession.title}”？此操作会由服务端同步清理会话映射。`)) return;
    setStatus("正在删除会话…");
    try {
      if (targetSession.id.startsWith("ses_local")) await workbenchApi.deleteSessionDraft(targetSession.id);
      else await workbenchApi.deleteSession(runtimeID);
      if (isHistoricalConversation(targetSession.id)) await migrationApi.detach(targetSession.id);
      const remainingConversations = conversations.filter((item) => item.id !== targetSession.id);
      const remainingStandalone = standaloneSessions.filter((item) => item.id !== targetSession.id);
      setConversations(remainingConversations);
      setStandaloneSessions(remainingStandalone);
      updateRunningSession(targetSession.id, false);
      if (selected === targetSession.id) {
        const fallback = remainingConversations[0]?.id || remainingStandalone[0]?.id || "";
        setSelected(fallback);
        setSelectedProject(remainingConversations.find((item) => item.id === fallback)?.projectId || "");
        setFilePanelOpen(false);
      }
      setStatus("会话已删除。");
    } catch (error) { setStatus(`会话删除失败：${error instanceof Error ? error.message : "未知错误"}`); }
  };

  const forkSession = async (targetSession) => {
    const runtimeID = runtimeSessions[targetSession.id] || (!isHistoricalConversation(targetSession.id) && !targetSession.id.startsWith("ses_local") ? targetSession.id : "");
    if (!runtimeID) { setStatus("历史会话尚未建立运行时映射，暂不能 Fork。"); return; }
    setStatus("正在 Fork 会话…");
    try {
      const result = await workbenchApi.forkSession(runtimeID);
      const remote = result.data;
      const projectID = targetSession.projectId && !targetSession.projectId.startsWith("standalone:") ? targetSession.projectId : "";
      const next = { ...remote, id: remote.id, title: remote.title || `${targetSession.title} · Fork`, updatedAt: Number(remote.time?.updated || remote.time?.created || Date.now()), runtimeSessionId: remote.id, ...(projectID ? { projectId: projectID } : { fileScope: remote.id }) };
      if (projectID) {
        setConversations((current) => [next, ...current.filter((item) => item.id !== next.id)]);
        setSelectedProject(projectID);
        setExpandedProjects((current) => new Set([...current, projectID]));
      } else {
        setStandaloneSessions((current) => [next, ...current.filter((item) => item.id !== next.id)]);
        setSelectedProject("");
      }
      setMessagesBySession((current) => ({ ...current, [next.id]: [] }));
      setSelected(next.id);
      setRunning(false);
      setFilePanelOpen(false);
      setStatus("Fork 会话已创建并切换。");
    } catch (error) { setStatus(`Fork 会话失败：${error instanceof Error ? error.message : "未知错误"}`); }
  };

  const openDiff = async () => {
    if (!activeRuntimeID) { setStatus("当前历史会话尚未建立运行时映射，无法读取 Diff。"); return; }
    setDiffOpen(true); setDiffLoading(true); setDiffError("");
    try {
      const result = await workbenchApi.diff(activeRuntimeID);
      setDiffItems(Array.isArray(result.data) ? result.data : []);
    } catch (error) { setDiffError(error instanceof Error ? error.message : "Diff 暂时无法读取。"); }
    finally { setDiffLoading(false); }
  };

  const openProjectFiles = (targetProject) => {
    setFilePanelProjectId(targetProject.id);
    setFilePanelRequest(null);
    setFilePanelOpen(true);
    setSidebarOpen(false);
  };

  const openCurrentFiles = (path = "") => {
    setFocusMode(false);
    setFilePanelProjectId("");
    const projectNames = [project?.workspaceDirectory, project?.name].filter(Boolean);
    const targetPath = typeof path === "string" ? projectFilePath(path, projectNames, { allowBare: true }) : "";
    setFilePanelRequest(targetPath ? { path: targetPath, key: `${Date.now()}:${targetPath}` } : null);
    setFilePanelOpen(true);
  };

  const openCapabilities = async () => {
    setCapabilityOpen(true);
    setCapabilityLoading(true);
    setCapabilityError("");
    try {
      const [profileResult, skillResult] = await Promise.all([workbenchApi.profiles(), workbenchApi.skills()]);
      setProfiles(profileResult.data || []);
      setSkills(skillResult.data || []);
      setSkillReport({ reported: Boolean(skillResult.reported), workerActive: Boolean(skillResult.workerActive) });
    } catch (error) {
      setCapabilityError(error instanceof Error ? error.message : "能力中心暂时无法读取。");
    } finally {
      setCapabilityLoading(false);
    }
  };

  const openPlugins = async () => {
    setPluginOpen(true); setPluginLoading(true); setPluginError("");
    try { setPlugins((await workbenchApi.plugins(project?.id)).data || []); }
    catch (error) { setPluginError(error instanceof Error ? error.message : "插件中心暂时无法读取。"); }
    finally { setPluginLoading(false); }
  };
  const changePlugin = async (plugin, update) => {
    setPluginLoading(true); setPluginError("");
    try {
      await workbenchApi.updatePlugin(plugin.id, { ...update, ...(project?.id ? { projectId: project.id } : {}) });
      setPlugins((await workbenchApi.plugins(project?.id)).data || []);
    } catch (error) { setPluginError(error instanceof Error ? error.message : "插件设置保存失败。"); }
    finally { setPluginLoading(false); }
  };

  const panoramaAction = async (action = "graph") => {
    if (!activeRuntimeID) return;
    if (action === "summarize") {
      setInsightsBySession((current) => ({ ...current, [selected]: { ...current[selected], summarizing: true } }));
      setStatus("正在压缩当前会话上下文…");
      try {
        await agentApi.summarize(activeRuntimeID);
        await reconcileRef.current();
        setStatus("Worker 已接受压缩请求；上下文变化将在下一次快照中确认。");
      } catch (error) {
        setStatus(`压缩失败：${error instanceof Error ? error.message : "未知错误"}`);
      } finally {
        setInsightsBySession((current) => ({ ...current, [selected]: { ...current[selected], summarizing: false } }));
      }
      return;
    }
    setInsightsBySession((current) => ({ ...current, [selected]: { ...current[selected], graphLoading: true, graphError: "" } }));
    try {
      const result = await workbenchApi.graph(activeRuntimeID);
      setInsightsBySession((current) => ({ ...current, [selected]: { ...current[selected], graph: result.data, graphLoading: false } }));
    } catch (error) {
      setInsightsBySession((current) => ({ ...current, [selected]: { ...current[selected], graphLoading: false, graphError: error instanceof Error ? error.message : "工作图读取失败。" } }));
    }
  };
  const openControl = () => {
    setControlOpen(true);
    if (activeRuntimeID) void panoramaAction("graph");
  };

  const attachFile = (item) => {
    if (!item?.path) return;
    const owned = { ...item, ownerSessionID: selected };
    setAttachments((current) => current.some((value) => attachmentIdentity(value) === attachmentIdentity(owned)) ? current : [...current, owned]);
  };

  const removeAttachment = (item) => {
    const identity = attachmentIdentity(item);
    setAttachments((current) => current.filter((value) => attachmentIdentity(value) !== identity));
  };

  const removeDeletedAttachment = (item) => {
    setAttachments((current) => removeDeletedAttachmentReferences(current, item));
  };

  const exportConversation = () => {
    if (!session) return;
    const markdown = [`# ${session.title || "新会话"}`, "", ...messages.flatMap((item) => [`## ${item.role === "user" ? "你" : "YEUTECH Agent"}`, "", item.text || "", ""])].join("\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${session.title || "新会话"}.md`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return { loadOlder, createSession, createProjectSession, createProject, registerProject, selectSession, send, stop, replyPermission, changePermissionMode, selectProject, renameProject, deleteProject, renameSession, deleteSession, forkSession, openDiff, openProjectFiles, openCurrentFiles, openCapabilities, openPlugins, changePlugin, panoramaAction, openControl, attachFile, removeAttachment, removeDeletedAttachment, exportConversation };
}
