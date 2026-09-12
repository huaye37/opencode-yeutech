import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentApi } from "./api.js";
import { Icon } from "./icons.jsx";

const demoSession = { id: "ses_demo", title: "修复登录状态", time: "刚刚", model: "claude-haiku-4-5-20251001" };
const demoMessages = [
  { id: "demo-user", role: "user", text: "检查这个项目并给出下一步建议" },
  { id: "demo-assistant", role: "assistant", text: "我已经开始检查 Project A，正在读取项目结构、依赖和关键配置。" },
];

function YeutechMark() {
  return <svg className="yeutech-mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="16" fill="currentColor" /><path d="M18.5 19.5 32 31.5l13.5-12M32 31.5v15" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" /><rect x="13" y="14" width="11" height="11" rx="3" fill="white" /><rect x="40" y="14" width="11" height="11" rx="3" fill="white" /><rect x="26.5" y="41" width="11" height="11" rx="3" fill="white" /></svg>;
}

function Sidebar({ sessions, selected, modelCount, onSelect, onNew, onRefresh }) {
  const [query, setQuery] = useState("");
  const visible = sessions.filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()));
  return <aside className="sidebar"><div className="sidebar-actions">
    <button className="primary-button" onClick={onNew}><Icon name="chatPlus" />新建独立会话</button>
    <div className="sidebar-action-grid"><button><Icon name="plus" />新建项目</button><button><Icon name="folderIn" />发现 NAS 项目</button></div>
    <button className="sidebar-action"><Icon name="upload" />导入会话</button>
    <button className="sidebar-action" onClick={onRefresh}><Icon name="sparkles" />能力中心<span>{modelCount} 项</span></button>
    <label className="search"><Icon name="search" /><input aria-label="搜索会话与项目" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部会话与项目" /></label>
  </div><div className="sidebar-list"><p className="eyebrow">项目</p><div className="project-heading"><Icon name="chevronDown" /><Icon name="folder" /><strong>Project A</strong><small>本机</small></div><button className="project-new" onClick={onNew}><Icon name="chatPlus" />新建会话</button><nav>{visible.map((session) => <button key={session.id} className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}><span><Icon name="chat" /><b>{session.title}</b><time>{session.time}</time></span><small>{session.model || "CLIProxyAPI"} · 推理高</small></button>)}</nav></div></aside>;
}

function Activity({ running, status }) {
  return <div className="activity"><span className={running ? "activity-spinner" : "activity-check"}>{running ? null : <Icon name="check" size={14} />}</span><div><strong>{running ? "Agent 正在执行" : "已读取受限工作区"}</strong><p>{status || "只访问 Project A 样本目录，命令和写入能力保持关闭。"}</p></div></div>;
}

