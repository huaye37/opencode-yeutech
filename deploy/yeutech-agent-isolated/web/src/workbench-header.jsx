import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";

/** Home-language site header: account/appearance remain portal-owned; refresh reuses the existing handler. */
export function WorkbenchHeader({ user, loading, onRefresh, onSearch }) {
  const [open, setOpen] = useState(false);
  const menu = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && menu.current?.contains(event.target)) return;
      setOpen(false);
      if (event.type === "keydown") trigger.current?.focus();
    };
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [open]);
  useEffect(() => {
    const search = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onSearch(); } };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, [onSearch]);
  return <header className="workbench-identity" data-layer="chrome">
    <div className="toolbar-brand">
      <a className="brand-home" href="https://yeutech.cn/" aria-label="YEUTECH 首页">YEUTECH</a>

      <span className="toolbar-divider" aria-hidden="true" /><strong className="service-name">AI 工作台</strong>
    </div>
    <div className="toolbar-actions">
      <a className="portal-return" href="https://yeutech.cn/" aria-label="返回门户"><Icon name="chevron" size={16} /><span>返回门户</span></a>
      <button type="button" className="header-search" aria-label="搜索会话与项目 (⌘K)" onClick={onSearch}><Icon name="search" size={18} /><span>搜索会话与项目…</span><kbd>⌘K</kbd></button>
      <div className="account-menu" ref={menu}>
        <button ref={trigger} className="account-trigger" title={user?.username || "账户与设置"} aria-label="账户与设置" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><span className="account-initial" aria-hidden="true">{Array.from(user?.username?.trim() || "?")[0].toLocaleUpperCase()}</span></button>
        {open ? <nav className="account-popover" role="menu" aria-label="账户与设置">
          <a role="menuitem" href="https://yeutech.cn/">在门户管理账户<Icon name="user" size={17} /></a>
          <a role="menuitem" href="https://yeutech.cn/settings/?site=agent">外观设置<Icon name="sparkles" size={17} /></a>
          <button role="menuitem" disabled={loading} onClick={() => { setOpen(false); void onRefresh(); }}>重新同步工作区<Icon name="refresh" size={17} /></button>
        </nav> : null}
      </div>
    </div>
  </header>;
}

/** Horizontal navigation changes only the existing panel visibility, never task state. */
export function WorkbenchTabs({ directoryOpen, filesOpen, onDirectory, onConversation, onFiles, onControl }) {
  const active = filesOpen ? "files" : directoryOpen ? "directory" : "conversation";
  return <nav className="workbench-tabs" aria-label="工作台导航" data-layer="control">
    <button aria-current={active === "directory" ? "page" : undefined} onClick={onDirectory}><Icon name="folder" /><span>会话与项目</span></button>
    <button aria-current={active === "conversation" ? "page" : undefined} onClick={onConversation}><Icon name="chatPlus" /><span>对话</span></button>
    <button aria-current={active === "files" ? "page" : undefined} onClick={onFiles}><Icon name="folderIn" /><span>文件</span></button>
    <button onClick={onControl} aria-haspopup="dialog"><Icon name="shield" /><span>任务状态</span></button>
  </nav>;
}

/** Auxiliary home column consumes the existing connection state. */
export function WorkbenchMore({ loading, error, modelCount, reloadLabel, onRefresh }) {
  return <aside className="workbench-more" aria-label="AI 工作台更多功能">
    <h2>更多功能</h2>
    <a href="https://yeutech.cn/settings/?site=agent"><Icon name="sparkles" size={18} />外观设置</a>
    <a href="https://yeutech.cn/"><Icon name="user" size={18} />在门户管理账户</a>
    <button disabled={loading} onClick={() => void onRefresh()}><Icon name="refresh" size={18} />重新同步工作区</button>
    <span className={`capability ${loading ? "loading" : error ? "error" : ""}`} role="status" aria-live="polite"><span className="connection-dot" aria-hidden="true" />{loading ? "正在连接…" : error ? "连接失败" : "已连接"}</span>
    {!loading && !error ? <span>{modelCount} 个模型{reloadLabel}</span> : null}
  </aside>;
}
