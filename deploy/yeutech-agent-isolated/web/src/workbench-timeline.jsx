import { useEffect, useState } from "react";
import { workbenchApi } from "./api.js";
import { Icon } from "./icons.jsx";
import { parseMarkdownBlocks } from "./markdown-parser.js";
import { normalizeProjectFileReferences, projectFilePath } from "./project-file-reference.js";
import { YeutechMark } from "./workbench-primitives.jsx";
import { formatFileSize } from "./workbench-files.jsx";

export function formatTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function inlineMarkdown(text, onOpenFile, projectName = "") {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  return String(text || "").split(pattern).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) {
      const value = part.slice(1, -1);
      const path = projectFilePath(value, projectName);
      return path && onOpenFile ? <button className="inline-file-link" key={index} onClick={() => onOpenFile(path)} title="在项目文件中打开"><Icon name="paperclip" size={12} />{value}</button> : <code key={index}>{value}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const destination = link[2].replace(/^<|>$/g, "");
      const filePath = projectFilePath(destination, projectName, { allowBare: true });
      if (filePath && onOpenFile) return <button className="inline-file-link" key={index} onClick={() => onOpenFile(filePath)} title="在项目文件中打开"><Icon name="paperclip" size={12} />{link[1]}</button>;
      const href = /^(https?:\/\/|\/)/i.test(destination) ? destination : "";
      return href ? <a key={index} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{link[1]}</a> : <span key={index}>{link[1]} <code>{link[2]}</code></span>;
    }
    return part;
  });
}

export function FileReference({ path, onOpenFile }) {
  const fileName = path.split("/").filter(Boolean).at(-1) || "项目文件";
  return <button className="file-reference" title="在当前项目文件中打开" onClick={() => onOpenFile?.(path)}><Icon name="folder" /><span><strong>{fileName}</strong><small>{path}</small></span><em>打开</em></button>;
}

export function MarkdownText({ text, onOpenFile, projectName = "" }) {
  const blocks = parseMarkdownBlocks(normalizeProjectFileReferences(text, projectName));
  const renderLines = (lines) => lines.map((line, index) => <span key={index}>{inlineMarkdown(line, onOpenFile, projectName)}{index < lines.length - 1 ? <br /> : null}</span>);
  return <div className="markdown-content">{blocks.map((block, index) => {
    if (block.type === "paragraph") return <p key={`p-${index}`}>{renderLines(block.lines)}</p>;
    if (block.type === "heading") { const Tag = `h${Math.min(5, block.level + 2)}`; return <Tag key={`h-${index}`}>{inlineMarkdown(block.text, onOpenFile, projectName)}</Tag>; }
    if (block.type === "hr") return <hr key={`hr-${index}`} />;
    if (block.type === "code") return <pre key={`code-${index}`}><code>{block.code}</code></pre>;
    if (block.type === "blockquote") return <blockquote key={`quote-${index}`}>{renderLines(block.lines)}</blockquote>;
    if (block.type === "list-item") return <div className="markdown-list-row" style={{ marginLeft: Math.min(block.indent, 48) }} key={`li-${index}`}><span>{block.marker}</span><p>{inlineMarkdown(block.text, onOpenFile, projectName)}</p></div>;
    if (block.type === "table") return <div className="markdown-table-wrap" key={`table-${index}`}><table><thead><tr>{block.headers.map((header, cell) => <th key={cell} style={{ textAlign: block.alignments[cell] }}>{inlineMarkdown(header, onOpenFile, projectName)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.headers.map((_, cell) => <td key={cell} style={{ textAlign: block.alignments[cell] }}>{inlineMarkdown(row[cell] || "", onOpenFile, projectName)}</td>)}</tr>)}</tbody></table></div>;
    if (block.type === "citation-line") {
      const citationPattern = /:codex-file-citation\{([^}]*)\}/g;
      const nodes = [];
      let cursor = 0;
      let match;
      while ((match = citationPattern.exec(block.line))) {
        const prefix = block.line.slice(cursor, match.index).trim();
        if (prefix) nodes.push(<p key={`p-${index}-${cursor}`}>{inlineMarkdown(prefix, onOpenFile, projectName)}</p>);
        const citationPath = match[1].match(/(?:^|\s)path="([^"]+)"/)?.[1];
        if (citationPath) nodes.push(<FileReference path={citationPath} onOpenFile={onOpenFile} key={`file-${index}-${cursor}`} />);
        cursor = match.index + match[0].length;
      }
      const suffix = block.line.slice(cursor).trim();
      if (suffix) nodes.push(<p key={`p-${index}-end`}>{inlineMarkdown(suffix, onOpenFile, projectName)}</p>);
      return nodes;
    }
    return null;
  })}</div>;
}

export function Activity({ running, status }) {
  if (!running && !status) return null;
  return <div className="activity"><span className={running ? "activity-spinner" : "activity-check"}>{running ? null : <Icon name="check" size={14} />}</span><div><strong>{running ? "Agent 正在执行" : "状态已更新"}</strong><p>{status}</p></div></div>;
}