function Conversation({ session, messages, olderCursor, loadingOlder, models, model, running, status, onLoadOlder, onModelChange, onSend, onStop }) {
  const [draft, setDraft] = useState("");
  const messagesRef = useRef(null);
  const lastMessageID = messages.at(-1)?.id;
  useLayoutEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [session?.id, lastMessageID]);
  const submit = () => { const value = draft.trim(); if (!value) return; setDraft(""); onSend(value); };
  return <section className="conversation"><header className="conversation-header"><div className="agent-logo"><YeutechMark /></div><div className="conversation-title"><small>Project A <Icon name="chevron" size={11} /> 项目会话</small><h2>{session?.title || "新会话"}</h2></div><button className="icon-button" aria-label="导出当前会话"><Icon name="download" /></button><button className="icon-button" aria-label="进入专注模式"><Icon name="maximize" /></button><button className="icon-button" aria-label="打开项目文件"><Icon name="folder" /></button></header>
    <div className="mode-notice"><Icon name="shield" /><span><strong>本地代理隔离模式。</strong> Agent 通过本机 CLIProxyAPI 调用模型；以后切换 NAS 只替换上游地址。</span></div>
    <div className="messages" ref={messagesRef}>{messages.length === 0 ? <div className="empty-conversation"><div className="empty-icon"><Icon name="folder" size={23} /></div><strong>开始第一次会话</strong><span>当前使用 Project A 的本地受限副本。</span></div> : <><Activity running={running} status={status} />{olderCursor ? <button className="load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? "正在读取…" : "显示更早的 200 条消息"}</button> : null}{messages.map((message) => message.role === "user" ? <div className="message user" key={message.id}><small>你</small><p>{message.text}</p></div> : <div className="message assistant" key={message.id}><div className="assistant-mark"><YeutechMark /></div><div><small>YEUTECH Agent</small><p>{message.text || "正在准备回复…"}</p></div></div>)}</>}</div>
    <div className="composer-wrap"><div className="composer glass-control"><textarea aria-label="向 Agent 发送消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder={running ? "输入补充要求，发送后继续当前任务…" : "描述任务，或添加图片、PDF、Word、Excel…"} /><div className="composer-tools"><button className="tool-button" aria-label="添加附件"><Icon name="plus" /></button><span className="attachment-label"><Icon name="paperclip" size={14} />附件</span><select aria-label="当前会话模型" value={model} onChange={(event) => onModelChange(event.target.value)}>{models.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select aria-label="推理强度" defaultValue="high"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><div className="composer-spacer" />{running ? <button className="tool-button stop" aria-label="停止" onClick={onStop}><Icon name="stop" /></button> : null}<button className="send-button" aria-label="发送" onClick={submit}><Icon name="arrowUp" /></button></div></div></div>
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
  const pollVersion = useRef(0);

  const refresh = async () => {
    try {
      const [remoteSessions, providerConfig, states] = await Promise.all([agentApi.sessions(), agentApi.providers(), agentApi.status()]);
      const yeutech = providerConfig.providers?.find((provider) => provider.id === "yeutech");
      const catalog = Object.values(yeutech?.models || {}).map((item) => ({ id: item.id, name: item.name || item.id }));
      if (catalog.length) { setModels(catalog); setModel((current) => catalog.some((item) => item.id === current) ? current : catalog[0].id); }
      if (remoteSessions.length) { const mapped = remoteSessions.map((item) => ({ id: item.id, title: item.title || "新会话", time: "刚刚", model: item.model?.modelID || item.model?.id || catalog[0]?.id })); const nextSelected = mapped.some((item) => item.id === selected) ? selected : mapped[0].id; setSessions(mapped); setSelected(nextSelected); setRunning(Boolean(states[nextSelected])); setStatus(readableStatus(states[nextSelected])); }
    } catch { setStatus("本地 Agent 还没有连接，当前显示交互样本。"); }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
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

  const session = sessions.find((item) => item.id === selected);
  const messages = messagesBySession[selected] || [];
  const loadOlder = async () => {
    const cursor = messageCursors[selected];
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await agentApi.messages(selected, cursor);
      const older = normalizeMessages(page.records);
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

  return <div className="portal-shell"><main className="workspace"><section className="workbench-toolbar"><div><h1>AI 工作台</h1><p>Project A · {sessions.length} 个会话</p></div><div className="toolbar-actions"><button onClick={refresh}><Icon name="refresh" />检查并恢复连接</button><span className="capability"><Icon name="check" size={14} />CLIProxyAPI · {models.length} 个模型</span><button><Icon name="back" />返回门户</button></div></section><section className="command-stage"><Sidebar sessions={sessions} selected={selected} modelCount={models.length} onSelect={setSelected} onNew={createSession} onRefresh={refresh} /><Conversation session={session} messages={messages} olderCursor={messageCursors[selected]} loadingOlder={loadingOlder} models={models} model={model} running={running} status={status} onLoadOlder={loadOlder} onModelChange={setModel} onSend={send} onStop={stop} /></section></main></div>;
}
