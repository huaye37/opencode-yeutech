import { useState } from "react";
import { agentApi } from "./api.js";
import { Icon } from "./icons.jsx";

const initialSessions = [
  { id: "ses_demo", title: "修复登录状态", time: "刚刚" },
  { id: "ses_models", title: "整理模型目录", time: "昨天" },
  { id: "ses_new", title: "新会话", time: "3 天前" },
];

const initialMessages = {
  ses_demo: [
    { id: "demo-user", role: "user", text: "检查这个项目并给出下一步建议" },
    { id: "demo-assistant", role: "assistant" },
  ],
};

const trace = [
  { title: "读取项目", detail: "扫描项目结构，读取关键配置文件", state: "done", items: ["package.json", "next.config.js", "src/ 目录"] },
  { title: "分析依赖", detail: "分析项目依赖和版本信息", state: "done", items: ["npm 依赖分析", "检查潜在冲突", "识别关键模块"] },
  { title: "生成建议", detail: "基于分析结果生成下一步建议", state: "active", items: ["梳理问题原因", "制定解决方案", "准备代码修改建议"] },
];

function Sidebar({ sessions, selected, onSelect, onNew }) {
  return <aside className="sidebar">
    <section><div className="section-heading"><span><Icon name="folder" />项目</span><button className="icon-button" aria-label="新建项目"><Icon name="plus" /></button></div><button className="project selected"><Icon name="folder" />Project A</button></section>
    <section className="session-section"><div className="section-heading"><span><Icon name="chat" />会话</span><button className="new-session" onClick={onNew}><Icon name="plus" size={16} />新会话</button></div>
      <nav>{sessions.map((session) => <button key={session.id} className={`session-row ${selected === session.id ? "selected" : ""}`} onClick={() => onSelect(session.id)}><Icon name="chat" /><span>{session.title}</span><small>{session.time}</small></button>)}</nav>
    </section>
  </aside>;
}

function AssistantDemo({ running }) {
  return <article className="assistant-message"><div className="agent-mark">Y</div><div><p>我已经开始检查 Project A 项目，并分析了项目结构、依赖和关键代码文件。</p><p>整体来看，项目结构清晰，主要是一个基于 Next.js 的 Web 应用，包含登录、用户管理和模型相关功能。登录状态的问题可能与会话管理和 Cookie 配置有关。</p><h2>下一步建议：</h2><ol><li>重点检查登录相关的中间件和会话处理逻辑。</li><li>确认环境变量和 Cookie 配置是否正确。</li><li>复现并定位登录状态丢失的具体场景。</li></ol><p>我会继续深入分析相关代码，并给出更具体的修改建议。</p><div className="streaming"><span />{running ? "正在分析项目文件…" : "分析已暂停"}</div></div></article>;
}

function Conversation({ title, messages, running, onSend, onStop }) {
  const [draft, setDraft] = useState("");
  const submit = () => { if (draft.trim()) { onSend(draft.trim()); setDraft(""); } };
  return <main className="conversation">
    <header className="conversation-header"><h1>{title}</h1><div><select aria-label="模型"><option>gpt-5.6-sol</option></select><button className="icon-button" aria-label="切换轨迹面板"><Icon name="panel" /></button></div></header>
    <div className="messages">
      {messages.length === 0 ? <div className="empty-conversation"><strong>开始一个新会话</strong><span>发送任务后，Agent 的回复和执行轨迹会显示在这里。</span></div> : messages.map((message) => message.role === "user"
        ? <div className="user-message" key={message.id}>{message.text}</div>
        : <AssistantDemo key={message.id} running={running} />)}
    </div>
    <div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="给 Agent 发送消息…" /><div className="composer-actions"><span>Enter 发送 · Shift+Enter 换行</span><div>{running && <button className="stop" onClick={onStop}><Icon name="stop" size={16} />停止</button>}<button className="send" onClick={submit}><Icon name="send" size={17} />发送</button></div></div></div>
  </main>;
}

function Inspector() {
  const [tab, setTab] = useState("轨迹");
  return <aside className="inspector"><div className="tabs">{["轨迹", "上下文", "计划"].map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === "轨迹" ? <div className="trace">{trace.map((step) => <div className={`trace-step ${step.state}`} key={step.title}><div className="trace-icon">{step.state === "done" ? <Icon name="check" size={16} /> : null}</div><div><div className="trace-title">{step.title}<time>10:24</time></div><p>{step.detail}</p><ul>{step.items.map((item) => <li key={item}>{item}<Icon name="chevron" size={13} /></li>)}</ul></div></div>)}</div> : <div className="empty-panel"><h2>{tab}</h2><p>{tab === "上下文" ? "当前会话只使用 Project A 的受限工作区。" : "Agent 的当前步骤和待办将在这里展示。"}</p></div>}
  </aside>;
}

export function App() {
  const [sessions, setSessions] = useState(initialSessions);
  const [selected, setSelected] = useState(initialSessions[0].id);
  const [messagesBySession, setMessagesBySession] = useState(initialMessages);
  const [running, setRunning] = useState(true);
  const selectedSession = sessions.find((item) => item.id === selected);
  const selectedMessages = messagesBySession[selected] ?? [];
  const createSession = () => { const session = { id: `ses_local_${Date.now()}`, title: "新会话", time: "刚刚" }; setSessions((current) => [session, ...current]); setMessagesBySession((current) => ({ ...current, [session.id]: [] })); setSelected(session.id); setRunning(false); };
  const send = async (text) => {
    const localSessionID = selected;
    const title = text.slice(0, 28);
    const userMessage = { id: `msg_local_${Date.now()}`, role: "user", text };
    setSessions((current) => current.map((item) => item.id === localSessionID ? { ...item, title, time: "刚刚" } : item));
    setMessagesBySession((current) => ({ ...current, [localSessionID]: [...(current[localSessionID] ?? []), userMessage] }));
    setRunning(true);
    try {
      const session = localSessionID.startsWith("ses_local")
        ? await agentApi.createSession(title)
        : selectedSession;
      if (!session) return;
      if (session.id !== localSessionID) {
        setSessions((current) => current.map((item) => item.id === localSessionID ? { ...session, title, time: "刚刚" } : item));
        setMessagesBySession((current) => {
          const next = { ...current, [session.id]: current[localSessionID] ?? [userMessage] };
          delete next[localSessionID];
          return next;
        });
        setSelected(session.id);
      }
      await agentApi.prompt(session.id, text);
    } catch {
      setRunning(false);
    }
  };
  const stop = async () => { setRunning(false); if (selected && !selected.startsWith("ses_local")) { try { await agentApi.abort(selected); } catch { /* Keep the local stop state deterministic. */ } } };
  return <div className="app-shell"><header className="topbar"><button className="icon-button" aria-label="打开导航"><Icon name="menu" /></button><strong>YEUTECH</strong><span className="divider" /><b>AI 工作台</b><span className="avatar">U</span></header><Sidebar sessions={sessions} selected={selected} onSelect={setSelected} onNew={createSession} /><Conversation title={selectedSession?.title ?? "新会话"} messages={selectedMessages} running={running} onSend={send} onStop={stop} /><Inspector /><footer><span className="online" />OpenCode · 已连接<span className="footer-divider" /><Icon name="folder" size={15} />Project A</footer></div>;
}