export function PermissionCard({ request, onReply }) {
  const detail = request.patterns?.join("\n") || "Agent 请求执行受保护的操作";
  return <section className="permission-card" aria-label="待审批操作"><div><span className="permission-badge">需要确认</span><strong>{request.permission === "bash" ? "运行命令" : `使用 ${request.permission} 工具`}</strong><pre>{detail}</pre><small>仅限当前用户的项目工作区；工作区外访问始终禁止。</small></div><div className="permission-actions"><button className="permission-reject" onClick={() => onReply(request.id, "reject")}>拒绝</button><button className="permission-allow" onClick={() => onReply(request.id, "once")}>仅本次允许</button><button className="permission-always" onClick={() => onReply(request.id, "always")}>本任务全部允许</button></div></section>;
}

const TOOL_LABELS = {
  bash: "运行命令", read: "读取文件", glob: "查找文件", grep: "搜索内容", list: "查看目录",
  write: "写入文件", edit: "修改文件", patch: "修改文件", todowrite: "更新任务清单", task: "启动子任务",
  webfetch: "读取网页", websearch: "搜索网页",
};

export function oneLine(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function toolSummary(item) {
  if (item.type === "subagent") return item.session?.title || "子 Agent";
  const input = item.input || {};
  const tool = String(item.tool || "tool").toLowerCase();
  const target = input.filePath || input.path || input.pattern || input.query || input.url || input.description;
  if (tool === "bash") return oneLine(input.description || item.title || input.command) || "运行 Shell 命令";
  if (tool === "todowrite" && Array.isArray(input.todos)) return `更新 ${input.todos.length} 项任务`;
  return oneLine(target || item.title) || TOOL_LABELS[tool] || item.tool || "Agent 操作";
}

export function toolStatus(item) {
  if (item.error || new Set(["error", "failed"]).has(item.status)) return "失败";
  if (item.status === "completed") return "已完成";
  if (item.status === "pending") return "等待执行";
  return "正在执行";
}

export function TimelineTool({ item }) {
  const [fullResult, setFullResult] = useState(null);
  const [loadingResult, setLoadingResult] = useState(false);
  const [resultError, setResultError] = useState("");
  if (item.type === "subagent") return <article className={`timeline-tool ${item.status || "running"}`}><span className={item.status === "completed" ? "activity-check" : "activity-spinner"}>{item.status === "completed" ? <Icon name="check" size={13} /> : null}</span><div><strong>{item.session?.title || "子 Agent"}</strong><small>{item.session?.status || "正在执行"}</small></div></article>;
  const status = toolStatus(item);
  const failed = status === "失败";
  const hasDetails = Boolean(item.inputPreview || item.result?.inline || item.result?.preview || item.result?.reference || item.error);
  const loadFullResult = async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!item.result?.reference || loadingResult) return;
    setLoadingResult(true); setResultError("");
    try { setFullResult(await workbenchApi.toolResult(item.result.reference)); }
    catch (cause) { setResultError(cause instanceof Error ? cause.message : "读取完整结果失败"); }
    finally { setLoadingResult(false); }
  };
  const body = <><span className={item.status === "completed" ? "activity-check" : failed ? "activity-error" : "activity-spinner"}>{item.status === "completed" ? <Icon name="check" size={13} /> : failed ? <Icon name="warning" size={13} /> : null}</span><div className="timeline-tool-heading"><strong>{TOOL_LABELS[String(item.tool || "").toLowerCase()] || `工具 · ${item.tool || "Agent"}`}</strong><small>{toolSummary(item)}</small></div><em>{status}{Number.isFinite(item.durationMs) ? ` · ${(item.durationMs / 1000).toFixed(item.durationMs < 10_000 ? 1 : 0)} 秒` : ""}</em></>;
  if (!hasDetails) return <article className={`timeline-tool ${item.status || "running"}`}>{body}</article>;
  return <details className={`timeline-tool tool-details ${item.status || "running"}`}><summary>{body}<Icon name="chevron" size={14} /></summary><div className="timeline-tool-content">{item.inputPreview ? <section><b>操作内容</b><pre>{item.inputPreview}{item.inputTruncated ? "\n…已截断" : ""}</pre></section> : null}{item.error ? <section className="tool-error-detail"><b>错误原因</b><pre>{item.error.message}</pre></section> : null}{item.result ? <section><b>运行结果</b><pre>{typeof fullResult === "string" ? fullResult : fullResult ? JSON.stringify(fullResult, null, 2) : item.result.inline || item.result.preview || "结果已记录"}</pre>{item.result.reference && fullResult === null ? <button onClick={loadFullResult} disabled={loadingResult}>{loadingResult ? "正在读取…" : `查看完整结果（${item.result.length || 0} 字符）`}</button> : null}{resultError ? <small className="tool-result-error">{resultError}</small> : null}</section> : null}</div></details>;
}

