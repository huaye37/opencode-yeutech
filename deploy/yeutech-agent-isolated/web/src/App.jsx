import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentApi, migrationApi, workbenchApi } from "./api.js";
import { removeDeletedAttachmentReferences, removeDeletedUploadStatuses } from "./attachment-state.js";
import { Icon } from "./icons.jsx";
import { syncPortalAppearance } from "./portal-appearance.js";
import { sortSessionsByUpdatedAt } from "./session-ordering.js";

const SELECTED_STORAGE_KEY = "yeutech-agent-workbench:selected:v2";
const SIDEBAR_WIDTH_STORAGE_KEY = "yeutech-agent-workbench:sidebar-width:v1";
const FILE_PANEL_WIDTH_STORAGE_KEY = "yeutech-agent-workbench:file-panel-width:v1";
const STANDALONE_EXPANDED_STORAGE_KEY = "yeutech-agent-workbench:standalone-expanded:v1";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const FILE_PANEL_MIN_WIDTH = 360;

class SurfaceBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous) { if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="surface-error" role="alert"><Icon name="warning" /><b>{this.props.label}暂时无法显示</b><p>其他区域仍可继续使用。</p><button onClick={() => this.setState({ failed: false })}>重试此区域</button></section>;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function storedWidth(key, fallback, min, max) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? clamp(value, min, max) : fallback;
  } catch { return fallback; }
}

function storeWidth(key, value) {
  try { window.localStorage.setItem(key, String(Math.round(value))); }
  catch { /* Panel width persistence is optional. */ }
}

function storedBoolean(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch { return fallback; }
}

function isImmediateProjectionEvent(payload) {
  const type = String(payload?.type || "");
  const state = payload?.properties?.status?.type || payload?.properties?.status || payload?.properties?.state?.type;
  return type === "session.idle" || type === "session.completed" || type === "session.error"
    || (type === "session.status" && new Set(["idle", "completed", "error"]).has(state))
    || (type === "message.updated" && Boolean(payload?.properties?.info?.time?.completed));
}

function isSettledSessionEvent(payload) {
  const type = String(payload?.type || "");
  const state = payload?.properties?.status?.type || payload?.properties?.status || payload?.properties?.state?.type;
  return type === "session.idle" || type === "session.completed" || type === "session.error"
    || (type === "session.status" && new Set(["idle", "completed", "error"]).has(state));
}

function isHistoricalConversation(id) {
  return String(id || "").startsWith("portal:") || String(id || "").startsWith("imported:");
}

function storedSelectionContext() {
  try {
    const value = window.localStorage.getItem(SELECTED_STORAGE_KEY) || "";
    if (!value) return { scope: "", projectId: "", sessionId: "" };
    if (!value.startsWith("{")) return { scope: "session", projectId: "", sessionId: value };
    const parsed = JSON.parse(value);
    return {
      scope: parsed?.scope === "project" ? "project" : "session",
      projectId: String(parsed?.projectId || ""),
      sessionId: String(parsed?.sessionId || ""),
    };
  } catch { return { scope: "", projectId: "", sessionId: "" }; }
}

function storedSelection() {
  return storedSelectionContext().sessionId;
}

function storeSelection(value) {
  try { window.localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify(value)); }
  catch { /* Selection persistence is optional. */ }
}

function isDirectAttachment(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return normalized.startsWith("附件/") && !normalized.slice("附件/".length).includes("/");
}

function attachmentIdentity(item) {
  return `${item?.ownerSessionID || ""}:${item?.workspacePath || `${fileSpaceKey(item?.space)}:${item?.path || ""}`}`;
}

function attachmentFileIdentity(item) {
  return item?.workspacePath || `${fileSpaceKey(item?.space)}:${item?.path || ""}`;
}

function sessionFileScope(session) {
  return session?.fileScope || session?.id;
}

function fileSpaceFor(session, project) {
  return project
    ? { project: project.workspaceDirectory || project.name, label: project.name }
    : { session: sessionFileScope(session), label: "独立会话文件" };
}

function fileSpaceKey(space) {
  return space?.session ? "standalone" : `project:${space?.project || ""}`;
}

function workspacePathFor(space, filePath) {
  return space?.project ? `${space.project}/${filePath}` : `独立会话/${filePath}`;
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
  return <div className="file-reference" title="来自当前授权项目的文件"><Icon name="folder" /><span><strong>{fileName}</strong><small>{path}</small></span><em>项目文件</em></div>;
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

function RowMenu({ label, children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.key === "Escape" || (event.type === "pointerdown" && !root.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [open]);
  return <div className="row-menu" ref={root}><button className="row-menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}><Icon name="more" size={16} /></button>{open ? <div className="row-menu-popover" role="menu" onClick={() => setOpen(false)}>{children}</div> : null}</div>;
}

function SessionRow({ session, selected, running, runtimeAvailable, reasoningLabel, onSelect, onRename, onDelete, onFork }) {
  return <div className={`session-row ${selected ? "selected" : ""}`}>
    <button className="session-row-main" onClick={onSelect}><span>{running ? <span className="session-running" aria-label="正在运行" /> : <Icon name="chatPlus" />}<b>{session.title}</b><time>{formatTime(session.updatedAt)}</time></span><small>{reasoningLabel}</small></button>
    <RowMenu label={`管理会话 ${session.title}`}><button role="menuitem" disabled={!runtimeAvailable} title={runtimeAvailable ? "" : "先发送消息以建立运行时会话"} onClick={() => onRename(session)}><Icon name="edit" size={15} />重命名</button><button role="menuitem" disabled={!runtimeAvailable} title={runtimeAvailable ? "" : "历史会话尚未建立运行时映射"} onClick={() => onFork(session)}><Icon name="fork" size={15} />Fork 会话</button><button className="danger" role="menuitem" disabled={!runtimeAvailable} title={runtimeAvailable ? "" : "历史会话尚未建立运行时映射"} onClick={() => onDelete(session)}><Icon name="trash" size={15} />删除会话</button></RowMenu>
  </div>;
}

function Sidebar({ projects, conversations, standaloneSessions, selected, selectedProject, expandedProjects, runningSessionIds, runtimeSessions, modelCount, loading, onSelect, onSelectProject, onNew, onNewProject, onDiscoverProjects, onNewProjectSession, onOpenProjectFiles, onRenameProject, onDeleteProject, onRenameSession, onDeleteSession, onForkSession, onCapabilities, onControl, onCollapse }) {
  const [query, setQuery] = useState("");
  const [standaloneOpen, setStandaloneOpen] = useState(() => storedBoolean(STANDALONE_EXPANDED_STORAGE_KEY, true));
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (value) => !normalizedQuery || String(value || "").toLowerCase().includes(normalizedQuery);
  const matchingStandaloneSessions = useMemo(() => sortSessionsByUpdatedAt(standaloneSessions
    .filter((item) => matches(item.title))), [standaloneSessions, normalizedQuery]);
  const standaloneExpanded = Boolean(normalizedQuery) || standaloneOpen;
  const toggleStandalone = () => {
    const next = !standaloneOpen;
    setStandaloneOpen(next);
    try { window.localStorage.setItem(STANDALONE_EXPANDED_STORAGE_KEY, String(next)); }
    catch { /* Folder state persistence is optional. */ }
  };
  return <aside className="sidebar" id="project-sidebar"><div className="sidebar-actions">
    <div className="primary-action-row"><button className="primary-button" disabled={loading} onClick={onNew}><Icon name="chatPlus" />新建独立会话</button><button className="collapse-button" aria-label="收起项目栏" title="收起项目栏" onClick={onCollapse}><Icon name="panel" /></button></div>
    <div className="sidebar-action-grid"><button disabled={loading} onClick={onNewProject}><Icon name="plus" />新建项目</button><button disabled={loading} onClick={onDiscoverProjects}><Icon name="folderIn" />扫描 NAS 项目</button></div>
    <button className="sidebar-action console-entry" disabled={loading} onClick={onControl} aria-haspopup="dialog"><Icon name="shield" /><span className="sidebar-action-copy"><b>任务状态</b><small>当前目标、进度和最近操作</small></span><em>查看</em></button>
    <button className="sidebar-action" disabled={loading} onClick={onCapabilities} aria-haspopup="dialog"><Icon name="sparkles" />模型与技能<span>{loading ? "加载中" : modelCount} 模型</span></button>
    <label className="search"><Icon name="search" /><input disabled={loading} aria-label="搜索会话与项目" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? "正在同步项目与会话…" : "搜索全部会话与项目"} /></label>
  </div><div className="sidebar-list">
    {loading ? <div className="sidebar-loading" role="status"><span /><b>正在加载工作区</b><small>同步模型、会话和 NAS 项目…</small></div> : null}
    {!loading ? <>
    <section className={`standalone-group project-group ${standaloneExpanded ? "expanded" : ""}`}><div className="project-heading-row"><button className="project-heading" onClick={toggleStandalone} aria-expanded={standaloneExpanded}><Icon name={standaloneExpanded ? "chevronDown" : "chevron"} /><Icon name="folder" /><strong>独立会话</strong><small>{standaloneSessions.length} 个</small></button></div>{standaloneExpanded ? <nav>{matchingStandaloneSessions.length ? matchingStandaloneSessions.map((session) => <SessionRow key={session.id} session={session} selected={selected === session.id} running={runningSessionIds.has(session.id)} runtimeAvailable={Boolean(runtimeSessions[session.id] || (!isHistoricalConversation(session.id) && !session.id.startsWith("ses_local")))} onSelect={() => onSelect(session.id)} onRename={onRenameSession} onDelete={onDeleteSession} onFork={onForkSession} reasoningLabel={session.model ? `${session.model} · 推理高` : session.runtimeSessionId ? "历史会话 · 已接续" : "历史会话"} />) : <p className="project-empty">{normalizedQuery ? "没有匹配的独立会话。" : "还没有独立会话。"}</p>}</nav> : null}</section>
    <p className="eyebrow">项目</p>
    <div className="project-tree">{projects.filter((item) => item.registered !== false).map((project) => {
      const projectConversations = sortSessionsByUpdatedAt(conversations.filter((item) => item.projectId === project.id && (matches(item.title) || matches(project.name))));
      if (normalizedQuery && !matches(project.name) && projectConversations.length === 0) return null;
      const projectKey = project.id || project.workspaceDirectory;
      const expanded = expandedProjects.has(projectKey) || Boolean(normalizedQuery);
      return <section className={`project-group ${expanded ? "expanded" : ""} ${projectKey === selectedProject ? "active" : ""}`} key={projectKey}><div className="project-heading-row"><button className="project-heading" onClick={() => onSelectProject(projectKey)} aria-expanded={expanded}><Icon name={expanded ? "chevronDown" : "chevron"} /><Icon name="folder" /><strong>{project.name}</strong><small>{project.availableLocally ? "NAS 项目" : "历史项目"}</small></button><div className="project-heading-actions"><button aria-label={`在 ${project.name} 中新建会话`} title="新建项目会话" onClick={() => onNewProjectSession(project)}><Icon name="chatPlus" size={16} /></button><button aria-label={`浏览 ${project.name} 的项目文件`} title="浏览项目文件" onClick={() => onOpenProjectFiles(project)}><Icon name="folderIn" size={16} /></button><RowMenu label={`管理项目 ${project.name}`}><button role="menuitem" onClick={() => onRenameProject(project)}><Icon name="edit" size={15} />重命名</button><button className="danger" role="menuitem" onClick={() => onDeleteProject(project)}><Icon name="trash" size={15} />取消登记</button></RowMenu></div></div>{expanded ? <nav>{projectConversations.length ? projectConversations.map((session) => <SessionRow key={session.id} session={session} selected={selected === session.id} running={runningSessionIds.has(session.id)} runtimeAvailable={Boolean(runtimeSessions[session.id] || (!isHistoricalConversation(session.id) && !session.id.startsWith("ses_local")))} onSelect={() => onSelect(session.id)} onRename={onRenameSession} onDelete={onDeleteSession} onFork={onForkSession} reasoningLabel={session.model ? `${session.model} · 推理${session.reasoningEffort || "高"}` : session.runtimeSessionId ? "历史会话 · 已接续" : "历史会话"} />) : <p className="project-empty">还没有会话，可用项目名称旁的按钮新建。</p>}</nav> : null}</section>;
    })}{normalizedQuery && !projects.filter((item) => item.registered !== false).some((project) => matches(project.name) || conversations.some((item) => item.projectId === project.id && matches(item.title))) && !standaloneSessions.some((item) => matches(item.title)) ? <div className="search-empty"><p>没有匹配的会话或项目</p><button onClick={() => setQuery("")}>清除搜索</button></div> : null}</div></> : null}
  </div></aside>;
}

function ProjectDiscoveryDialog({ open, projects, busyProjectId, error, onClose, onRegister, onRescan }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭 NAS 项目发现" onClick={onClose} /><section className="capability-center discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="discovery-title"><header><div><span className="panel-kicker">NAS DISCOVERY</span><h2 id="discovery-title">发现 NAS 项目</h2><p>这里只列出尚未登记的目录；接入后才会出现在项目树中。</p></div><button className="panel-close" aria-label="关闭 NAS 项目发现" onClick={onClose}>×</button></header><div className="discovery-body">{error ? <div className="file-error">{error}</div> : null}{projects.length ? <div className="discovery-list">{projects.map((item) => <article key={item.id || item.workspaceDirectory || item.name}><Icon name="folderIn" /><span><b>{item.name}</b><small>{item.workspaceDirectory || "NAS 工作区目录"}</small></span><button disabled={Boolean(busyProjectId)} onClick={() => onRegister(item)}>{busyProjectId === (item.id || item.workspaceDirectory) ? "正在接入…" : "接入项目"}</button></article>)}</div> : <div className="discovery-empty"><Icon name="check" /><b>没有待接入的 NAS 目录</b><p>已登记项目不会重复显示。</p></div>}<div className="dialog-actions"><button onClick={onRescan}><Icon name="refresh" size={15} />重新扫描</button><button className="console-primary" onClick={onClose}>完成</button></div></div></section></div>;
}

function PanelResizer({ className, label, controls, value, min, max, keyboardDirection = 1, onPointerDown, onChange }) {
  const onKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onChange(clamp(value + (event.key === "ArrowRight" ? 16 : -16) * keyboardDirection, min, max));
  };
  return <div className={`panel-resizer ${className}`} role="separator" tabIndex="0" aria-label={label} aria-controls={controls} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} onPointerDown={onPointerDown} onKeyDown={onKeyDown}><span /></div>;
}

