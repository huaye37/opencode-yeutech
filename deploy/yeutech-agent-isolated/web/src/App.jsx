import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentApi, migrationApi } from "./api.js";
import { Icon } from "./icons.jsx";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const SELECTED_STORAGE_KEY = "yeutech-agent-workbench:selected:v1";
const OWNED_SESSIONS_STORAGE_KEY = "yeutech-agent-workbench:owned-sessions:v1";

function isHistoricalConversation(id) {
  return String(id || "").startsWith("portal:") || String(id || "").startsWith("imported:");
}

function storedSessionIDs() {
  try {
    const value = JSON.parse(window.localStorage.getItem(OWNED_SESSIONS_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch { return []; }
}

function YeutechMark() {
  return <svg className="yeutech-mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="16" fill="currentColor" /><path d="M18.5 19.5 32 31.5l13.5-12M32 31.5v15" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" /><rect x="13" y="14" width="11" height="11" rx="3" fill="white" /><rect x="40" y="14" width="11" height="11" rx="3" fill="white" /><rect x="26.5" y="41" width="11" height="11" rx="3" fill="white" /></svg>;
}

function formatTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function inlineMarkdown(text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  return String(text || "").split(pattern).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = /^(https?:\/\/|\/)/i.test(link[2]) ? link[2] : "";
      return href ? <a key={index} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{link[1]}</a> : <span key={index}>{link[1]} <code>{link[2]}</code></span>;
    }
    return part;
  });
}

function FileReference({ path }) {
  const fileName = path.split("/").filter(Boolean).at(-1) || "项目文件";
  return <div className="file-reference" title="项目文件浏览器尚未接入"><Icon name="folder" /><span><strong>{fileName}</strong><small>{path}</small></span><em>项目文件</em></div>;
}

function MarkdownText({ text }) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let paragraph = [];
  let code = [];
  let inCode = false;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p-${blocks.length}`}>{paragraph.map((line, index) => <span key={index}>{inlineMarkdown(line)}{index < paragraph.length - 1 ? <br /> : null}</span>)}</p>);
    paragraph = [];
  };
  lines.forEach((line) => {
    if (line.startsWith("```")) {
      flushParagraph();
      if (inCode) { blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>); code = []; }
      inCode = !inCode; return;
    }
    if (inCode) { code.push(line); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); return; }
    if (line.includes(":codex-file-citation{")) {
      flushParagraph();
      const citationPattern = /:codex-file-citation\{([^}]*)\}/g;
      let cursor = 0;
      let match;
      while ((match = citationPattern.exec(line))) {
        const prefix = line.slice(cursor, match.index).trim();
        if (prefix) blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(prefix)}</p>);
        const citationPath = match[1].match(/(?:^|\s)path="([^"]+)"/)?.[1];
        if (citationPath) blocks.push(<FileReference path={citationPath} key={`file-${blocks.length}`} />);
        cursor = match.index + match[0].length;
      }
      const suffix = line.slice(cursor).trim();
      if (suffix) blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(suffix)}</p>);
      return;
    }
    if (heading) { flushParagraph(); const Tag = `h${heading[1].length + 2}`; blocks.push(<Tag key={`h-${blocks.length}`}>{inlineMarkdown(heading[2])}</Tag>); return; }
    if (bullet || ordered) { flushParagraph(); blocks.push(<div className="markdown-list-row" key={`li-${blocks.length}`}><span>{bullet ? "•" : `${line.trim().match(/^\d+/)?.[0]}.`}</span><p>{inlineMarkdown((bullet || ordered)[1])}</p></div>); return; }
    paragraph.push(line);
  });
  flushParagraph();
  if (code.length) blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
  return <div className="markdown-content">{blocks}</div>;
}

