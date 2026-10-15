import { Component } from "react";
import { Icon } from "./icons.jsx";
import { clamp } from "./workbench-helpers.js";

export class SurfaceBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous) { if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="surface-error" role="alert"><Icon name="warning" /><b>{this.props.label}暂时无法显示</b><p>其他区域仍可继续使用。</p><button onClick={() => this.setState({ failed: false })}>重试此区域</button></section>;
  }
}

export function YeutechMark() {
  return <svg className="yeutech-mark" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="16" fill="currentColor" /><path d="M18.5 19.5 32 31.5l13.5-12M32 31.5v15" stroke="white" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" /><rect x="13" y="14" width="11" height="11" rx="3" fill="white" /><rect x="40" y="14" width="11" height="11" rx="3" fill="white" /><rect x="26.5" y="41" width="11" height="11" rx="3" fill="white" /></svg>;
}

export function PanelResizer({ className, label, controls, value, min, max, keyboardDirection = 1, onPointerDown, onChange }) {
  const onKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onChange(clamp(value + (event.key === "ArrowRight" ? 16 : -16) * keyboardDirection, min, max));
  };
  return <div className={`panel-resizer ${className}`} role="separator" tabIndex="0" aria-label={label} aria-controls={controls} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} onPointerDown={onPointerDown} onKeyDown={onKeyDown}><span /></div>;
}