function ProjectDialog({ open, busy, error, onClose, onCreate }) {
  const [name, setName] = useState("");
  useEffect(() => { if (!open) { setName(""); } }, [open]);
  if (!open) return null;
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭新建项目" onClick={onClose} /><section className="capability-center project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"><header><div><span className="panel-kicker">NAS PROJECT</span><h2 id="project-dialog-title">新建项目</h2><p>项目会创建在你自己的 NAS 工作区，并自动建立独立项目标识。</p></div><button className="panel-close" aria-label="关闭新建项目" onClick={onClose}>×</button></header><div className="project-dialog-body"><label>项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) void onCreate(name.trim()); }} placeholder="例如：家庭网络优化" /></label>{error ? <div className="file-error">{error}</div> : null}<div className="dialog-actions"><button onClick={onClose}>取消</button><button className="console-primary" disabled={busy || !name.trim()} onClick={() => void onCreate(name.trim())}>{busy ? "正在创建…" : "创建并进入"}</button></div></div></section></div>;
}

function Activity({ running, status }) {
  if (!running && !status) return null;
  return <div className="activity"><span className={running ? "activity-spinner" : "activity-check"}>{running ? null : <Icon name="check" size={14} />}</span><div><strong>{running ? "Agent 正在执行" : "状态已更新"}</strong><p>{status}</p></div></div>;
}

function PermissionCard({ request, onReply }) {
  const detail = request.patterns?.join("\n") || "Agent 请求执行受保护的操作";
  return <section className="permission-card" aria-label="待审批操作"><div><span className="permission-badge">需要确认</span><strong>{request.permission === "bash" ? "运行命令" : `使用 ${request.permission} 工具`}</strong><pre>{detail}</pre><small>仅限当前用户的项目工作区；工作区外访问始终禁止。</small></div><div className="permission-actions"><button className="permission-reject" onClick={() => onReply(request.id, "reject")}>拒绝</button><button className="permission-allow" onClick={() => onReply(request.id, "once")}>仅本次允许</button></div></section>;
}

function CapabilityCenter({ open, loading, error, profiles, skills, skillReport, models, onClose, onRetry }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  if (!open) return null;
  const selectable = models.filter((item) => item.selectable).length;
  const profileDescription = { "general-agent": "日常问答、分析和多步骤任务", "agent-code": "需要项目文件、代码修改和验证的开发任务", "novel-writing": "需要长上下文和连续性控制的创作任务", "kaoyan-system": "需要可信来源和答案隔离的学习任务" };
  const evidenceName = { generation: "生成记录", result: "结果记录", diff: "代码变更", test: "测试结果", candidate: "候选稿", "context-pack": "来源校验", source: "可信来源", "answer-separation": "答案隔离" };
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭能力中心" onClick={onClose} /><section className="capability-center" role="dialog" aria-modal="true" aria-labelledby="capability-title">
    <header><div><span className="panel-kicker">AGENT CAPABILITIES</span><h2 id="capability-title">模型与技能</h2><p>这里展示当前真正可用的模型、任务策略和 Worker 已加载技能；只读项目不会伪装成可配置插件。</p></div><button className="panel-close" aria-label="关闭模型与技能" onClick={onClose}>×</button></header>
    <div className="capability-summary"><span><strong>{selectable}</strong> 可用模型</span><span><strong>{profiles.length}</strong> 工作负载</span><span><strong>{skillReport.reported ? skills.length : "—"}</strong> Skills</span></div>
    {loading ? <div className="panel-state"><span className="activity-spinner" />正在读取 Worker 能力…</div> : error ? <div className="panel-state error"><p>{error}</p><button onClick={onRetry}>重试</button></div> : <div className="capability-content">
      <section className="capability-section"><div className="section-heading"><h3>任务类型</h3><span>选择模型时使用的能力要求</span></div><div className="profile-grid">{profiles.map((profile) => <article key={profile.id}><div className="profile-icon"><Icon name="shield" /></div><div><strong>{profile.name}</strong><p>{profileDescription[profile.id] || "由当前任务定义能力要求"}</p><small>自动检查：{profile.evidence?.map((item) => evidenceName[item] || item).join(" / ") || "按任务判断"}</small><details><summary>技术详情</summary><code>{profile.id}</code><small>{profile.policy?.context || "balanced"} · {profile.policy?.failover || "before-dispatch-only"}</small></details></div></article>)}</div></section>
      <section className="capability-section"><div className="section-heading"><h3>Worker 报告的扩展能力</h3><span>只读清单，不代表本会话已调用</span></div>{skills.length ? <div className="skill-list">{skills.map((skill) => <article key={`${skill.source}:${skill.name}`}><span className={`skill-status ${skill.available ? "available" : ""}`} /><div><strong>{skill.name}</strong><p>{skill.description || "暂无说明"}</p><small>{skill.source || "OpenCode worker"}</small></div><em>{skill.available ? "已报告" : "不可用"}</em></article>)}</div> : <div className="panel-state compact">{!skillReport.reported && !skillReport.workerActive ? "Worker 当前休眠，发送任务时才会启动；Skills 将在启动后读取。" : !skillReport.reported ? "Worker 已启动，但当前版本未报告 Skills 清单。" : "当前 Worker 已报告：没有额外 Skills。"}</div>}</section>
    </div>}
  </section></div>;
}

function ChildTree({ nodes = [], root = true }) {
  if (!nodes.length) return root ? <p className="honest-empty">本会话未报告 Worker 子会话。</p> : null;
  return <ul className="control-tree">{nodes.map((node) => <li key={node.id}><span><b>{node.title}</b><em>{node.status}</em></span><ChildTree nodes={node.children} root={false} /></li>)}</ul>;
}