function Sidebar({ projects, conversations, standaloneSessions, selected, selectedProject, modelCount, onSelect, onSelectProject, onNew, onRefresh, onCollapse }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (value) => !normalizedQuery || String(value || "").toLowerCase().includes(normalizedQuery);
  return <aside className="sidebar"><div className="sidebar-actions">
    <div className="primary-action-row"><button className="primary-button" onClick={onNew}><Icon name="chatPlus" />新建独立会话</button><button className="collapse-button" aria-label="收起项目栏" title="收起项目栏" onClick={onCollapse}><Icon name="panel" /></button></div>
    <div className="sidebar-action-grid"><button disabled title="NAS 接入后启用"><Icon name="plus" />新建项目</button><button disabled title="NAS 接入后启用"><Icon name="folderIn" />发现 NAS 项目</button></div>
    <button className="sidebar-action" disabled title="正式导入器尚未接入"><Icon name="upload" />导入会话</button>
    <button className="sidebar-action" onClick={onRefresh}><Icon name="sparkles" />能力中心<span>{modelCount} 项</span></button>
    <label className="search"><Icon name="search" /><input aria-label="搜索会话与项目" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部会话与项目" /></label>
  </div><div className="sidebar-list">
    {standaloneSessions.length ? <><p className="eyebrow">独立会话</p><nav>{standaloneSessions.filter((item) => matches(item.title)).map((session) => <button key={session.id} className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}><span><Icon name="chatPlus" /><b>{session.title}</b><time>{formatTime(session.updatedAt)}</time></span><small>{session.model ? `${session.model} · 推理高` : session.runtimeSessionId ? "历史会话 · 已接续" : "历史会话"}</small></button>)}</nav></> : null}
    <p className="eyebrow">项目</p>
    <div className="project-tree">{projects.map((project) => {
      const projectConversations = conversations.filter((item) => item.projectId === project.id && (matches(item.title) || matches(project.name)));
      if (normalizedQuery && !matches(project.name) && projectConversations.length === 0) return null;
      const expanded = project.id === selectedProject || Boolean(normalizedQuery);
      return <section className={`project-group ${expanded ? "expanded" : ""}`} key={project.id}><button className="project-heading" onClick={() => onSelectProject(project.id)} aria-expanded={expanded}><Icon name={expanded ? "chevronDown" : "chevron"} /><Icon name="folder" /><strong>{project.name}</strong><small>{project.availableLocally ? "本地副本" : "历史"}</small></button>{expanded ? <nav><button className="project-new" disabled title="项目写入接口尚未接入"><Icon name="chatPlus" />新建会话</button>{projectConversations.length ? projectConversations.map((session) => <button key={session.id} className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}><span><Icon name="chatPlus" /><b>{session.title}</b><time>{formatTime(session.updatedAt)}</time></span><small>{session.model ? `${session.model} · 推理${session.reasoningEffort || "高"}` : session.runtimeSessionId ? "历史会话 · 已接续" : "历史会话"}</small></button>) : <p className="project-empty">这个项目没有会话</p>}</nav> : null}</section>;
    })}</div>
  </div></aside>;
}

function Activity({ running, status }) {
  if (!running && !status) return null;
  return <div className="activity"><span className={running ? "activity-spinner" : "activity-check"}>{running ? null : <Icon name="check" size={14} />}</span><div><strong>{running ? "Agent 正在执行" : "状态已更新"}</strong><p>{status}</p></div></div>;
}

