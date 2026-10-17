import { useEffect, useMemo, useRef, useState } from "react";
import { workbenchApi } from "./api.js";
import { removeDeletedUploadStatuses } from "./attachment-state.js";
import { Icon } from "./icons.jsx";
import { projectFilePath } from "./project-file-reference.js";
import { isDirectAttachment, fileSpaceFor, fileSpaceKey, workspacePathFor } from "./workbench-helpers.js";
import { formatTime, MarkdownText } from "./workbench-timeline.jsx";

export function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

export function uploadStatusLabel(item) {
  if (item.status === "queued") return "等待上传";
  if (item.status === "uploading") return `${Math.round((item.loaded || 0) / Math.max(1, item.total || item.size || 1) * 100)}% · ${formatFileSize(item.loaded || 0)} / ${formatFileSize(item.total || item.size || 0)}`;
  if (item.status === "saving") return "100% · 正在保存到 NAS";
  if (item.status === "done") return "已保存";
  return item.error || "上传失败";
}

export function UploadQueue({ items, onCancel, onRetry }) {
  if (!items.length) return null;
  return <div className="upload-queue" aria-live="polite">{items.map((item) => <article className={item.status} key={item.id}><div><b title={item.name}>{item.name}</b><em>{uploadStatusLabel(item)}</em></div><progress max={Math.max(1, item.total || item.size || 1)} value={item.status === "done" || item.status === "saving" ? Math.max(1, item.total || item.size || 1) : item.loaded || 0} />{item.status === "error" ? <button onClick={() => onRetry(item.id)}>重试</button> : <button onClick={() => onCancel(item.id)}>{item.status === "done" ? "移除" : "取消"}</button>}</article>)}</div>;
}

export function assertSafeOoxmlArchive(buffer) {
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

export function FilePreviewContent({ preview }) {
  if (preview.kind === "markdown") return <div className="document-preview markdown-document"><MarkdownText text={preview.text} /></div>;
  if (preview.kind === "html") return <iframe className="html-preview" sandbox="" srcDoc={preview.text} title={`${preview.name} HTML 预览`} />;
  if (preview.kind === "text") return <pre>{preview.text}</pre>;
  if (preview.kind === "image") return <img src={preview.url} alt={preview.name} />;
  if (preview.kind === "pdf") return <iframe src={preview.url} title={preview.name} />;
  if (preview.kind === "docx") return <div className="document-preview"><MarkdownText text={preview.text || "文档中没有可提取的文字。"} /></div>;
  if (preview.kind === "xlsx") return <div className="spreadsheet-preview">{preview.truncated ? <p>表格较大，这里显示前 200 行、50 列。</p> : null}<table><tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, columnIndex) => <td key={columnIndex}>{value}</td>)}</tr>)}</tbody></table></div>;
  return <div className="preview-unsupported"><Icon name="paperclip" size={28} /><b>{preview.preview?.eligible === false && preview.preview?.maxBytes > 0 ? "文件太大，暂不在线预览" : "当前格式暂不在线预览"}</b><p>{preview.mimeType || preview.type || "未知格式"} · {formatFileSize(preview.size)}<br />仍可下载原文件，或把文件引用交给 Agent 按需读取。</p></div>;
}