function ControlCenter({ open, onClose, project, session, runtimeSessionId, insight, attachments, hasRuntime, model }) {
  const [control, setControl] = useState(null);
  const [goals, setGoals] = useState([]);
  const [objective, setObjective] = useState("");
  const [baseline, setBaseline] = useState(null);
  const [replay, setReplay] = useState(null);
  const [contextPack, setContextPack] = useState(null);
  const [toolResult, setToolResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const scope = project?.id || session?.id || "workspace";
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(""); setControl(null); setGoals([]); setBaseline(null); setReplay(null); setContextPack(null); setToolResult(null);
    setLoading(true);
    Promise.allSettled([workbenchApi.control("general-agent"), workbenchApi.goals(scope)]).then(([nextControl, nextGoals]) => {
      if (!current) return;
      if (nextControl.status === "fulfilled") setControl(nextControl.value);
      if (nextGoals.status === "fulfilled") setGoals(nextGoals.value.data || []);
      const failures = [nextControl, nextGoals].filter((item) => item.status === "rejected").map((item) => item.reason?.message || "读取失败");
      if (failures.length) setError(failures.join("；"));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, scope]);
  if (!open) return null;
  const createGoal = async () => {
    if (!objective.trim()) return;
    try {
      const result = await workbenchApi.createGoal({ scopeKey: scope, objective: objective.trim(), phase: "delivery", status: "active" });
      setGoals((current) => [result.data, ...current]); setObjective("");
    } catch (cause) { setError(cause.message); }
  };
  const updateGoal = async (goal, status) => {
    try {
      const result = await workbenchApi.updateGoal(goal.id, { revision: goal.revision, status });
      setGoals((current) => current.map((item) => item.id === goal.id ? result.data : item));
    } catch (cause) { setError(cause.message); }
  };
  const makePack = async () => {
    if (!project || attachments.length === 0) return;
    try {
      const result = await workbenchApi.createContextPack({ project: project.workspaceDirectory || project.name, paths: attachments.map((item) => item.path) });
      setContextPack(result.data);
    } catch (cause) { setError(cause.message); }
  };
  const compare = async () => {
    if (!hasRuntime || !insight?.stats) return;
    const metrics = { toolSuccess: (insight?.trajectory || []).filter((item) => item.type === "tool" && item.status === "completed").length };
    if (Number.isFinite(insight?.stats?.durationMs)) metrics.durationMs = insight.stats.durationMs;
    if (Number.isFinite(insight?.stats?.tokens?.input) && Number.isFinite(insight?.stats?.tokens?.output)) metrics.tokens = insight.stats.tokens.input + insight.stats.tokens.output;
    const candidate = { id: session?.id || "current", metrics };
    if (!baseline) { setBaseline(candidate); return; }
    try { setReplay((await workbenchApi.compareReplay(baseline, candidate)).data); } catch (cause) { setError(cause.message); }
  };
  const executeReplay = async () => {
    if (!hasRuntime || !runtimeSessionId || !model) return;
    try {
      let run = (await workbenchApi.executeReplay(runtimeSessionId, model)).data;
      setReplay(run);
      for (let attempt = 0; attempt < 60 && new Set(["queued", "running"]).has(run.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        run = (await workbenchApi.replay(run.id)).data;
        setReplay(run);
      }
    } catch (cause) { setError(cause.message); }
  };
  const budget = control?.runtimeBudget;
  const stats = insight?.stats || {};
  const evidence = insight?.evidence;
  const tokenSummary = Number.isFinite(stats.tokens?.input) && Number.isFinite(stats.tokens?.output) ? `输入 ${stats.tokens.input} / 输出 ${stats.tokens.output}` : "Token 未由 Worker 报告";
  const evidenceComplete = Boolean(evidence?.checks?.length) && evidence.checks.every((check) => check.passed);
  const evidenceLabel = evidenceComplete ? "所需证据记录已齐，未做用户验收" : evidence?.state === "generation-settled" ? "已检测到生成记录，外部结果未验证" : hasRuntime ? "等待生成记录" : "尚未建立运行记录";
  const latestActivities = (insight?.trajectory || []).slice(-5).reverse();
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭任务状态" onClick={onClose} /><section className="capability-center control-center" role="dialog" aria-modal="true" aria-labelledby="control-title">
    <header><div><h2 id="control-title">任务状态</h2><p>看当前在做什么、进行到哪里，以及最近做了什么。</p></div><button className="panel-close" aria-label="关闭任务状态" onClick={onClose}>×</button></header>
    <div className="control-status-strip"><span className={hasRuntime ? "ready" : "waiting"}><b>{hasRuntime ? "已连接当前会话" : "还没有开始运行"}</b><small>{hasRuntime ? "状态会自动更新" : "发送一条消息后即可看到进度"}</small></span><span><b>{goals.filter((item) => item.status !== "complete").length} 个进行中目标</b><small>{goals.length ? "可在下方查看和更新" : "可以记下这次要完成的事"}</small></span><span><b>{latestActivities.length} 条最近操作</b><small>{hasRuntime ? `${stats.turns || 0} 轮对话` : "开始后显示"}</small></span></div>
    {error ? <div className="file-error">{error}</div> : null}{loading ? <div className="panel-state"><span className="activity-spinner" />正在读取控制台状态…</div> : <div className="control-grid">
      <section className="control-wide"><div className="control-section-heading"><span>当前目标</span><em>{goals.length ? `${goals.length} 条` : "未设置"}</em></div><div className="goal-create"><input value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="记下这次要完成的事" /><button disabled={!objective.trim()} onClick={() => void createGoal()}>添加</button></div>{goals.length ? goals.map((goal) => <article className="goal-row" key={goal.id}><div><b>{goal.objective}</b><small>{goal.status === "complete" ? "已完成" : "进行中"}</small></div><button onClick={() => void updateGoal(goal, goal.status === "complete" ? "active" : "complete")}>{goal.status === "complete" ? "重新开始" : "完成"}</button></article>) : <p className="honest-empty">暂无目标。如果只是一次简单对话，可以不填。</p>}</section>
      <section className="control-wide"><div className="control-section-heading"><span>最近操作</span><em>{latestActivities.length ? `最近 ${latestActivities.length} 条` : "暂无"}</em></div>{latestActivities.length ? <div className="trajectory-list simple">{latestActivities.map((item) => <article key={`${item.id}:${item.ordinal}`}><span>{item.ordinal}</span><div><b>{activityTitle(item).replace("工具 · ", "执行：").replace("子任务 · ", "分项任务：")}</b><small>{item.status === "completed" ? "已完成" : item.status === "running" ? "进行中" : item.status || "已记录"}</small></div></article>)}</div> : <p className="honest-empty">发送消息后，这里会显示最近的读取、修改和检查操作。</p>}</section>
      <details className="control-advanced control-wide"><summary>高级信息 <span>面向排障与性能分析</span></summary><div className="advanced-grid"><section><b>运行容量</b><p>{budget ? `${budget.requestedInteractiveWorkers} / ${budget.maxInteractiveWorkers} 个执行位` : "暂无数据"}</p></section><section><b>上下文</b><p>{hasRuntime ? `${insight?.context?.messageCount || 0} 条消息 · ${tokenSummary}` : "暂无运行数据"}</p></section><section><b>交付记录</b><p>{evidenceLabel}</p></section><section><b>项目文件校验</b><p>{attachments.length ? `已附加 ${attachments.length} 个文件` : insight?.executionContextReceipt ? `本轮已应用 ${insight.executionContextReceipt.sources?.length || 0} 个来源` : "未附加文件"}</p><button disabled={!project || !attachments.length} onClick={() => void makePack()}>校验当前文件</button>{contextPack ? <code className="hash-code">{contextPack.hash}</code> : null}</section><section><b>回放实验室</b><p>{replay?.status ? `隔离回放：${replay.status}` : replay?.metrics ? Object.entries(replay.metrics).map(([key, value]) => `${key}: ${value.delta}`).join("；") : "在隔离目录真实重放最近一轮"}</p><button disabled={!hasRuntime || !model || new Set(["queued", "running"]).has(replay?.status)} onClick={() => void executeReplay()}>执行安全回放</button></section><section><b>分项任务</b><ChildTree nodes={insight?.childTree || []} /></section></div></details>
    </div>}
  </section></div>;
}

function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

function uploadStatusLabel(item) {
  if (item.status === "queued") return "等待上传";
  if (item.status === "uploading") return `${Math.round((item.loaded || 0) / Math.max(1, item.total || item.size || 1) * 100)}% · ${formatFileSize(item.loaded || 0)} / ${formatFileSize(item.total || item.size || 0)}`;
  if (item.status === "saving") return "100% · 正在保存到 NAS";
  if (item.status === "done") return "已保存";
  return item.error || "上传失败";
}

function UploadQueue({ items, onCancel, onRetry }) {
  if (!items.length) return null;
  return <div className="upload-queue" aria-live="polite">{items.map((item) => <article className={item.status} key={item.id}><div><b title={item.name}>{item.name}</b><em>{uploadStatusLabel(item)}</em></div><progress max={Math.max(1, item.total || item.size || 1)} value={item.status === "done" || item.status === "saving" ? Math.max(1, item.total || item.size || 1) : item.loaded || 0} />{item.status === "error" ? <button onClick={() => onRetry(item.id)}>重试</button> : <button onClick={() => onCancel(item.id)}>{item.status === "done" ? "移除" : "取消"}</button>}</article>)}</div>;
}

function assertSafeOoxmlArchive(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("文档压缩包结构无效。");
  const entryCount = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  let expandedBytes = 0;
  if (entryCount > 5_000) throw new Error("文档内部文件过多，暂不在线预览。");
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("文档压缩包目录无效。");
    if (view.getUint16(offset + 8, true) & 1) throw new Error("加密文档暂不在线预览。");
    expandedBytes += view.getUint32(offset + 24, true);
    if (expandedBytes > 64 * 1024 * 1024) throw new Error("文档解压后过大，暂不在线预览。");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

async function parseSpreadsheet(buffer) {
  const { unzipSync, strFromU8 } = await import("fflate");
  assertSafeOoxmlArchive(buffer);
  const archive = unzipSync(new Uint8Array(buffer), { filter: (entry) => entry.name === "xl/sharedStrings.xml" || entry.name === "xl/worksheets/sheet1.xml" });
  const xml = (name) => archive[name] ? new DOMParser().parseFromString(strFromU8(archive[name]), "application/xml") : null;
  const shared = [...(xml("xl/sharedStrings.xml")?.getElementsByTagName("si") || [])].map((item) => [...item.getElementsByTagName("t")].map((node) => node.textContent || "").join(""));
  const sheet = xml("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("这个工作簿中没有可读取的表格。");
  const rows = [...sheet.getElementsByTagName("row")].slice(0, 200).map((row) => {
    const values = [];
    [...row.getElementsByTagName("c")].slice(0, 50).forEach((cell) => {
      const reference = cell.getAttribute("r") || "A1";
      const letters = reference.match(/[A-Z]+/)?.[0] || "A";
      const column = [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      const type = cell.getAttribute("t");
      const raw = cell.getElementsByTagName("v")[0]?.textContent ?? cell.getElementsByTagName("t")[0]?.textContent ?? "";
      values[column] = type === "s" ? shared[Number(raw)] ?? raw : type === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw;
    });
    return values.slice(0, 50);
  });
  return { rows, truncated: sheet.getElementsByTagName("row").length > 200 || rows.some((row) => row.length >= 50) };
}

function FilePreviewContent({ preview }) {
  if (preview.kind === "markdown") return <div className="document-preview markdown-document"><MarkdownText text={preview.text} /></div>;
  if (preview.kind === "html") return <iframe className="html-preview" sandbox="" srcDoc={preview.text} title={`${preview.name} HTML 预览`} />;
  if (preview.kind === "text") return <pre>{preview.text}</pre>;
  if (preview.kind === "image") return <img src={preview.url} alt={preview.name} />;
  if (preview.kind === "pdf") return <iframe src={preview.url} title={preview.name} />;
  if (preview.kind === "docx") return <div className="document-preview"><MarkdownText text={preview.text || "文档中没有可提取的文字。"} /></div>;
  if (preview.kind === "xlsx") return <div className="spreadsheet-preview">{preview.truncated ? <p>表格较大，这里显示前 200 行、50 列。</p> : null}<table><tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, columnIndex) => <td key={columnIndex}>{value}</td>)}</tr>)}</tbody></table></div>;
  return <div className="preview-unsupported"><Icon name="paperclip" size={28} /><b>{preview.preview?.eligible === false && preview.preview?.maxBytes > 0 ? "文件太大，暂不在线预览" : "当前格式暂不在线预览"}</b><p>{preview.mimeType || preview.type || "未知格式"} · {formatFileSize(preview.size)}<br />仍可下载原文件，或把文件引用交给 Agent 按需读取。</p></div>;
}

