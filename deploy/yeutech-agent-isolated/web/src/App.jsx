import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentApi, migrationApi } from "./api.js";
import { Icon } from "./icons.jsx";

const demoSession = { id: "ses_demo", title: "修复登录状态", time: "刚刚", model: "claude-haiku-4-5-20251001" };
const demoMessages = [
  { id: "demo-user", role: "user", text: "检查这个项目并给出下一步建议" },
  { id: "demo-assistant", role: "assistant", text: "我已经开始检查 Project A，正在读取项目结构、依赖和关键配置。" },
];

function YeutechMark() {
  return <svg className="yeutech-mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="16" fill="currentColor" /><path d="M18.5 19.5 32 31.5l13.5-12M32 31.5v15" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" /><rect x="13" y="14" width="11" height="11" rx="3" fill="white" /><rect x="40" y="14" width="11" height="11" rx="3" fill="white" /><rect x="26.5" y="41" width="11" height="11" rx="3" fill="white" /></svg>;
}

function Sidebar({ sessions, selected, modelCount, legacyProjects, legacyConversations, selectedLegacyProject, onSelect, onSelectLegacyProject, onNew, onRefresh, onOpenHistory }) {
  const [query, setQuery] = useState("");
  const visible = sessions.filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleLegacy = legacyConversations.filter((session) => session.projectId === selectedLegacyProject && session.title.toLowerCase().includes(query.trim().toLowerCase()));
  return <aside className="sidebar"><div className="sidebar-actions">
    <button className="primary-button" onClick={onNew}><Icon name="chatPlus" />新建独立会话</button>
    <div className="sidebar-action-grid"><button><Icon name="plus" />新建项目</button><button><Icon name="folderIn" />发现 NAS 项目</button></div>
    <button className="sidebar-action" onClick={onOpenHistory}><Icon name="upload" />导入会话<span>{legacyConversations.length || ""}</span></button>
    <button className="sidebar-action" onClick={onRefresh}><Icon name="sparkles" />能力中心<span>{modelCount} 项</span></button>
    <label className="search"><Icon name="search" /><input aria-label="搜索会话与项目" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部会话与项目" /></label>
  </div><div className="sidebar-list"><p className="eyebrow">当前项目</p><div className="project-heading"><Icon name="chevronDown" /><Icon name="folder" /><strong>Project A</strong><small>本机</small></div><button className="project-new" onClick={onNew}><Icon name="chatPlus" />新建会话</button><nav>{visible.map((session) => <button key={session.id} className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}><span><Icon name="chat" /><b>{session.title}</b><time>{session.time}</time></span><small>{session.model || "CLIProxyAPI"} · 推理高</small></button>)}</nav>
    {legacyProjects.length ? <><p className="eyebrow history-heading">历史项目 · 本地副本</p><div className="history-projects">{legacyProjects.map((project) => <button key={project.id} className={selectedLegacyProject === project.id ? "selected" : ""} onClick={() => onSelectLegacyProject(project.id)}><Icon name="folder" /><span><strong>{project.name}</strong><small>{project.owner} · {project.conversationCount} 个会话</small></span></button>)}</div><nav className="history-sessions">{visibleLegacy.map((session) => <button key={session.id} className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}><span><Icon name="chat" /><b>{session.title}</b><time>{session.archived ? "归档" : "历史"}</time></span><small>{session.messageCount} 条 · 点击查看</small></button>)}</nav></> : null}
  </div></aside>;
}

function HistoryDialog({ open, projects, conversations, selectedProject, onSelectProject, onSelectConversation, onClose }) {
  if (!open) return null;
  const visible = conversations.filter((item) => item.projectId === selectedProject);
  return <div className="history-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title"><header><div><h2 id="history-title">历史项目与会话</h2><p>数据来自 2026-09-12 本地只读快照，不连接线上 Codex。</p></div><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button></header><div className="history-browser"><nav>{projects.map((project) => <button key={project.id} className={selectedProject === project.id ? "selected" : ""} onClick={() => onSelectProject(project.id)}><Icon name="folder" /><span><strong>{project.name}</strong><small>{project.owner} · {project.conversationCount} 个会话</small></span></button>)}</nav><div className="history-conversations">{visible.length ? visible.map((item) => <button key={item.id} onClick={() => onSelectConversation(item.id)}><span><strong>{item.title}</strong><small>{item.messageCount} 条可见消息 · {item.archived ? "已归档" : "可继续"}</small></span><Icon name="chevron" /></button>) : <p>这个项目的快照中没有历史会话。</p>}</div></div><footer><Icon name="shield" /><span>旧会话保持只读；继续时会创建新的 OpenCode session，并保存新旧 ID 映射。</span></footer></section></div>;
}