function Conversation({ session, projectName, messages, olderCursor, loadingOlder, models, model, running, status, focusMode, sidebarCollapsed, onLoadOlder, onModelChange, onSend, onStop, onExport, onOpenSidebar, onExpandSidebar, onToggleFocus }) {
  const [draft, setDraft] = useState("");
  const messagesRef = useRef(null);
  const lastMessageID = messages.at(-1)?.id;
  useLayoutEffect(() => {
    const target = messagesRef.current;
    if (!target) return;
    target.scrollTop = target.scrollHeight;
    let secondFrame;
    const firstFrame = window.requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
      secondFrame = window.requestAnimationFrame(() => { target.scrollTop = target.scrollHeight; });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [session?.id, lastMessageID]);
  const submit = () => { const value = draft.trim(); if (!value) return; setDraft(""); onSend(value); };
  if (!session) return <section className="conversation empty-workbench"><div className="empty-icon"><Icon name="folder" size={23} /></div><strong>选择一个项目会话</strong><span>项目和会话来自本地只读副本。</span></section>;
  return <section className="conversation"><header className="conversation-header"><button className="icon-button mobile-menu-button" aria-label="打开会话与项目" onClick={onOpenSidebar}><Icon name="menu" /></button>{sidebarCollapsed && !focusMode ? <button className="icon-button desktop-expand-button" aria-label="展开项目栏" onClick={onExpandSidebar}><Icon name="panel" /></button> : null}<div className="agent-logo"><YeutechMark /></div><div className="conversation-title"><small>{projectName || "独立会话"}{projectName ? <><Icon name="chevron" size={11} />项目会话</> : null}</small><h2>{session.title || "新会话"}</h2></div><button className="icon-button" aria-label="导出当前会话" onClick={onExport}><Icon name="download" /></button><button className="icon-button" aria-label={focusMode ? "退出专注模式" : "进入专注模式"} onClick={onToggleFocus}><Icon name="maximize" /></button>{projectName ? <button className="icon-button" aria-label="项目文件暂未接入" disabled title="项目文件已经备份，本地文件浏览器将在下一阶段接入"><Icon name="folder" /></button> : null}</header>
    <div className="messages" ref={messagesRef}>{messages.length === 0 ? <div className="empty-conversation"><div className="empty-icon"><Icon name="chatPlus" size={22} /></div><strong>开始会话</strong><span>当前内容会保存在 Ryan 的独立 OpenCode 数据目录。</span></div> : <>{olderCursor ? <button className="load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? "正在读取…" : "加载更早消息"}</button> : null}<Activity running={running} status={status} />{messages.map((message) => <article className={`message-block ${message.role}`} key={message.id}>{message.role === "user" ? <div className="message user"><div className="user-bubble"><MarkdownText text={message.text} /></div><time>{formatTime(message.createdAt)}</time></div> : <div className="message assistant"><div className="assistant-mark"><YeutechMark /></div><div className="assistant-body"><MarkdownText text={message.text || "正在准备回复…"} /><footer><span />{message.text ? "本轮已结束" : "正在回复"}{message.createdAt ? <><b>·</b><time>{formatTime(message.createdAt)}</time></> : null}</footer></div></div>}</article>)}</>}</div>
    <div className="composer-wrap"><div className="composer glass-control"><textarea aria-label="向 Agent 发送消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder={running ? "输入补充要求，发送后继续当前任务…" : "描述任务，或添加图片、PDF、Word、Excel…"} /><div className="composer-tools"><button className="tool-button" aria-label="附件暂未接入" disabled title="附件将在本地文件接口接入后启用"><Icon name="plus" /></button><span className="attachment-label"><Icon name="paperclip" size={14} />附件</span><select aria-label="当前会话模型" value={model} onChange={(event) => onModelChange(event.target.value)}>{models.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select aria-label="推理强度" defaultValue="high"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><div className="composer-spacer" />{running ? <button className="tool-button stop" aria-label="停止" onClick={onStop}><Icon name="stop" /></button> : null}<button className="send-button" aria-label="发送" onClick={submit}><Icon name="arrowUp" /></button></div></div></div>
  </section>;
}

function normalizeRuntimeMessages(records) {
  return (records || []).flatMap((record) => {
    const role = record.info?.role || "assistant";
    const text = (record.parts || []).filter((part) => part.type === "text").map((part) => part.text).join("");
    if (role === "user" && text.startsWith("[历史会话迁移上下文]")) return [];
    if (!text && role !== "assistant") return [];
    const displayText = !text && record.info?.time?.completed ? "模型授权当前不可用，会话已经保留。恢复 CLIProxyAPI 对应账号后可以继续。" : text;
    return [{ id: `runtime-${record.info?.id || Math.random()}`, role, text: displayText, createdAt: Number(record.info?.time?.created), origin: "runtime" }];
  });
}

function readableStatus(state) {
  if (!state) return "";
  if (state.message?.includes("auth_unavailable")) return "CLIProxyAPI 已连通，但当前模型账号授权已失效。";
  return state.message || "Agent 正在执行";
}

export function App() {
  const [projects, setProjects] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [standaloneSessions, setStandaloneSessions] = useState([]);
  const [selected, setSelected] = useState(() => window.localStorage.getItem(SELECTED_STORAGE_KEY) || "");
  const [selectedProject, setSelectedProject] = useState("");
  const [messagesBySession, setMessagesBySession] = useState({});
  const [messageCursors, setMessageCursors] = useState({});
  const [runtimeSessions, setRuntimeSessions] = useState({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [models, setModels] = useState([{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [ownedRuntimeIDs, setOwnedRuntimeIDs] = useState(storedSessionIDs);
  const pollVersion = useRef(0);

  const refresh = async () => {
    try {
      const [remoteSessions, providerConfig, states, nextProjects, nextConversations] = await Promise.all([agentApi.sessions(), agentApi.providers(), agentApi.status(), migrationApi.projects(), migrationApi.conversations()]);
      const yeutech = providerConfig.providers?.find((provider) => provider.id === "yeutech");
      const catalog = Object.values(yeutech?.models || {}).map((item) => ({ id: item.id, name: item.name || item.id }));
      if (catalog.length) { setModels(catalog); setModel((current) => catalog.some((item) => item.id === current) ? current : catalog[0].id); }
      const nextRuntime = Object.fromEntries(nextConversations.filter((item) => item.runtimeSessionId).map((item) => [item.id, item.runtimeSessionId]));
      const mappedIDs = new Set(Object.values(nextRuntime));
      const historicalStandalone = nextConversations.filter((item) => item.projectId.startsWith("standalone:"));
      const ownedIDs = new Set(ownedRuntimeIDs);
      const nextStandalone = [...historicalStandalone, ...remoteSessions.filter((item) => ownedIDs.has(item.id) && !mappedIDs.has(item.id)).map((item) => ({ id: item.id, title: item.title || "新会话", model: item.model?.modelID || item.model?.id || catalog[0]?.id, updatedAt: Number(item.time?.updated || item.time?.created) }))];
      const validIDs = new Set([...nextConversations.map((item) => item.id), ...nextStandalone.map((item) => item.id)]);
      const fallback = nextConversations[0]?.id || nextStandalone[0]?.id || "";
      const nextSelected = validIDs.has(selected) ? selected : fallback;
      const activeConversation = nextConversations.find((item) => item.id === nextSelected);
      const visibleProjects = nextProjects.filter((item) => !item.id.startsWith("standalone:"));
      setProjects(visibleProjects); setConversations(nextConversations); setRuntimeSessions(nextRuntime); setStandaloneSessions(nextStandalone); setSelected(nextSelected);
      setSelectedProject(activeConversation && !activeConversation.projectId.startsWith("standalone:") ? activeConversation.projectId : "");
      const activeRuntimeID = nextRuntime[nextSelected] || nextSelected;
      setRunning(Boolean(states[activeRuntimeID])); setStatus(readableStatus(states[activeRuntimeID]));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "本地 Agent 暂时无法连接。");
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (selected) window.localStorage.setItem(SELECTED_STORAGE_KEY, selected); }, [selected]);
  useEffect(() => { window.localStorage.setItem(OWNED_SESSIONS_STORAGE_KEY, JSON.stringify(ownedRuntimeIDs)); }, [ownedRuntimeIDs]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    if (isHistoricalConversation(selected)) {
      const runtimeID = runtimeSessions[selected];
      Promise.all([migrationApi.messages(selected), runtimeID ? agentApi.messages(runtimeID) : Promise.resolve({ records: [] })]).then(([history, runtime]) => {
        if (!current) return;
        setMessagesBySession((all) => ({ ...all, [selected]: [...history.records.map((item) => ({ ...item, origin: "history" })), ...normalizeRuntimeMessages(runtime.records)] }));
        setMessageCursors((all) => ({ ...all, [selected]: history.cursor }));
      }).catch((error) => { if (current) setStatus(error.message); });
    } else if (!selected.startsWith("ses_local")) {
      agentApi.messages(selected).then((page) => {
        if (!current) return;
        setMessagesBySession((all) => ({ ...all, [selected]: normalizeRuntimeMessages(page.records) }));
        setMessageCursors((all) => ({ ...all, [selected]: page.cursor }));
      }).catch((error) => { if (current) setStatus(error.message); });
    }
    return () => { current = false; };
  }, [runtimeSessions, selected]);

  const session = conversations.find((item) => item.id === selected) || standaloneSessions.find((item) => item.id === selected);
  const project = projects.find((item) => item.id === session?.projectId);
  const messages = messagesBySession[selected] || [];
  const loadOlder = async () => {
    const cursor = messageCursors[selected];
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = isHistoricalConversation(selected) ? await migrationApi.messages(selected, cursor) : await agentApi.messages(selected, cursor);
      const older = isHistoricalConversation(selected) ? page.records.map((item) => ({ ...item, origin: "history" })) : normalizeRuntimeMessages(page.records);
      setMessagesBySession((current) => {
        const existing = new Set((current[selected] || []).map((item) => item.id));
        return { ...current, [selected]: [...older.filter((item) => !existing.has(item.id)), ...(current[selected] || [])] };
      });
      setMessageCursors((current) => ({ ...current, [selected]: page.cursor }));
    } finally { setLoadingOlder(false); }
  };
  const createSession = () => {
    pollVersion.current += 1;
    const next = { id: `ses_local_${Date.now()}`, title: "新会话", model, updatedAt: Date.now() };
    setStandaloneSessions((current) => [next, ...current]); setMessagesBySession((current) => ({ ...current, [next.id]: [] })); setSelected(next.id); setSelectedProject(""); setRunning(false); setStatus("");
  };
  const selectSession = (id) => {
    const selectionVersion = pollVersion.current + 1;
    pollVersion.current = selectionVersion;
    setSelected(id); setRunning(false); setStatus(""); setLoadingOlder(false);
    const item = conversations.find((value) => value.id === id);
    setSelectedProject(item?.projectId?.startsWith("standalone:") ? "" : item?.projectId || "");
    const remoteID = runtimeSessions[id] || (!isHistoricalConversation(id) && !id.startsWith("ses_local") ? id : "");
    if (remoteID) {
      agentApi.status().then((states) => {
        if (pollVersion.current !== selectionVersion) return;
        setRunning(Boolean(states[remoteID])); setStatus(readableStatus(states[remoteID]));
      }).catch((error) => {
        if (pollVersion.current === selectionVersion) setStatus(error instanceof Error ? error.message : "本地 Agent 暂时无法连接。");
      });
    }
  };
  const send = async (text) => {
    if (!session) return;
    const currentPoll = pollVersion.current + 1;
    pollVersion.current = currentPoll;
    const localID = selected;
    const historical = isHistoricalConversation(localID);
    const message = { id: `optimistic-${Date.now()}`, role: "user", text, createdAt: Date.now(), origin: "optimistic" };
    setMessagesBySession((current) => ({ ...current, [localID]: [...(current[localID] || []), message] })); setRunning(true); setStatus(historical && !runtimeSessions[localID] ? "正在后台接续原会话…" : "正在通过 CLIProxyAPI 调用模型…");
    try {
      let remoteID = runtimeSessions[localID];
      if (historical && !remoteID) {
        const result = await migrationApi.continue(localID);
        remoteID = result.session.id;
        setRuntimeSessions((current) => ({ ...current, [localID]: remoteID }));
        setConversations((current) => current.map((item) => item.id === localID ? { ...item, runtimeSessionId: remoteID } : item));
      } else if (!historical) {
        if (localID.startsWith("ses_local")) {
          const remote = await agentApi.createSession(text.slice(0, 28));
          remoteID = remote.id;
          setOwnedRuntimeIDs((current) => current.includes(remote.id) ? current : [remote.id, ...current]);
          setStandaloneSessions((current) => current.map((item) => item.id === localID ? { ...item, id: remote.id, title: text.slice(0, 28), model } : item));
          setMessagesBySession((current) => { const next = { ...current, [remote.id]: current[localID] || [message] }; delete next[localID]; return next; });
          setSelected(remote.id);
        } else remoteID = localID;
      }
      await agentApi.prompt(remoteID, text, model);
      for (let attempt = 0; attempt < 70 && pollVersion.current === currentPoll; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const [page, states] = await Promise.all([agentApi.messages(remoteID), agentApi.status()]);
        if (pollVersion.current !== currentPoll) break;
        const runtimeMessages = normalizeRuntimeMessages(page.records);
        const state = states[remoteID];
        const lastRecord = page.records.at(-1);
        const authorizationUnavailable = runtimeMessages.at(-1)?.text.startsWith("模型授权当前不可用");
        const displayID = historical ? localID : remoteID;
        setMessagesBySession((current) => ({ ...current, [displayID]: historical ? [...(current[displayID] || []).filter((item) => item.origin === "history"), ...runtimeMessages] : runtimeMessages }));
        setRunning(Boolean(state)); setStatus(authorizationUnavailable ? "CLIProxyAPI 已连通，但当前模型账号授权已失效。" : readableStatus(state));
        if (!state && lastRecord?.info?.role === "assistant" && lastRecord.info.time?.completed) break;
      }
    } catch (error) {
      if (pollVersion.current === currentPoll) {
        setRunning(false); setStatus(error instanceof Error ? error.message : "请求失败");
      }
    }
  };
  const stop = async () => {
    pollVersion.current += 1; setRunning(false); setStatus("已停止，会话内容保留。");
    const remoteID = runtimeSessions[selected] || (!selected.startsWith("ses_local") ? selected : "");
    if (remoteID) await agentApi.abort(remoteID).catch(() => {});
  };
  const selectProject = (projectID) => {
    if (selectedProject === projectID) {
      setSelectedProject("");
      return;
    }
    setSelectedProject(projectID);
    const first = conversations.find((item) => item.projectId === projectID);
    if (first) selectSession(first.id);
    setSidebarOpen(false);
  };

  const exportConversation = () => {
    if (!session) return;
    const markdown = [`# ${session.title || "新会话"}`, "", ...messages.flatMap((item) => [`## ${item.role === "user" ? "你" : "YEUTECH Agent"}`, "", item.text || "", ""])].join("\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${session.title || "新会话"}.md`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <div className="portal-shell"><main className={`workspace ${focusMode ? "focus-mode" : ""}`}><section className="workbench-toolbar"><div><h1>AI 工作台</h1><p>{project ? `${project.name} · ${project.conversationCount} 个会话` : session ? `Ryan · ${standaloneSessions.length} 个独立会话` : `${projects.length} 个 Ryan 项目已在本地`}</p></div><div className="toolbar-actions"><button onClick={refresh}><Icon name="refresh" />检查并恢复连接</button><span className="capability"><Icon name="check" size={14} />OpenCode 已连接 · {models.length} 个模型</span><button onClick={() => window.location.assign("http://127.0.0.1:18120/")}><Icon name="back" />返回门户</button></div></section><section className={`command-stage ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>{sidebarOpen ? <button className="sidebar-scrim" aria-label="关闭会话与项目" onClick={() => setSidebarOpen(false)} /> : null}<Sidebar projects={projects} conversations={conversations} standaloneSessions={standaloneSessions} selected={selected} selectedProject={selectedProject} modelCount={models.length} onSelect={(id) => { selectSession(id); setSidebarOpen(false); }} onSelectProject={selectProject} onNew={() => { createSession(); setSidebarOpen(false); }} onRefresh={refresh} onCollapse={() => setSidebarCollapsed(true)} /><Conversation session={session} projectName={project?.name} messages={messages} olderCursor={messageCursors[selected]} loadingOlder={loadingOlder} models={models} model={model} running={running} status={status} focusMode={focusMode} sidebarCollapsed={sidebarCollapsed} onLoadOlder={loadOlder} onModelChange={setModel} onSend={send} onStop={stop} onExport={exportConversation} onOpenSidebar={() => setSidebarOpen(true)} onExpandSidebar={() => setSidebarCollapsed(false)} onToggleFocus={() => setFocusMode((current) => !current)} /></section></main></div>;
}