function FilePanel({ session, project, open, canAttach = true, onClose, onAttach, onDeleted }) {
  const [directory, setDirectory] = useState("");
  const [listing, setListing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);
  const uploadControllers = useRef(new Map());
  const cancelledUploads = useRef(new Set());
  const viewGeneration = useRef(0);
  const listRequest = useRef(0);
  const previewRequest = useRef(0);
  const defaultSpace = fileSpaceFor(session, project);
  const activeSpace = defaultSpace;
  const activeSpaceKey = fileSpaceKey(activeSpace);
  const load = async (nextDirectory = directory, space = activeSpace) => {
    if (!space?.project && !space?.session) return;
    const requestID = ++listRequest.current;
    previewRequest.current += 1;
    setPreview(null);
    setLoading(true); setError("");
    try {
      const nextListing = await workbenchApi.files(space, nextDirectory, showHidden);
      if (requestID !== listRequest.current) return;
      setListing(nextListing); setDirectory(nextDirectory);
    }
    catch (cause) { if (requestID === listRequest.current) setError(cause instanceof Error ? cause.message : "文件暂时无法读取。"); }
    finally { if (requestID === listRequest.current) setLoading(false); }
  };
  useEffect(() => {
    const next = fileSpaceFor(session, project);
    viewGeneration.current += 1;
    listRequest.current += 1;
    previewRequest.current += 1;
    uploadControllers.current.forEach((controller) => controller.abort()); uploadControllers.current.clear();
    cancelledUploads.current.clear();
    setUploads([]); setListing(null); setPreview(null); setDirectory("");
  }, [project?.id, session?.id]);
  useEffect(() => {
    if (!open || (!project && !session)) return;
    const next = fileSpaceFor(session, project);
    void load("", next);
  }, [open, project?.id, session?.id]);
  useEffect(() => () => { viewGeneration.current += 1; uploadControllers.current.forEach((controller) => controller.abort()); uploadControllers.current.clear(); }, []);
  useEffect(() => { if (open && session) void load(directory, activeSpace); }, [showHidden]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);
  const segments = directory.split("/").filter(Boolean);
  const openFile = async (entry) => {
    const requestID = ++previewRequest.current;
    let objectURL = "";
    setLoading(true); setError("");
    try {
      if (entry.preview?.eligible === false) { setPreview({ ...entry, kind: "unsupported" }); return; }
      const result = await workbenchApi.file(activeSpace, entry.path, showHidden);
      if (requestID !== previewRequest.current) return;
      objectURL = URL.createObjectURL(result.blob);
      const extension = entry.name.split(".").pop()?.toLowerCase();
      let kind = result.previewKind || "unsupported"; let text = ""; let rows = []; let truncated = false;
      if (kind === "markdown" || extension === "md" || extension === "markdown") { kind = "markdown"; text = (await result.blob.text()).slice(0, 200_000); }
      else if (new Set(["text", "json", "html-source", "svg-source"]).has(kind) || /^(text\/|application\/(json|xml))/.test(result.type)) {
        kind = "text"; text = (await result.blob.text()).slice(0, 200_000);
        if (result.originalType === "application/json") try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Show malformed JSON as source. */ }
      } else if (kind === "image" || result.type.startsWith("image/")) kind = "image";
      else if (kind === "pdf" || result.type === "application/pdf") kind = "pdf";
      else if (kind === "docx" || extension === "docx") { kind = "docx"; const buffer = await result.blob.arrayBuffer(); assertSafeOoxmlArchive(buffer); const mammoth = await import("mammoth/mammoth.browser"); text = (await mammoth.extractRawText({ arrayBuffer: buffer })).value.slice(0, 300_000); }
      else if (kind === "xlsx" || extension === "xlsx") { kind = "xlsx"; ({ rows, truncated } = await parseSpreadsheet(await result.blob.arrayBuffer())); }
      if (requestID === previewRequest.current) {
        setPreview({ ...entry, ...result, url: objectURL, text, rows, truncated, kind });
        objectURL = "";
      }
    } catch (cause) {
      if (requestID !== previewRequest.current) return;
      if (cause?.code === "request_rejected" || /too large|unsupported|413/i.test(cause?.message || "")) setPreview({ ...entry, kind: "unsupported" });
      else setError(cause instanceof Error ? cause.message : "文件预览失败。");
    }
    finally {
      if (objectURL) URL.revokeObjectURL(objectURL);
      if (requestID === previewRequest.current) setLoading(false);
    }
  };
  const upload = (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    const generation = viewGeneration.current;
    const batch = files.map((file) => ({ id: crypto.randomUUID(), file, name: file.name, size: file.size, total: file.size, loaded: 0, status: "queued", generation, directory, space: activeSpace, spaceKey: activeSpaceKey }));
    setUploads((current) => [...current, ...batch]); setError("");
  };
  useEffect(() => {
    if (!open) return;
    const active = uploads.filter((item) => item.status === "uploading" || item.status === "saving").length;
    uploads.filter((item) => item.status === "queued").slice(0, Math.max(0, 3 - active)).forEach((job) => {
      if (cancelledUploads.current.has(job.id)) return;
      const controller = new AbortController(); uploadControllers.current.set(job.id, controller);
      setUploads((current) => current.map((item) => item.id === job.id ? { ...item, status: "uploading", controller } : item));
      const progress = (loaded, total) => {
        if (controller.signal.aborted || cancelledUploads.current.has(job.id)) return;
        setUploads((current) => current.map((item) => item.id === job.id ? { ...item, loaded, total, status: loaded >= total ? "saving" : "uploading" } : item));
      };
      const action = job.space?.project
        ? workbenchApi.uploadProjectFile(job.space, job.directory, job.file, { signal: controller.signal, onProgress: progress })
        : workbenchApi.uploadAttachment(job.space, job.file, { signal: controller.signal, onProgress: progress });
      action.then((saved) => {
        uploadControllers.current.delete(job.id);
        if (job.generation !== viewGeneration.current || controller.signal.aborted || cancelledUploads.current.has(job.id)) return;
        setUploads((current) => current.map((item) => item.id === job.id ? { ...item, ...saved, status: "done", loaded: item.total || item.size } : item));
        if (job.spaceKey === activeSpaceKey && job.directory === directory) void load(job.directory, job.space);
      }).catch((cause) => {
        uploadControllers.current.delete(job.id);
        if (job.generation !== viewGeneration.current || cancelledUploads.current.has(job.id)) return;
        if (cause?.name === "AbortError") setUploads((current) => current.filter((item) => item.id !== job.id));
        else setUploads((current) => current.map((item) => item.id === job.id ? { ...item, status: "error", error: cause instanceof Error ? cause.message : "文件上传失败。" } : item));
      });
    });
  }, [uploads, open, activeSpaceKey, directory]);
  const cancelUpload = (id) => { cancelledUploads.current.add(id); uploadControllers.current.get(id)?.abort(); setUploads((current) => current.filter((item) => item.id !== id)); };
  const retryUpload = (id) => {
    cancelledUploads.current.delete(id);
    setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "queued", error: "", loaded: 0, generation: viewGeneration.current } : item));
  };
  const attachPreview = () => onAttach({ name: preview.name, path: preview.path, type: preview.originalType || preview.mimeType || preview.type, size: preview.blob?.size ?? preview.size, space: activeSpace, workspacePath: `${listing?.workspacePrefix || activeSpace.project || "独立会话"}/${preview.path}`, uploaded: false });
  const deleteEntry = async (entry) => {
    if (!window.confirm(`删除 NAS 文件“${entry.name}”？历史消息中对它的引用可能失效。`)) return;
    setLoading(true); setError("");
    try {
      await workbenchApi.deleteAttachment(activeSpace, entry.path);
      onDeleted({ path: entry.path, workspacePath: workspacePathFor(activeSpace, entry.path), space: activeSpace });
      setUploads((current) => removeDeletedUploadStatuses(current, entry.path));
      if (preview?.path === entry.path) setPreview(null);
      await load(directory, activeSpace);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除上传文件失败。"); }
    finally { setLoading(false); }
  };
  if (!open || (!project && !session)) return null;
  return <div className={`capability-layer file-layer ${expanded ? "file-expanded" : ""}`} role="presentation"><button className="capability-scrim" aria-label="关闭项目文件" onClick={onClose} /><section className="capability-center file-panel" id="project-file-panel" role="region" aria-labelledby="file-panel-title">
    <header><div><h2 id="file-panel-title">{activeSpace.session ? "独立会话文件" : activeSpace.label}</h2><p>{activeSpace.session ? "这里的文件由你的所有独立会话共用。" : "浏览项目目录，选中文件后在右侧预览。"}</p></div><div className="panel-header-actions"><button className="panel-close" aria-label="关闭文件面板" onClick={onClose}>×</button></div></header>
    <div className="file-toolbar"><nav aria-label="当前路径"><button onClick={() => void load("")}>{activeSpace.session ? "独立会话" : "项目"}</button>{segments.map((segment, index) => <span key={`${segment}-${index}`}><b>/</b><button onClick={() => void load(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>)}</nav><div><button aria-label="刷新当前目录" onClick={() => void load()}><Icon name="refresh" /></button><label className="hidden-toggle"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />显示隐藏文件{listing?.hiddenCount ? `（${listing.hiddenCount}）` : ""}</label><input ref={inputRef} type="file" multiple hidden onChange={upload} /><button className="upload-button" onClick={() => inputRef.current?.click()}><Icon name="upload" />{activeSpace.session ? "上传附件" : `上传到 /${directory}`}</button></div></div>
    <UploadQueue items={uploads} onCancel={cancelUpload} onRetry={retryUpload} />
    {error ? <div className="file-error">{error}</div> : null}
    <div className="file-layout"><div className="file-list" aria-busy={loading}>{loading && !listing ? <div className="panel-state">正在读取文件…</div> : (listing?.entries || []).length ? listing.entries.map((entry) => <div className={`file-row ${preview?.path === entry.path ? "selected" : ""}`} key={entry.path}><button disabled={entry.type === "symlink" || entry.type === "other"} onClick={() => entry.type === "directory" ? void load(entry.path) : void openFile(entry)}><Icon name={entry.type === "directory" ? "folder" : "paperclip"} /><span><strong title={entry.name}>{entry.name}</strong><small>{entry.type === "directory" ? "文件夹" : [formatFileSize(entry.size), entry.mimeType?.split("/").pop(), entry.modifiedAt ? formatTime(entry.modifiedAt) : ""].filter(Boolean).join(" · ")}</small></span><Icon name="chevron" size={15} /></button>{entry.type === "file" && isDirectAttachment(entry.path) ? <button className="file-delete" aria-label={`删除上传文件 ${entry.name}`} onClick={() => void deleteEntry(entry)}>删除</button> : null}</div>) : <div className="panel-state compact">当前目录为空。</div>}</div><div className="file-preview">{preview ? <><div className="preview-heading"><div><strong title={preview.name}>{preview.name}</strong><small>{formatFileSize(preview.blob?.size ?? preview.size)} · {preview.path}</small></div><div><button className="preview-size-button" aria-label={expanded ? "恢复文件面板大小" : "放大文件预览"} title={expanded ? "恢复大小" : "放大预览"} onClick={() => setExpanded((value) => !value)}><Icon name={expanded ? "minimize" : "maximize"} size={16} /></button><a href={workbenchApi.fileUrl(activeSpace, preview.path, true, showHidden)} download={preview.name}>下载</a>{canAttach ? <button onClick={attachPreview}>附加给 Agent</button> : null}</div></div><FilePreviewContent preview={preview} /></> : <div className="preview-empty"><Icon name="folder" size={28} /><p>从左侧选择文件，即可在这里预览。</p><small>支持 Markdown、HTML、图片、PDF、DOCX 和 XLSX；其他文件仍可下载{canAttach ? "和交给 Agent" : ""}。</small></div>}</div></div>
  </section></div>;
}

function activityTitle(item) {
  if (item.type === "tool") return `工具 · ${item.tool || "tool"}`;
  if (item.type === "subagent") return `子任务 · ${item.session?.title || item.session?.id || "subagent"}`;
  return `${item.message?.role === "user" ? "用户" : "Agent"} 消息`;
}

function AgentConsole({ insight, hasRuntime, running, onOpen, onCapabilities, onSummarize }) {
  const stats = insight.stats || {};
  const stateLabel = !hasRuntime ? "发送消息后开始" : running ? "Agent 正在继续处理" : "可继续对话";
  return <section className="agent-console" aria-label="任务状态概览"><div className="agent-console-title"><span className={`console-state ${running ? "running" : hasRuntime ? "ready" : "waiting"}`} /><div><strong>{running ? "正在处理" : hasRuntime ? "当前会话已就绪" : "尚未开始"}</strong><small>{stateLabel}</small></div></div><div className="console-metrics"><span><b>{stats.turns || 0}</b> 轮对话</span><span>{running ? "任务未结束" : hasRuntime ? "状态已同步" : "暂无运行记录"}</span></div><div className="console-actions"><button className="console-primary" onClick={onOpen}>查看任务状态</button><button onClick={onCapabilities}>模型与技能</button>{hasRuntime ? <button disabled={insight?.summarizing} onClick={onSummarize}>{insight?.summarizing ? "正在整理…" : "整理长对话"}</button> : null}</div></section>;
}

function diffRows(item) {
  const patch = item.patch || item.diff;
  if (typeof patch === "string" && patch.trim()) return patch.split("\n");
  const before = typeof item.before === "string" ? item.before.split("\n") : [];
  const after = typeof item.after === "string" ? item.after.split("\n") : [];
  if (!before.length) return after.map((line) => `+${line}`);
  if (!after.length) return before.map((line) => `-${line}`);
  return [...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)];
}

function DiffPanel({ open, loading, error, items, session, onClose, onRetry }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  if (!open) return null;
  const statusLabel = { added: "新增", modified: "修改", deleted: "删除" };
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭 Diff 审阅" onClick={onClose} /><section className="capability-center diff-panel" role="dialog" aria-modal="true" aria-labelledby="diff-title"><header><div><span className="panel-kicker">SESSION DIFF</span><h2 id="diff-title">代码变更审阅</h2><p>{session?.title || "当前会话"} · 展示 Worker 已记录的完整文件差异</p></div><button className="panel-close" aria-label="关闭 Diff 审阅" onClick={onClose}>×</button></header><div className="diff-body">{loading ? <div className="panel-state"><span className="activity-spinner" />正在读取当前会话 Diff…</div> : error ? <div className="panel-state error"><p>{error}</p><button onClick={onRetry}>重试</button></div> : items.length ? items.map((item, index) => {
    const status = item.status || (!item.before ? "added" : !item.after ? "deleted" : "modified");
    const rows = diffRows(item);
    return <article className="diff-file" key={`${item.file || item.path || "file"}-${index}`}><header><div><Icon name="diff" size={16} /><strong>{item.file || item.path || "未知文件"}</strong></div><span className={`diff-status ${status}`}>{statusLabel[status] || status}</span><small><b>+{Number(item.additions || rows.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length)}</b><em>-{Number(item.deletions || rows.filter((line) => line.startsWith("-") && !line.startsWith("---")).length)}</em></small></header><pre>{rows.map((line, lineIndex) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "deleted" : line.startsWith("@@") ? "hunk" : "context"} key={lineIndex}>{line || " "}</span>)}</pre></article>;
  }) : <div className="discovery-empty"><Icon name="check" /><b>当前会话没有文件变更</b><p>Worker 尚未记录可审阅的 Diff。</p></div>}</div></section></div>;
}