function Activity({ running, status }) {
  return <div className="activity"><span className={running ? "activity-spinner" : "activity-check"}>{running ? null : <Icon name="check" size={14} />}</span><div><strong>{running ? "Agent 正在执行" : "已读取受限工作区"}</strong><p>{status || "只访问 Project A 样本目录，命令和写入能力保持关闭。"}</p></div></div>;
}

function Conversation({ session, messages, olderCursor, loadingOlder, models, model, running, status, legacy, continuing, onLoadOlder, onModelChange, onSend, onStop, onContinue }) {
  const [draft, setDraft] = useState("");
  const messagesRef = useRef(null);
  const lastMessageID = messages.at(-1)?.id;
  useLayoutEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [session?.id, lastMessageID]);
  const submit = () => { const value = draft.trim(); if (!value) return; setDraft(""); onSend(value); };
  return <section className="conversation"><header className="conversation-header"><div className="agent-logo"><YeutechMark /></div><div className="conversation-title"><small>{legacy ? "历史项目" : "Project A"} <Icon name="chevron" size={11} /> {legacy ? "只读会话" : "项目会话"}</small><h2>{session?.title || "新会话"}</h2></div><button className="icon-button" aria-label="导出当前会话"><Icon name="download" /></button><button className="icon-button" aria-label="进入专注模式"><Icon name="maximize" /></button><button className="icon-button" aria-label="打开项目文件"><Icon name="folder" /></button></header>
    <div className={`mode-notice ${legacy ? "history" : ""}`}><Icon name="shield" /><span><strong>{legacy ? "历史只读副本。" : "本地代理隔离模式。"}</strong> {legacy ? "消息不会改写；点击继续后进入新的 OpenCode 会话。" : "Agent 通过本机 CLIProxyAPI 调用模型；以后切换 NAS 只替换上游地址。"}</span></div>
    <div className="messages" ref={messagesRef}>{messages.length === 0 ? <div className="empty-conversation"><div className="empty-icon"><Icon name="folder" size={23} /></div><strong>{legacy ? "正在读取历史会话" : "开始第一次会话"}</strong><span>{legacy ? "数据来自本地备份。" : "当前使用 Project A 的本地受限副本。"}</span></div> : <>{legacy ? null : <Activity running={running} status={status} />}{olderCursor ? <button className="load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? "正在读取…" : "显示更早的 200 条消息"}</button> : null}{messages.map((message) => <div className="message-block" key={message.id}>{message.migrationBoundary ? <div className="migration-boundary"><span>迁移后继续内容</span></div> : null}{message.role === "user" ? <div className="message user"><small>{legacy ? "历史用户" : "你"}</small><p>{message.text}</p></div> : <div className="message assistant"><div className="assistant-mark"><YeutechMark /></div><div><small>{legacy ? message.source || "历史助手" : "YEUTECH Agent"}</small><p>{message.text || "正在准备回复…"}</p></div></div>}</div>)}</>}</div>
    <div className="composer-wrap">{legacy ? <div className="continue-card glass-control"><div><strong>从这里继续工作</strong><span>会创建新会话，旧消息和来源 ID 保持不变。</span></div><button className="primary-button" disabled={continuing} onClick={onContinue}><Icon name="chatPlus" />{continuing ? "正在创建…" : "继续此会话"}</button></div> : <div className="composer glass-control"><textarea aria-label="向 Agent 发送消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder={running ? "输入补充要求，发送后继续当前任务…" : "描述任务，或添加图片、PDF、Word、Excel…"} /><div className="composer-tools"><button className="tool-button" aria-label="添加附件"><Icon name="plus" /></button><span className="attachment-label"><Icon name="paperclip" size={14} />附件</span><select aria-label="当前会话模型" value={model} onChange={(event) => onModelChange(event.target.value)}>{models.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select aria-label="推理强度" defaultValue="high"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><div className="composer-spacer" />{running ? <button className="tool-button stop" aria-label="停止" onClick={onStop}><Icon name="stop" /></button> : null}<button className="send-button" aria-label="发送" onClick={submit}><Icon name="arrowUp" /></button></div></div>}</div>
  </section>;
}

function normalizeMessages(records) {
  return (records || []).flatMap((record) => {
    const role = record.info?.role || "assistant";
    const text = (record.parts || []).filter((part) => part.type === "text").map((part) => part.text).join("");
    if (!text && role !== "assistant") return [];
    const displayText = !text && record.info?.time?.completed
      ? "模型授权当前不可用，会话已经保留。恢复 CLIProxyAPI 对应账号后可以继续。"
      : text;
    return [{ id: record.info?.id || `msg_${Math.random()}`, role, text: displayText }];
  });
}

function readableStatus(state) {
  if (!state) return "";
  if (state.message?.includes("auth_unavailable")) return "CLIProxyAPI 已连通，但当前模型账号授权已失效。";
  return state.message || "Agent 正在执行";
}

export function App() {
  const [sessions, setSessions] = useState([demoSession]);
  const [selected, setSelected] = useState(demoSession.id);
  const [messagesBySession, setMessagesBySession] = useState({ [demoSession.id]: demoMessages });
  const [messageCursors, setMessageCursors] = useState({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [models, setModels] = useState([{ id: demoSession.model, name: demoSession.model }]);
  const [model, setModel] = useState(demoSession.model);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [legacyProjects, setLegacyProjects] = useState([]);
  const [legacyConversations, setLegacyConversations] = useState([]);
  const [selectedLegacyProject, setSelectedLegacyProject] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const pollVersion = useRef(0);

  const refresh = async () => {
    try {
      const [remoteSessions, providerConfig, states] = await Promise.all([agentApi.sessions(), agentApi.providers(), agentApi.status()]);
      const yeutech = providerConfig.providers?.find((provider) => provider.id === "yeutech");
      const catalog = Object.values(yeutech?.models || {}).map((item) => ({ id: item.id, name: item.name || item.id }));
      if (catalog.length) { setModels(catalog); setModel((current) => catalog.some((item) => item.id === current) ? current : catalog[0].id); }
      if (remoteSessions.length) { const mapped = remoteSessions.map((item) => ({ id: item.id, title: item.title || "新会话", time: "刚刚", model: item.model?.modelID || item.model?.id || catalog[0]?.id })); const nextSelected = selected.includes(":") || mapped.some((item) => item.id === selected) ? selected : mapped[0].id; setSessions(mapped); setSelected(nextSelected); setRunning(Boolean(states[nextSelected])); setStatus(readableStatus(states[nextSelected])); }
    } catch { setStatus("本地 Agent 还没有连接，当前显示交互样本。"); }
  };

  useEffect(() => {
    void refresh();
    Promise.all([migrationApi.projects(), migrationApi.conversations()]).then(([projects, conversations]) => {
      setLegacyProjects(projects);
      setLegacyConversations(conversations);
      setSelectedLegacyProject(projects[0]?.id || "");
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (selected.includes(":")) {
      let current = true;
      migrationApi.messages(selected).then((page) => {
        if (!current) return;
        setMessagesBySession((messages) => ({ ...messages, [selected]: page.records }));
        setMessageCursors((cursors) => ({ ...cursors, [selected]: page.cursor }));
      }).catch((error) => setStatus(error.message));
      return () => { current = false; };
    }
    if (selected.startsWith("ses_local") || selected === "ses_demo") return;
    let current = true;
    agentApi.messages(selected).then((page) => {
      if (!current) return;
      setMessagesBySession((messages) => ({ ...messages, [selected]: normalizeMessages(page.records) }));
      setMessageCursors((cursors) => ({ ...cursors, [selected]: page.cursor }));
    }).catch(() => {});
    return () => { current = false; };
  }, [selected]);
  useEffect(() => { const sessionModel = sessions.find((item) => item.id === selected)?.model; if (sessionModel && models.some((item) => item.id === sessionModel)) setModel(sessionModel); }, [models, selected, sessions]);

  const session = sessions.find((item) => item.id === selected) || legacyConversations.find((item) => item.id === selected);
  const legacy = selected.includes(":");
  const messages = messagesBySession[selected] || [];
  const loadOlder = async () => {
    const cursor = messageCursors[selected];
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = legacy ? await migrationApi.messages(selected, cursor) : await agentApi.messages(selected, cursor);
      const older = legacy ? page.records : normalizeMessages(page.records);
      setMessagesBySession((current) => {
        const existing = new Set((current[selected] || []).map((item) => item.id));
        return { ...current, [selected]: [...older.filter((item) => !existing.has(item.id)), ...(current[selected] || [])] };
      });
      setMessageCursors((current) => ({ ...current, [selected]: page.cursor }));
    } finally { setLoadingOlder(false); }
  };
  const createSession = () => { pollVersion.current += 1; const next = { id: `ses_local_${Date.now()}`, title: "新会话", time: "刚刚", model }; setSessions((current) => [next, ...current]); setMessagesBySession((current) => ({ ...current, [next.id]: [] })); setSelected(next.id); setRunning(false); setStatus(""); };
  const send = async (text) => {
    const currentPoll = pollVersion.current + 1;
    pollVersion.current = currentPoll;
    const localID = selected; const title = text.slice(0, 28); const message = { id: `msg_local_${Date.now()}`, role: "user", text };
    setSessions((current) => current.map((item) => item.id === localID ? { ...item, title, model } : item)); setMessagesBySession((current) => ({ ...current, [localID]: [...(current[localID] || []), message] })); setRunning(true); setStatus("正在通过 CLIProxyAPI 调用模型…");
    try {
      const remote = localID.startsWith("ses_local") || localID === "ses_demo" ? await agentApi.createSession(title) : session;
      if (!remote) return;
      if (remote.id !== localID) { setSessions((current) => current.map((item) => item.id === localID ? { ...item, ...remote, title, model, time: "刚刚" } : item)); setMessagesBySession((current) => { const next = { ...current, [remote.id]: current[localID] || [message] }; delete next[localID]; return next; }); setSelected(remote.id); }
      await agentApi.prompt(remote.id, text, model);
      for (let attempt = 0; attempt < 70 && pollVersion.current === currentPoll; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const [page, states] = await Promise.all([agentApi.messages(remote.id), agentApi.status()]);
        const normalized = normalizeMessages(page.records);
        const state = states[remote.id];
        const lastRecord = page.records.at(-1);
        const authorizationUnavailable = normalized.at(-1)?.text.startsWith("模型授权当前不可用");
        setMessagesBySession((current) => ({ ...current, [remote.id]: normalized }));
        setMessageCursors((current) => ({ ...current, [remote.id]: page.cursor }));
        setRunning(Boolean(state));
        setStatus(authorizationUnavailable ? "CLIProxyAPI 已连通，但当前模型账号授权已失效。" : readableStatus(state));
        if (!state && lastRecord?.info?.role === "assistant" && lastRecord.info.time?.completed) break;
      }
    } catch (error) { setRunning(false); setStatus(error instanceof Error ? error.message : "请求失败"); }
  };
  const stop = async () => { pollVersion.current += 1; setRunning(false); setStatus("已停止，会话内容保留。"); if (!selected.startsWith("ses_local") && selected !== "ses_demo") await agentApi.abort(selected).catch(() => {}); };
  const continueLegacy = async () => {
    if (!legacy || continuing) return;
    setContinuing(true);
    try {
      const result = await migrationApi.continue(selected);
      const remote = result.session;
      setSessions((current) => current.some((item) => item.id === remote.id) ? current : [{ id: remote.id, title: remote.title || session.title, time: "刚刚", model }, ...current]);
      const page = await agentApi.messages(remote.id);
      setMessagesBySession((current) => ({ ...current, [remote.id]: normalizeMessages(page.records) }));
      setMessageCursors((current) => ({ ...current, [remote.id]: page.cursor }));
      setSelected(remote.id);
      setStatus(result.reused ? "已回到此前创建的 OpenCode 续写会话。" : "已创建 OpenCode 续写会话，迁移上下文已写入且未触发模型。 ");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "创建续写会话失败");
    } finally {
      setContinuing(false);
    }
  };
  const selectLegacyConversation = (id) => { setSelected(id); setHistoryOpen(false); };

  return <div className="portal-shell"><main className="workspace"><section className="workbench-toolbar"><div><h1>AI 工作台</h1><p>{legacyProjects.length} 个历史项目 · {legacyConversations.length} 个历史会话已在本地</p></div><div className="toolbar-actions"><button onClick={refresh}><Icon name="refresh" />检查并恢复连接</button><span className="capability"><Icon name="check" size={14} />CLIProxyAPI · {models.length} 个模型</span><button><Icon name="back" />返回门户</button></div></section><section className="command-stage"><Sidebar sessions={sessions} selected={selected} modelCount={models.length} legacyProjects={legacyProjects} legacyConversations={legacyConversations} selectedLegacyProject={selectedLegacyProject} onSelect={setSelected} onSelectLegacyProject={setSelectedLegacyProject} onNew={createSession} onRefresh={refresh} onOpenHistory={() => setHistoryOpen(true)} /><Conversation session={session} messages={messages} olderCursor={messageCursors[selected]} loadingOlder={loadingOlder} models={models} model={model} running={running} status={status} legacy={legacy} continuing={continuing} onLoadOlder={loadOlder} onModelChange={setModel} onSend={send} onStop={stop} onContinue={continueLegacy} /></section></main><HistoryDialog open={historyOpen} projects={legacyProjects} conversations={legacyConversations} selectedProject={selectedLegacyProject} onSelectProject={setSelectedLegacyProject} onSelectConversation={selectLegacyConversation} onClose={() => setHistoryOpen(false)} /></div>;
}