export function FilePanel({ session, project, open, requestedFile, canAttach = true, onClose, onAttach, onDeleted, onActiveFileChange }) {
  const [directory, setDirectory] = useState("");
  const [listing, setListing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("recent");
  const inputRef = useRef(null);
  const uploadControllers = useRef(new Map());
  const cancelledUploads = useRef(new Set());
  const viewGeneration = useRef(0);
  const listRequest = useRef(0);
  const previewRequest = useRef(0);
  const defaultSpace = fileSpaceFor(session, project);
  const activeSpace = defaultSpace;
  const activeSpaceKey = fileSpaceKey(activeSpace);
  const projectNames = [project?.workspaceDirectory, project?.name].filter(Boolean);
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
      return nextListing;
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
    setUploads([]); setListing(null); setPreview(null); setDirectory(""); setQuery("");
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
      if (entry.preview?.eligible === false) { setPreview({ ...entry, kind: "unsupported" }); onActiveFileChange?.(entry.path); return; }
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
        onActiveFileChange?.(entry.path);
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
  useEffect(() => {
    const target = projectFilePath(requestedFile?.path, projectNames, { allowBare: true });
    if (!open || !target) return;
    const parent = target.split("/").slice(0, -1).join("/");
    let cancelled = false;
    void load(parent, activeSpace).then((nextListing) => {
      if (cancelled || !nextListing) return;
      const entry = nextListing.entries?.find((item) => item.type === "file" && item.path === target);
      if (entry) void openFile(entry);
      else setError(`没有找到项目文件：${target}。文件可能已移动或删除，已为你打开它原来所在的目录。`);
    });
    return () => { cancelled = true; };
  }, [requestedFile?.key, open, activeSpaceKey, projectNames.join("\u0000")]);
  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const entries = (listing?.entries || []).filter((entry) => {
      if (typeFilter === "folders" && entry.type !== "directory") return false;
      if (typeFilter === "files" && entry.type !== "file") return false;
      return !normalized || entry.name.toLocaleLowerCase("zh-CN").includes(normalized);
    });
    return entries.sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1;
      if (right.type === "directory" && left.type !== "directory") return 1;
      if (sortOrder === "name") return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
      return Number(right.modifiedAt || 0) - Number(left.modifiedAt || 0) || left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    });
  }, [listing?.entries, query, typeFilter, sortOrder]);
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
    <div className="file-findbar"><label><Icon name="search" size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前目录" aria-label="搜索当前目录文件" /></label><select aria-label="文件类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">全部类型</option><option value="folders">文件夹</option><option value="files">文件</option></select><select aria-label="文件排序" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}><option value="recent">最近修改</option><option value="name">名称</option></select><span>{visibleEntries.length} 项</span></div>
    <UploadQueue items={uploads} onCancel={cancelUpload} onRetry={retryUpload} />
    {error ? <div className="file-error">{error}</div> : null}
    <div className="file-layout"><div className="file-list" aria-busy={loading}>{loading && !listing ? <div className="panel-state">正在读取文件…</div> : visibleEntries.length ? visibleEntries.map((entry) => <div className={`file-row ${preview?.path === entry.path ? "selected" : ""}`} key={entry.path}><button disabled={entry.type === "symlink" || entry.type === "other"} onClick={() => entry.type === "directory" ? void load(entry.path) : void openFile(entry)}><Icon name={entry.type === "directory" ? "folder" : "paperclip"} /><span><strong title={entry.name}>{entry.name}</strong><small>{entry.type === "directory" ? "文件夹" : [formatFileSize(entry.size), entry.mimeType?.split("/").pop(), entry.modifiedAt ? formatTime(entry.modifiedAt) : ""].filter(Boolean).join(" · ")}</small></span><Icon name="chevron" size={15} /></button>{entry.type === "file" && isDirectAttachment(entry.path) ? <button className="file-delete" aria-label={`删除上传文件 ${entry.name}`} onClick={() => void deleteEntry(entry)}>删除</button> : null}</div>) : <div className="panel-state compact">{query ? "没有匹配的文件。" : "当前目录为空。"}</div>}</div><div className="file-preview">{preview ? <><div className="preview-heading"><div className="preview-file-identity"><strong title={preview.name}>{preview.name}</strong><small>{formatFileSize(preview.blob?.size ?? preview.size)} · {preview.path}</small></div><div className="preview-actions"><button className="preview-action preview-icon-action" aria-label={expanded ? "恢复文件面板大小" : "放大文件预览"} title={expanded ? "恢复大小" : "放大预览"} onClick={() => setExpanded((value) => !value)}><Icon name={expanded ? "minimize" : "maximize"} size={16} /></button><button className="preview-action preview-icon-action" aria-label="复制文件链接" title="复制工作台文件链接" onClick={() => void navigator.clipboard?.writeText(new URL(workbenchApi.fileUrl(activeSpace, preview.path, false, showHidden), window.location.href).href)}><Icon name="link" size={16} /></button><a className="preview-action" href={workbenchApi.fileUrl(activeSpace, preview.path, true, showHidden)} download={preview.name} aria-label={`下载 ${preview.name}`}><Icon name="download" size={16} /><span>下载</span></a>{canAttach ? <button className="preview-action preview-attach-action" onClick={attachPreview}><Icon name="paperclip" size={16} /><span>交给 Agent</span></button> : null}</div></div><FilePreviewContent preview={preview} /></> : <div className="preview-empty"><Icon name="folder" size={28} /><p>从左侧选择文件，即可在这里预览。</p><small>支持 Markdown、HTML、图片、PDF、DOCX 和 XLSX；其他文件仍可下载{canAttach ? "和交给 Agent" : ""}。</small></div>}</div></div>
  </section></div>;
}
