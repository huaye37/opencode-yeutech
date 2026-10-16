import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { sortSessionsByUpdatedAt } from "./session-ordering.js";
import { STANDALONE_EXPANDED_STORAGE_KEY, storedBoolean, isHistoricalConversation } from "./workbench-helpers.js";
import { formatTime } from "./workbench-timeline.jsx";

export function RowMenu({ label, children }) {
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

export function SessionRow({ session, selected, running, runtimeAvailable, reasoningLabel, onSelect, onRename, onDelete, onFork }) {
  return <div className={`session-row ${selected ? "selected" : ""}`}>
    <button className="session-row-main" aria-current={selected ? "page" : undefined} onClick={onSelect}><span>{running ? <span className="session-running" aria-label="正在运行" /> : <Icon name="chatPlus" />}<b>{session.title}</b><time>{formatTime(session.updatedAt)}</time></span><small>{reasoningLabel}</small></button>
    <RowMenu label={`管理会话 ${session.title}`}><button role="menuitem" disabled={!runtimeAvailable} title={runtimeAvailable ? "" : "先发送消息以建立运行时会话"} onClick={() => onRename(session)}><Icon name="edit" size={15} />重命名</button><button role="menuitem" disabled={!runtimeAvailable} title={runtimeAvailable ? "" : "历史会话尚未建立运行时映射"} onClick={() => onFork(session)}><Icon name="fork" size={15} />Fork 会话</button><button className="danger" role="menuitem" disabled={!runtimeAvailable} title={runtimeAvailable ? "" : "历史会话尚未建立运行时映射"} onClick={() => onDelete(session)}><Icon name="trash" size={15} />删除会话</button></RowMenu>
  </div>;
}

export function Sidebar({ projects, conversations, standaloneSessions, selected, selectedProject, expandedProjects, runningSessionIds, runtimeSessions, modelCount, loading, onSelect, onSelectProject, onNew, onNewProject, onDiscoverProjects, onNewProjectSession, onOpenProjectFiles, onRenameProject, onDeleteProject, onRenameSession, onDeleteSession, onForkSession, onCapabilities, onPlugins, onControl, onCollapse }) {
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
  return <aside className="sidebar" id="project-sidebar" aria-label="会话与项目" data-layer="surface"><h2 className="directory-heading">会话与项目</h2><div className="sidebar-actions">
    <div className="primary-action-row"><button className="primary-button" disabled={loading} onClick={onNew}><Icon name="chatPlus" />新建独立会话</button><button className="collapse-button" aria-label="收起项目栏" title="收起项目栏" onClick={onCollapse}><Icon name="panel" /></button></div>
    <div className="sidebar-action-grid"><button disabled={loading} onClick={onNewProject}><Icon name="plus" />新建项目</button><button disabled={loading} onClick={onDiscoverProjects}><Icon name="folderIn" />扫描 NAS 项目</button></div>
    <button className="sidebar-action console-entry" disabled={loading} onClick={onControl} aria-haspopup="dialog"><Icon name="shield" /><span className="sidebar-action-copy"><b>任务状态</b><small>当前目标、进度和最近操作</small></span><em>查看</em></button>
    <div className="sidebar-action-grid"><button disabled={loading} onClick={onCapabilities} aria-haspopup="dialog"><Icon name="sparkles" />模型能力</button><button disabled={loading} onClick={onPlugins} aria-haspopup="dialog"><Icon name="plus" />插件中心</button></div>
    <label className="search"><Icon name="search" /><input disabled={loading} aria-label="搜索会话与项目" onKeyDown={event => { if (event.key === "Escape") document.querySelector(".header-search")?.focus(); }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={loading ? "正在同步项目与会话…" : "搜索全部会话与项目"} /></label>
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