function Conversation({ session, project, messages, permissions, insight, hasRuntime, attachments, olderCursor, loadingOlder, models, model, running, stopping, status, bootstrapping, bootstrapError, focusMode, sidebarCollapsed, onLoadOlder, onModelChange, onSend, onStop, onAttach, onRemoveAttachment, onOpenControl, onOpenCapabilities, onPanoramaOpen, onPermissionReply, onExport, onOpenFiles, onOpenDiff, onOpenSidebar, onExpandSidebar, onToggleFocus }) {
  const projectName = project?.name;
  const fileSpace = fileSpaceFor(session, project);
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const uploadRef = useRef(null);
  const uploadControllers = useRef(new Map());
  const cancelledUploads = useRef(new Set());
  const uploadGeneration = useRef(0);
  const messagesRef = useRef(null);
  const loadingOlderRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const nearMessageBottomRef = useRef(true);
  const renderedSessionRef = useRef(session?.id);
  const lastMessageID = messages.at(-1)?.id;
  const lastMessageLength = messages.at(-1)?.text?.length || 0;
  useEffect(() => {
    uploadGeneration.current += 1;
    uploadControllers.current.forEach((controller) => controller.abort()); uploadControllers.current.clear();
    cancelledUploads.current.clear();
    setUploads([]); setDragActive(false);
    return () => { uploadGeneration.current += 1; uploadControllers.current.forEach((controller) => controller.abort()); uploadControllers.current.clear(); };
  }, [session?.id]);
  useLayoutEffect(() => {
    const target = messagesRef.current;
    if (!target) return;
    const sessionChanged = renderedSessionRef.current !== session?.id;
    renderedSessionRef.current = session?.id;
    if (!sessionChanged && !nearMessageBottomRef.current) return;
    target.scrollTop = target.scrollHeight;
    nearMessageBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => { target.scrollTop = target.scrollHeight; });
    return () => window.cancelAnimationFrame(frame);
  }, [session?.id, lastMessageID, lastMessageLength]);
  const loadOlderWithoutJump = async () => {
    const target = messagesRef.current;
    if (!target || loadingOlderRef.current || loadingOlder || !olderCursor) return;
    loadingOlderRef.current = true;
    userScrollIntentRef.current = false;
    const previousHeight = target.scrollHeight;
    const previousTop = target.scrollTop;
    try {
      await onLoadOlder();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const current = messagesRef.current;
        if (current) current.scrollTop = previousTop + current.scrollHeight - previousHeight;
      }));
    } finally { loadingOlderRef.current = false; }
  };
  const handleMessageScroll = (event) => {
    const target = event.currentTarget;
    nearMessageBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 96;
    if (userScrollIntentRef.current && target.scrollTop <= 72 && target.scrollHeight > target.clientHeight + 1) void loadOlderWithoutJump();
  };
  const selectedCapability = models.find((item) => item.id === model);
  const modelCanSend = Boolean(selectedCapability?.selectable);
  const hasPendingUploads = uploads.some((item) => ["queued", "uploading", "saving"].includes(item.status));
  const hasFailedUploads = uploads.some((item) => item.status === "error");
  const hasContent = Boolean(draft.trim() || attachments.length);
  const canSend = modelCanSend && hasContent && !hasPendingUploads && !hasFailedUploads;
  const submit = async () => {
    const value = draft.trim();
    if (!canSend) return;
    setDraft("");
    nearMessageBottomRef.current = true;
    const sent = await onSend(value, attachments);
    if (sent) setUploads([]); else setDraft(value);
  };
  const enqueueUploads = (fileList) => {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const generation = uploadGeneration.current;
    const ownerSessionID = session?.id;
    const ownerSpace = fileSpace;
    setUploads((current) => [...current, ...files.map((file) => ({ id: crypto.randomUUID(), file, name: file.name || "粘贴图片", size: file.size, total: file.size, loaded: 0, status: "queued", generation, ownerSessionID, space: ownerSpace }))]);
  };
  const quickUpload = (event) => { enqueueUploads(event.target.files); event.target.value = ""; };
  useEffect(() => {
    if (!session) return;
    const active = uploads.filter((item) => item.status === "uploading" || item.status === "saving").length;
    uploads.filter((item) => item.status === "queued").slice(0, Math.max(0, 3 - active)).forEach((job) => {
      if (cancelledUploads.current.has(job.id)) return;
      const controller = new AbortController(); uploadControllers.current.set(job.id, controller);
      setUploads((current) => current.map((item) => item.id === job.id ? { ...item, status: "uploading" } : item));
      workbenchApi.uploadAttachment(job.space, job.file, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (controller.signal.aborted || cancelledUploads.current.has(job.id)) return;
          setUploads((current) => current.map((item) => item.id === job.id ? { ...item, loaded, total, status: loaded >= total ? "saving" : "uploading" } : item));
        },
      }).then((saved) => {
        uploadControllers.current.delete(job.id);
        if (job.generation !== uploadGeneration.current || job.ownerSessionID !== session?.id || controller.signal.aborted || cancelledUploads.current.has(job.id)) return;
        const attachment = { ...saved, space: job.space };
        onAttach(attachment);
        setUploads((current) => current.map((item) => item.id === job.id ? { ...item, attachment, path: saved.path, loaded: item.total || item.size, status: "done" } : item));
      }).catch((cause) => {
        uploadControllers.current.delete(job.id);
        if (job.generation !== uploadGeneration.current || cancelledUploads.current.has(job.id)) return;
        if (cause?.name === "AbortError") setUploads((current) => current.filter((item) => item.id !== job.id));
        else setUploads((current) => current.map((item) => item.id === job.id ? { ...item, status: "error", error: cause instanceof Error ? cause.message : "上传失败" } : item));
      });
    });
  }, [uploads, session?.id]);
  const cancelUpload = (id) => {
    const job = uploads.find((item) => item.id === id);
    if (job?.status === "done" && job.attachment) void onRemoveAttachment(job.attachment);
    cancelledUploads.current.add(id);
    uploadControllers.current.get(id)?.abort();
    setUploads((current) => current.filter((item) => item.id !== id));
  };
  const retryUpload = (id) => {
    cancelledUploads.current.delete(id);
    setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "queued", error: "", loaded: 0, generation: uploadGeneration.current, ownerSessionID: session?.id, space: fileSpace } : item));
  };
  const dropFiles = (event) => { event.preventDefault(); setDragActive(false); enqueueUploads(event.dataTransfer.files); };
  const pasteFiles = (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    if (!event.clipboardData?.getData("text/plain")?.trim()) event.preventDefault();
    enqueueUploads(files);
  };
  if (bootstrapping) return <section className="conversation empty-workbench loading-workbench" role="status"><div className="loading-orbit" /><strong>正在加载你的工作区</strong><span>正在同步模型、会话和 NAS 项目，请稍候…</span></section>;
  if (!session && bootstrapError) return <section className="conversation empty-workbench error-workbench"><div className="empty-icon"><Icon name="warning" size={23} /></div><strong>工作区加载失败</strong><span>{bootstrapError} 请点击右上角“刷新状态”重试。</span></section>;
  if (!session) return <section className="conversation empty-workbench"><div className="empty-icon"><Icon name="chatPlus" size={23} /></div><strong>创建会话，开始一个任务</strong><span>使用左上角菜单新建独立会话、创建项目，或接入已有 NAS 项目。</span></section>;
  return <section className="conversation"><header className="conversation-header"><button className="icon-button mobile-menu-button" aria-label="打开会话与项目" onClick={onOpenSidebar}><Icon name="menu" /></button>{sidebarCollapsed && !focusMode ? <button className="icon-button desktop-expand-button" aria-label="展开项目栏" onClick={onExpandSidebar}><Icon name="panel" /></button> : null}<div className="agent-logo"><YeutechMark /></div><div className="conversation-title"><small>{projectName || "独立会话"}{projectName ? <><Icon name="chevron" size={11} />项目会话</> : null}</small><h2>{session.title || "新会话"}</h2></div><button className="header-files-button" aria-label="查看当前会话的文件变更" title={hasRuntime ? "查看当前会话修改过的文件" : "此历史会话没有可用的文件变更记录"} disabled={!hasRuntime} onClick={onOpenDiff}><Icon name="edit" /><span>变更</span></button><button className="header-console-button" aria-haspopup="dialog" onClick={onOpenControl}><Icon name="shield" />Agent 控制台</button><button className="icon-button" aria-label="导出当前会话" onClick={onExport}><Icon name="download" /></button><button className="icon-button" aria-label={focusMode ? "退出专注模式" : "进入专注模式"} onClick={onToggleFocus}><Icon name={focusMode ? "minimize" : "maximize"} /></button><button className="header-files-button" aria-label="打开文件与附件" title="浏览、上传并附加文件" onClick={onOpenFiles}><Icon name="folder" /><span>文件</span></button></header>
    <AgentConsole insight={insight || {}} hasRuntime={hasRuntime} running={running} onOpen={onOpenControl} onCapabilities={onOpenCapabilities} onSummarize={() => onPanoramaOpen("summarize")} />
    <div className="messages" ref={messagesRef} onScroll={handleMessageScroll} onWheel={() => { userScrollIntentRef.current = true; }} onTouchStart={() => { userScrollIntentRef.current = true; }}>{messages.length === 0 && permissions.length === 0 ? <div className="empty-conversation"><div className="empty-icon"><Icon name="chatPlus" size={22} /></div><strong>开始会话</strong><span>{projectName ? "当前内容保存在这个项目中。" : "文件统一保存在你的“独立会话”文件夹中。"}</span></div> : <>{olderCursor ? <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlderWithoutJump()}>{loadingOlder ? "正在读取…" : "向上滚动继续加载"}</button> : null}<Activity running={running} status={status} />{messages.map((message, index) => { const awaitingReply = !message.text && running && index === messages.length - 1; return <article className={`message-block ${message.role}`} key={message.id}>{message.role === "user" ? <div className="message user"><div className="user-bubble"><MarkdownText text={message.text} />{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((item) => <span key={item.workspacePath || item.path}><Icon name="paperclip" size={12} />{item.workspacePath || item.name || item.path}</span>)}</div> : null}</div><time>{formatTime(message.createdAt)}</time></div> : <div className="message assistant"><div className="assistant-mark"><YeutechMark /></div><div className="assistant-body"><MarkdownText text={message.text || (awaitingReply ? "正在准备回复…" : "本轮未返回正文")} /><footer><span />{message.text ? "本轮已结束" : awaitingReply ? "正在回复" : "本轮未返回正文"}{message.createdAt ? <><b>·</b><time>{formatTime(message.createdAt)}</time></> : null}</footer></div></div>}</article>; })}{permissions.map((request) => <PermissionCard request={request} onReply={onPermissionReply} key={request.id} />)}</>}</div>
    <div className={`composer-wrap ${dragActive ? "drag-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }} onDrop={dropFiles}>
      <div className="composer-upload-queue"><UploadQueue items={uploads} onCancel={cancelUpload} onRetry={retryUpload} /></div>
      {attachments.length ? <div className="attached-files" aria-label="已附加文件">{attachments.map((item) => <span key={item.workspacePath || `${fileSpaceKey(item.space)}:${item.path}`}><Icon name="paperclip" size={13} /><b>{item.workspacePath || item.path}</b><button aria-label={`从本轮移除引用 ${item.name || item.path}`} onClick={() => void onRemoveAttachment(item)}>×</button></span>)}</div> : null}
      <div className="composer glass-control">
        {dragActive ? <div className="composer-drop-hint">松开即上传到当前会话</div> : null}
        <textarea aria-label="向 Agent 发送消息" value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={pasteFiles} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={running ? "输入补充要求，发送后继续当前任务…" : "描述任务，或拖入、粘贴、选择任意文件…"} />
        <div className="composer-tools">
          <input ref={uploadRef} type="file" multiple hidden onChange={quickUpload} />
          <button className="add-file-button" aria-label="添加文件" title={projectName ? "上传到当前项目" : "上传到本独立会话的受控附件目录"} onClick={() => uploadRef.current?.click()}><Icon name="plus" /><span>添加文件</span></button>
          <span className="attachment-label"><Icon name="paperclip" size={14} />{attachments.length ? `${attachments.length} 个附件` : projectName ? "当前项目" : "独立会话文件夹"}</span>
          <select aria-label="当前会话模型" value={model} onChange={(event) => onModelChange(event.target.value)}>{models.length ? models.map((item) => <option value={item.id} key={item.id} disabled={!item.selectable}>{item.name}{item.selectable ? "" : ` · ${item.disabledReason || "暂不可用"}`}</option>) : <option value="">正在读取模型…</option>}</select>
          <select aria-label="推理强度" defaultValue="high"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>
          <div className="composer-spacer" />
          {selectedCapability && !selectedCapability.selectable ? <span className="model-warning" title={selectedCapability.disabledReason}>能力待补全</span> : null}
          {running ? <button className="tool-button stop" aria-label={stopping ? "正在停止" : "停止"} title={stopping ? "正在等待 Agent 确认停止" : "停止当前执行"} disabled={stopping} onClick={onStop}>{stopping ? <span className="button-spinner" /> : <Icon name="stop" />}</button> : null}
          <button className="send-button" aria-label="发送" disabled={!canSend} title={hasPendingUploads ? "附件上传完成后可发送" : hasFailedUploads ? "请先重试或移除上传失败的文件" : !modelCanSend ? "当前没有能力完整的可用模型" : hasContent ? "发送" : "输入内容或添加文件"} onClick={() => void submit()}><Icon name="arrowUp" /></button>
        </div>
      </div>
    </div>
  </section>;
}

function readableStatus(state) {
  if (!state) return "";
  const code = state.error?.code || state.code;
  if (code === "auth_unavailable") return "CLIProxyAPI 已连通，但当前模型账号授权已失效。";
  return state.message || "Agent 正在执行";
}

export function App() {
  const cachedSelection = storedSelectionContext();
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
  const [modelReload, setModelReload] = useState({ status: "unknown" });
  const [running, setRunning] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState(() => new Set());
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => storedWidth(SIDEBAR_WIDTH_STORAGE_KEY, 256, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
  const [filePanelWidth, setFilePanelWidth] = useState(() => storedWidth(FILE_PANEL_WIDTH_STORAGE_KEY, 640, FILE_PANEL_MIN_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, window.innerWidth * .55)));
  const [permissions, setPermissions] = useState([]);
  const [insightsBySession, setInsightsBySession] = useState({});
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [skills, setSkills] = useState([]);
  const [skillReport, setSkillReport] = useState({ reported: false, workerActive: false });
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelProjectId, setFilePanelProjectId] = useState("");
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

  const filePanelMaxWidth = () => Math.max(FILE_PANEL_MIN_WIDTH, Math.min(window.innerWidth * .55, window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 434));
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
      setSidebarWidth((current) => clamp(current, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
      setFilePanelWidth((current) => clamp(current, FILE_PANEL_MIN_WIDTH, filePanelMaxWidth()));
    };
    window.addEventListener("resize", keepWidthsInRange);
    return () => { window.removeEventListener("resize", keepWidthsInRange); resizeCleanupRef.current?.(); };
  }, []);
  useEffect(() => {
    setFilePanelWidth((current) => clamp(current, FILE_PANEL_MIN_WIDTH, filePanelMaxWidth()));
  }, [sidebarWidth, sidebarCollapsed]);

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
      const runtimeSession = (item) => ({ id: item.id, ...(item.projectId ? { projectId: item.projectId } : {}), title: item.title || "新会话", model: item.model?.modelID || item.model?.id || bootstrap.defaultModel?.id || selectable[0]?.id, updatedAt: Number(item.time?.updated || item.time?.created), runtimeSessionId: item.id });
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
      const nextConversations = sortSessionsByUpdatedAt([
        ...historicalConversations.filter((item) => !String(item.projectId || "").startsWith("standalone:")),
        ...remoteSessions.filter((item) => item.projectId && !mappedIDs.has(item.id)).map(runtimeSession),
      ]);
      const nextStandalone = sortSessionsByUpdatedAt([
        ...historicalConversations.filter((item) => String(item.projectId || "").startsWith("standalone:")),
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
      setProjects([...projectMap.values()]); setConversations(nextConversations); setRuntimeSessions(nextRuntime); setStandaloneSessions(nextStandalone); setRunningSessionIds(nextRunningSessionIds); setSelected(nextSelected);
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

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    if (!selected) return;
    storeSelection({ scope: selectedProject ? "project" : "session", projectId: selectedProject, sessionId: selected });
  }, [selected, selectedProject]);
  useEffect(() => {
    if (preserveAttachmentsOnNextSelection.current) preserveAttachmentsOnNextSelection.current = false;
    else setAttachments([]);
    setStopping(false); setDiffOpen(false); setDiffItems([]); setDiffError("");
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let current = true;
    if (isHistoricalConversation(selected)) {
      migrationApi.messages(selected).then((history) => {
        if (!current) return;
        setMessagesBySession((all) => ({ ...all, [selected]: [...history.records.map((item) => ({ ...item, origin: "history" })), ...(all[selected] || []).filter((item) => item.origin !== "history")] }));
        setMessageCursors((all) => ({ ...all, [selected]: history.cursor }));
      }).catch((error) => { if (current) setStatus(error.message); });
    } else if (!selected.startsWith("ses_local") && !runtimeEnabledSessions.has(selected)) {
      workbenchApi.messages(selected).then((history) => {
        if (!current) return;
        setMessagesBySession((all) => ({ ...all, [selected]: history.records.map((item) => ({ ...item, id: `passive-${item.id}`, origin: "passive" })) }));
        setMessageCursors((all) => ({ ...all, [selected]: history.cursor ? `passive:${history.cursor}` : null }));
      }).catch((error) => { if (current) setStatus(error.message); });
    }
    return () => { current = false; };
  }, [selected]);

  const session = conversations.find((item) => item.id === selected) || standaloneSessions.find((item) => item.id === selected);
  const project = projects.find((item) => item.id === session?.projectId);
  const messages = messagesBySession[selected] || [];
  useEffect(() => {
    if (session?.model && models.some((item) => item.id === session.model && item.selectable)) setModel(session.model);
  }, [selected, session?.model, models]);
  const knownRuntimeID = runtimeSessions[selected] || (!selected.startsWith("ses_local") && !isHistoricalConversation(selected) ? selected : "");
  const activeRuntimeID = runtimeEnabledSessions.has(selected) ? knownRuntimeID : "";
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
        const runtimeMessages = (snapshot.messages || []).map((message) => ({ ...message, id: `runtime-${message.id}`, origin: "runtime" }));
        setMessagesBySession((all) => ({ ...all, [displayID]: historical ? [...(all[displayID] || []).filter((item) => item.origin === "history"), ...runtimeMessages] : runtimeMessages }));
        setPermissions(snapshot.permissions || []);
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...snapshot, graph: snapshot.graph || all[displayID]?.graph } }));
        setRunning(Boolean(snapshot.session?.status));
        updateRunningSession(displayID, Boolean(snapshot.session?.status));
        setStatus(readableStatus(snapshot.session?.status));
        return snapshot;
      }).finally(() => { inFlight = undefined; });
      return inFlight;
    };
    reconcileRef.current = reconcile;
    const cursorKey = `yeutech-agent-workbench:projection:${activeRuntimeID}`;
    const hasCachedProjection = (messagesBySession[displayID] || []).some((item) => item.origin === "runtime" || item.origin === "ephemeral");
    const resumeCursor = hasCachedProjection ? Number(window.localStorage.getItem(cursorKey) || 0) : 0;
    const events = workbenchApi.events(activeRuntimeID, resumeCursor);
    events.onopen = () => { window.clearInterval(fallbackTimer); fallbackTimer = undefined; setStatus((value) => value === "实时连接中断，正在恢复…" ? "" : value); };
    events.addEventListener("durable", (event) => {
      const envelope = JSON.parse(event.data);
      window.localStorage.setItem(cursorKey, String(envelope.cursor));
      if (envelope.type === "message.upsert") {
        const projected = { ...envelope.data, id: `runtime-${envelope.data.id}`, origin: "runtime" };
        setMessagesBySession((all) => {
          const existing = all[displayID] || [];
          const passiveID = `passive-${envelope.data.id}`;
          const next = existing.filter((item) => item.id !== projected.id && item.id !== passiveID && !(item.origin === "optimistic" && item.role === projected.role && item.text === projected.text));
          return { ...all, [displayID]: [...next, projected].sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0)) };
        });
      } else if (envelope.type === "session.state") {
        setRunning(Boolean(envelope.data.status)); updateRunningSession(displayID, Boolean(envelope.data.status)); setStatus(readableStatus(envelope.data.status));
      } else if (envelope.type === "trajectory.upsert") {
        setInsightsBySession((all) => { const value = all[displayID] || {}; const trajectory = [...(value.trajectory || []).filter((item) => item.id !== envelope.data.id), envelope.data].sort((a, b) => a.ordinal - b.ordinal); return { ...all, [displayID]: { ...value, trajectory, activity: trajectory } }; });
      } else if (envelope.type === "projection.meta") {
        setPermissions(envelope.data.permissions || []);
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...(all[displayID] || {}), ...envelope.data } }));
      } else if (envelope.type === "context.receipt") {
        setInsightsBySession((all) => ({ ...all, [displayID]: { ...(all[displayID] || {}), executionContextReceipt: envelope.data } }));
      }
    });
    events.addEventListener("ephemeral", (event) => {
      const payload = JSON.parse(event.data)?.data;
      const part = payload?.properties?.part;
      const messageID = part?.messageID || part?.messageId;
      const hasText = typeof part?.text === "string";
      const hasDelta = typeof part?.delta === "string";
      if (part?.type === "text" && messageID && (hasText || hasDelta)) {
        const id = `runtime-${messageID}`;
        setMessagesBySession((all) => {
          const existing = all[displayID] || [];
          const currentMessage = existing.find((item) => item.id === id);
          const text = hasText ? part.text : `${currentMessage?.text || ""}${part.delta}`;
          const projected = currentMessage
            ? { ...currentMessage, text }
            : { id, role: "assistant", text, createdAt: Date.now(), origin: "ephemeral" };
          return { ...all, [displayID]: currentMessage ? existing.map((item) => item.id === id ? projected : item) : [...existing, projected] };
        });
      }
      if (isImmediateProjectionEvent(payload)) setStatus("正在同步持久事件…");
      if (isSettledSessionEvent(payload)) {
        settled = true;
        setRunning(false);
        updateRunningSession(displayID, false);
        setStatus("");
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
  const loadOlder = async () => {
    const cursor = messageCursors[selected];
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
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
    const id = `ses_local_${Date.now().toString(36)}`;
    const next = { id, title: "新会话", model, updatedAt: Date.now(), fileScope: id };
    setStandaloneSessions((current) => [next, ...current]); setMessagesBySession((current) => ({ ...current, [id]: [] })); setSelected(id); setSelectedProject(""); setFilePanelOpen(false); setRunning(false); updateRunningSession(id, false); setStopping(false); setStatus("");
  };
  const createProjectSession = async (targetProject, title = "新项目会话") => {
    if (!targetProject?.registered) return;
    const id = `ses_local_${Date.now().toString(36)}`;
    const next = { id, projectId: targetProject.id, title, model, updatedAt: Date.now() };
    setConversations((current) => [next, ...current]); setMessagesBySession((current) => ({ ...current, [id]: [] }));
    setSelectedProject(targetProject.id); setExpandedProjects((current) => new Set([...current, targetProject.id])); setSelected(id); setFilePanelOpen(false); setRunning(false); updateRunningSession(id, false); setStatus("");
    return next;
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
    if (!session) return false;
    const currentPoll = pollVersion.current + 1;
    pollVersion.current = currentPoll;
    const localID = selected;
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
      let runtimeDisplayID = localID;
      if (historical && !remoteID) {
        const result = await migrationApi.continue(localID);
        remoteID = result.session.id;
        setRuntimeSessions((current) => ({ ...current, [localID]: remoteID }));
        setConversations((current) => current.map((item) => item.id === localID ? { ...item, runtimeSessionId: remoteID } : item));
      } else if (!historical) {
        if (localID.startsWith("ses_local")) {
          const remote = project
            ? (await workbenchApi.createProjectSession(project.workspaceDirectory || project.name, title)).data
            : await agentApi.createSession(title);
          remoteID = remote.id;
          runtimeDisplayID = remote.id;
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
      await agentApi.prompt(remoteID, text, model, selectedAttachments, { project: project?.workspaceDirectory || project?.name || null, workload: "general-agent" });
      const sentIdentities = new Set(selectedAttachments.map(attachmentFileIdentity));
      const sentOwnerIDs = new Set([localID, runtimeDisplayID]);
      setAttachments((current) => current.filter((item) => !sentOwnerIDs.has(item.ownerSessionID) || !sentIdentities.has(attachmentFileIdentity(item))));
      return true;
    } catch (error) {
      if (pollVersion.current === currentPoll) {
        setRunning(false); updateRunningSession(localID, false); setStatus(error instanceof Error ? error.message : "请求失败");
      }
      return false;
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
      await agentApi.replyPermission(requestID, reply);
      setStatus(reply === "once" ? "已允许本次操作。" : "已拒绝该操作。");
    } catch (error) {
      setStatus(error.message);
      const pending = await agentApi.permissions().catch(() => []);
      setPermissions(pending.filter((request) => request.sessionID === activeRuntimeID));
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
    if (!runtimeID) { setStatus("历史会话尚未建立运行时映射，暂不能重命名。"); return; }
    const title = window.prompt("输入新的会话名称", targetSession.title)?.trim();
    if (!title || title === targetSession.title) return;
    setStatus(`正在重命名会话…`);
    try {
      const result = await workbenchApi.renameSession(runtimeID, title);
      if (isHistoricalConversation(targetSession.id)) await migrationApi.rename(targetSession.id, title);
      const updated = result?.data || { ...targetSession, title };
      setConversations((current) => current.map((item) => item.id === targetSession.id ? { ...item, ...updated } : item));
      setStandaloneSessions((current) => current.map((item) => item.id === targetSession.id ? { ...item, ...updated } : item));
      setStatus(`会话已重命名为 ${updated.title || title}。`);
    } catch (error) { setStatus(`会话重命名失败：${error instanceof Error ? error.message : "未知错误"}`); }
  };

  const deleteSession = async (targetSession) => {
    const runtimeID = runtimeSessions[targetSession.id] || (!isHistoricalConversation(targetSession.id) && !targetSession.id.startsWith("ses_local") ? targetSession.id : "");
    if (!runtimeID) { setStatus("历史会话尚未建立运行时映射，暂不能删除。"); return; }
    if (!window.confirm(`删除会话“${targetSession.title}”？此操作会由服务端同步清理会话映射。`)) return;
    setStatus("正在删除会话…");
    try {
      await workbenchApi.deleteSession(runtimeID);
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
    setFilePanelOpen(true);
    setSidebarOpen(false);
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

  const selectableModelCount = models.filter((item) => item.selectable).length;
  const reloadLabel = modelReload.status === "pending-idle" ? " · 目录更新待空闲加载" : modelReload.status === "reloading" ? " · 正在安全加载" : "";
  return <div className="portal-shell">
    <main className={`workspace ${focusMode ? "focus-mode" : ""}`}>
      <section className="workbench-toolbar"><div className="toolbar-title"><button className="icon-button mobile-menu-button toolbar-menu" aria-label="打开会话与项目" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><div><h1>AI 工作台</h1><p>{bootstrapping ? "正在同步工作区…" : project ? `${project.name} · 项目会话` : session ? `${standaloneSessions.length} 个独立会话` : `${projects.length} 个项目`}</p></div></div><div className="toolbar-actions"><button disabled={bootstrapping} onClick={refresh}><Icon name="refresh" />{bootstrapping ? "加载中" : "刷新状态"}</button><span className={`capability ${bootstrapping ? "loading" : bootstrapError ? "error" : ""}`}><Icon name={bootstrapping ? "refresh" : bootstrapError ? "warning" : "check"} size={14} />{bootstrapping ? "正在连接 Agent 并读取数据…" : bootstrapError ? "工作区加载失败" : `服务已连接 · ${selectableModelCount} 个模型可选择${reloadLabel}`}</span><button onClick={() => window.location.assign("https://yeutech.cn/")}><Icon name="back" />返回门户</button></div></section>
      <section className={`command-stage ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${filePanelOpen ? "files-open" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--file-panel-width": `${filePanelWidth}px` }}>
        {sidebarOpen ? <button className="sidebar-scrim" aria-label="关闭会话与项目" onClick={() => setSidebarOpen(false)} /> : null}
        <SurfaceBoundary label="项目栏" resetKey={`${projects.length}:${standaloneSessions.length}`}><Sidebar projects={projects} conversations={conversations} standaloneSessions={standaloneSessions} selected={selected} selectedProject={selectedProject} expandedProjects={expandedProjects} runningSessionIds={runningSessionIds} runtimeSessions={runtimeSessions} modelCount={`${selectableModelCount}/${models.length}`} loading={bootstrapping} onSelect={(id) => { selectSession(id); setSidebarOpen(false); }} onSelectProject={selectProject} onNew={() => { void createSession(); setSidebarOpen(false); }} onNewProject={() => { setProjectMutationError(""); setProjectDialogOpen(true); }} onDiscoverProjects={() => { setDiscoveryError(""); setDiscoveryOpen(true); void refresh(); }} onNewProjectSession={(item) => void createProjectSession(item)} onOpenProjectFiles={(item) => void openProjectFiles(item)} onRenameProject={(item) => void renameProject(item)} onDeleteProject={(item) => void deleteProject(item)} onRenameSession={(item) => void renameSession(item)} onDeleteSession={(item) => void deleteSession(item)} onForkSession={(item) => void forkSession(item)} onCapabilities={() => void openCapabilities()} onControl={openControl} onCollapse={() => setSidebarCollapsed(true)} /></SurfaceBoundary>
        <PanelResizer className="sidebar-resizer" label="调整项目目录宽度" controls="project-sidebar" value={sidebarWidth} min={SIDEBAR_MIN_WIDTH} max={SIDEBAR_MAX_WIDTH} onPointerDown={(event) => beginResize("sidebar", event)} onChange={updateSidebarWidth} />
        <SurfaceBoundary label="会话区" resetKey={selected}><Conversation session={session} project={project} messages={messages} permissions={permissions} insight={insightsBySession[selected]} hasRuntime={Boolean(knownRuntimeID)} attachments={attachments} olderCursor={messageCursors[selected]} loadingOlder={loadingOlder} models={models} model={model} running={running} stopping={stopping} status={status} bootstrapping={bootstrapping} bootstrapError={bootstrapError} focusMode={focusMode} sidebarCollapsed={sidebarCollapsed} onLoadOlder={loadOlder} onModelChange={setModel} onSend={send} onStop={stop} onAttach={attachFile} onRemoveAttachment={removeAttachment} onOpenControl={openControl} onOpenCapabilities={() => void openCapabilities()} onPanoramaOpen={panoramaAction} onPermissionReply={replyPermission} onExport={exportConversation} onOpenFiles={() => { setFocusMode(false); setFilePanelProjectId(""); setFilePanelOpen(true); }} onOpenDiff={() => void openDiff()} onOpenSidebar={() => setSidebarOpen(true)} onExpandSidebar={() => setSidebarCollapsed(false)} onToggleFocus={() => setFocusMode((current) => { if (!current) setFilePanelOpen(false); return !current; })} /></SurfaceBoundary>
        {filePanelOpen ? <PanelResizer className="file-panel-resizer" label="调整项目文件宽度" controls="project-file-panel" value={filePanelWidth} min={FILE_PANEL_MIN_WIDTH} max={filePanelMaxWidth()} keyboardDirection={-1} onPointerDown={(event) => beginResize("files", event)} onChange={updateFilePanelWidth} /> : null}
        <SurfaceBoundary label="文件预览" resetKey={`${selected}:${filePanelProjectId}:${filePanelOpen}`}><FilePanel session={session} project={projects.find((item) => item.id === filePanelProjectId) || project} open={filePanelOpen} canAttach={!filePanelProjectId || filePanelProjectId === project?.id} onClose={() => { setFilePanelOpen(false); setFilePanelProjectId(""); }} onAttach={attachFile} onDeleted={removeDeletedAttachment} /></SurfaceBoundary>
      </section>
    </main>
    <CapabilityCenter open={capabilityOpen} loading={capabilityLoading} error={capabilityError} profiles={profiles} skills={skills} skillReport={skillReport} models={models} onClose={() => setCapabilityOpen(false)} onRetry={() => void openCapabilities()} />
    <ControlCenter open={controlOpen} onClose={() => setControlOpen(false)} project={project} session={session} runtimeSessionId={activeRuntimeID} insight={insightsBySession[selected]} attachments={attachments} hasRuntime={Boolean(activeRuntimeID)} model={model} />
    <ProjectDialog open={projectDialogOpen} busy={projectMutationBusy} error={projectMutationError} onClose={() => setProjectDialogOpen(false)} onCreate={createProject} />
    <ProjectDiscoveryDialog open={discoveryOpen} projects={projects.filter((item) => item.registered === false)} busyProjectId={discoveryBusyProjectId} error={discoveryError} onClose={() => setDiscoveryOpen(false)} onRegister={(item) => void registerProject(item)} onRescan={() => { setDiscoveryError(""); void refresh(); }} />
    <DiffPanel open={diffOpen} loading={diffLoading} error={diffError} items={diffItems} session={session} onClose={() => setDiffOpen(false)} onRetry={() => void openDiff()} />
  </div>;
}