export function TimelineItem({ item, running, onPermissionReply, onOpenFile, projectName }) {
  if (item.kind === "permission") return <PermissionCard request={item.value} onReply={onPermissionReply} />;
  if (item.kind === "tool") return <TimelineTool item={item.value} />;
  const message = item.value;
  if (item.kind === "reasoning") return <article className="message-block assistant reasoning-event"><div className="message assistant"><div className="assistant-mark"><YeutechMark /></div><div className="assistant-body"><details className="reasoning-panel" open={running && !message.text}><summary>{running && !message.text ? "正在思考" : "查看思考过程"}</summary><MarkdownText text={message.reasoning} onOpenFile={onOpenFile} projectName={projectName} /></details></div></div></article>;
  if (message.role === "user") return <article className="message-block user"><div className="message user"><div className="user-bubble"><MarkdownText text={message.text} onOpenFile={onOpenFile} projectName={projectName} />{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => <span key={attachment.workspacePath || attachment.path}><Icon name="paperclip" size={12} />{attachment.workspacePath || attachment.name || attachment.path}</span>)}</div> : null}{message.queue ? <small className="message-queue-state">{message.queue.status === "submitting" ? "正在提交" : `待执行·第 ${message.queue.position} 条`}</small> : null}</div><time>{formatTime(message.createdAt)}</time></div></article>;
  const waiting = !message.text && running;
  const fallback = message.error?.message || (waiting ? "正在准备回复…" : "本轮未返回正文");
  return <article className={`message-block assistant${message.error ? " error" : ""}${message.segment ? " progress-segment" : ""}`}><div className="message assistant"><div className="assistant-mark"><YeutechMark /></div><div className="assistant-body"><MarkdownText text={message.text || fallback} onOpenFile={onOpenFile} projectName={projectName} />{message.segment ? null : <footer><span />{message.error ? "本轮失败" : message.text ? "本轮已结束" : waiting ? "正在回复" : "本轮未返回正文"}{message.createdAt ? <><b>·</b><time>{formatTime(message.createdAt)}</time></> : null}</footer>}</div></div></article>;
}

export function ImageArtifacts({ artifacts = [], onOpenFiles }) {
  if (!artifacts.length) return null;
  return <section className="image-artifacts" aria-label="本会话生成的图片"><header><div><strong>生成的图片</strong><small>已保存到当前项目的产出目录</small></div><button onClick={onOpenFiles}>在文件中查看</button></header><div>{artifacts.map((artifact) => <article key={artifact.id}><img src={workbenchApi.fileUrl(artifact.space, artifact.path, false, false)} alt={artifact.prompt || artifact.name} loading="lazy" /><footer><span><b>{artifact.name}</b><small>{[artifact.model, artifact.width && artifact.height ? `${artifact.width}×${artifact.height}` : null, formatFileSize(artifact.size)].filter(Boolean).join(" · ")}</small></span><a href={workbenchApi.fileUrl(artifact.space, artifact.path, true, false)} download={artifact.name}>下载</a></footer></article>)}</div></section>;
}

export function activityTitle(item) {
  if (item.type === "tool") return `工具 · ${item.tool || "tool"}`;
  if (item.type === "subagent") return `子任务 · ${item.session?.title || item.session?.id || "subagent"}`;
  return `${item.message?.role === "user" ? "用户" : "Agent"} 消息`;
}

export function AgentConsole({ insight, hasRuntime, running, onOpen, onCapabilities, onSummarize }) {
  const stats = insight.stats || {};
  const stateLabel = !hasRuntime ? "发送消息后开始" : running ? "Agent 正在继续处理" : "可继续对话";
  return <section className="agent-console" aria-label="任务状态概览"><div className="agent-console-title"><span className={`console-state ${running ? "running" : hasRuntime ? "ready" : "waiting"}`} /><div><strong>{running ? "正在处理" : hasRuntime ? "当前会话已就绪" : "尚未开始"}</strong><small>{stateLabel}</small></div></div><div className="console-metrics"><span><b>{stats.turns || 0}</b> 轮对话</span><span>{running ? "任务未结束" : hasRuntime ? "状态已同步" : "暂无运行记录"}</span></div><div className="console-actions"><button className="console-primary" onClick={onOpen}>查看任务状态</button><button onClick={onCapabilities}>模型与技能</button>{hasRuntime ? <button disabled={insight?.summarizing} onClick={onSummarize}>{insight?.summarizing ? "正在整理…" : "整理长对话"}</button> : null}</div></section>;
}

export function diffRows(item) {
  const patch = item.patch || item.diff;
  if (typeof patch === "string" && patch.trim()) return patch.split("\n");
  const before = typeof item.before === "string" ? item.before.split("\n") : [];
  const after = typeof item.after === "string" ? item.after.split("\n") : [];
  if (!before.length) return after.map((line) => `+${line}`);
  if (!after.length) return before.map((line) => `-${line}`);
  return [...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)];
}

export function DiffPanel({ open, loading, error, items, session, onClose, onRetry }) {
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
