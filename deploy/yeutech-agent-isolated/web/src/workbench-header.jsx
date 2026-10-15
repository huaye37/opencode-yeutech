import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";

/** v3 shell only: account/appearance remain portal-owned; refresh reuses the existing handler. */
export function WorkbenchHeader({ loading, error, modelCount, reloadLabel, onRefresh }) {
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
  return <header className="workbench-toolbar yt-chrome" data-layer="chrome">
    <div className="toolbar-brand">
      <a className="brand-home" href="https://yeutech.cn/" aria-label="YEUTECH 首页">YEUTECH</a>
      <span className="toolbar-divider" aria-hidden="true" />
      <strong className="service-name">AI 工作台</strong>
    </div>
    <div className="toolbar-actions">
      <span className={`capability ${loading ? "loading" : error ? "error" : ""}`} role="status" aria-live="polite">
        <span className="connection-dot" aria-hidden="true" />
        <span>{loading ? "正在连接…" : error ? "连接失败" : "已连接"}</span>
        {!loading && !error ? <span className="connection-detail">· {modelCount} 个模型{reloadLabel}</span> : null}
      </span>
      <div className="account-menu" ref={menu}>
        <button ref={trigger} className="account-trigger" aria-label="账户与设置" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="user" size={20} /></button>
        {open ? <nav className="account-popover" role="menu" aria-label="账户与设置">
          <a role="menuitem" href="https://yeutech.cn/">在门户管理账户<Icon name="user" size={17} /></a>
          <a role="menuitem" href="https://yeutech.cn/settings/?site=agent">外观设置<Icon name="sparkles" size={17} /></a>
          <button role="menuitem" disabled={loading} onClick={() => { setOpen(false); void onRefresh(); }}>重新同步工作区<Icon name="refresh" size={17} /></button>
        </nav> : null}
      </div>
    </div>
  </header>;
}
