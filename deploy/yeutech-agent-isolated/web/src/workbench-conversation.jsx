import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { workbenchApi } from "./api.js";
import { Icon } from "./icons.jsx";
import { trajectoryForVisibleMessages } from "./message-projection.js";
import { isNearMessageBottom, scrollTopAfterPrepend } from "./message-scroll.js";
import { fileSpaceFor, fileSpaceKey } from "./workbench-helpers.js";
import { YeutechMark } from "./workbench-primitives.jsx";
import { MarkdownText, Activity, TimelineItem, ImageArtifacts, AgentConsole } from "./workbench-timeline.jsx";
import { UploadQueue } from "./workbench-files.jsx";

export function Conversation({ session, project, messages, permissions, insight, hasRuntime, attachments, olderCursor, loadingOlder, models, model, permissionMode, reasoningEffort, serviceTier, onReasoningEffortChange, onServiceTierChange, running, stopping, status, bootstrapping, bootstrapError, focusMode, sidebarCollapsed, onLoadOlder, onModelChange, onPermissionModeChange, onSend, onStop, onAttach, onRemoveAttachment, onOpenControl, onOpenCapabilities, onPanoramaOpen, onPermissionReply, onExport, onOpenFiles, onOpenDiff, onOpenSidebar, onExpandSidebar, onToggleFocus }) {
  const projectName = project?.name;
  const projectNames = [project?.workspaceDirectory, project?.name].filter(Boolean);
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
  const composingRef = useRef(false);
  const suppressImeEnterUntilRef = useRef(0);
  const submittedDraftRef = useRef("");
  const suppressSubmittedInputUntilRef = useRef(0);
  const renderedSessionRef = useRef(null);
  const initialBottomPinUntilRef = useRef(0);
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
    if (sessionChanged) {
      loadingOlderRef.current = false;
      userScrollIntentRef.current = false;
      nearMessageBottomRef.current = true;
      initialBottomPinUntilRef.current = performance.now() + 5_000;
    }
    if (!sessionChanged && !nearMessageBottomRef.current) return;
    let secondFrame;
    const timers = [];
    const pinToBottom = () => {
      if (loadingOlderRef.current || userScrollIntentRef.current || performance.now() > initialBottomPinUntilRef.current) return;
      target.scrollTop = target.scrollHeight;
      nearMessageBottomRef.current = true;
    };
    pinToBottom();
    const firstFrame = window.requestAnimationFrame(() => {
      pinToBottom();
      secondFrame = window.requestAnimationFrame(pinToBottom);
    });
    for (const delay of [100, 350, 900, 1_800, 3_500]) timers.push(window.setTimeout(pinToBottom, delay));
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [session?.id, bootstrapping, lastMessageID, lastMessageLength]);
  useLayoutEffect(() => {
    const target = messagesRef.current;
    if (!target) return undefined;
    let frame;
    const pinIfFollowingLatest = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!loadingOlderRef.current && nearMessageBottomRef.current) target.scrollTop = target.scrollHeight;
      });
    };
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pinIfFollowingLatest);
    const observeChildren = () => sizes && [...target.children].forEach((child) => sizes.observe(child));
    observeChildren();
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => { observeChildren(); pinIfFollowingLatest(); });
    mutations?.observe(target, { childList: true, subtree: true, characterData: true });
    return () => {
      window.cancelAnimationFrame(frame);
      mutations?.disconnect();
      sizes?.disconnect();
    };
  }, [session?.id]);
  const loadOlderWithoutJump = async () => {
    const target = messagesRef.current;
    if (!target || loadingOlderRef.current || loadingOlder || !olderCursor) return;
    loadingOlderRef.current = true;
    userScrollIntentRef.current = true;
    nearMessageBottomRef.current = false;
    const previousHeight = target.scrollHeight;
    const previousTop = target.scrollTop;
    const ownerSessionID = session?.id;
    let anchorScheduled = false;
    try {
      await onLoadOlder();
      anchorScheduled = true;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const current = messagesRef.current;
        if (current && renderedSessionRef.current === ownerSessionID) current.scrollTop = scrollTopAfterPrepend(previousTop, previousHeight, current.scrollHeight);
        loadingOlderRef.current = false;
      }));
    } finally { if (!anchorScheduled) loadingOlderRef.current = false; }
  };
  const handleMessageScroll = (event) => {
    const target = event.currentTarget;
    if (loadingOlderRef.current) return;
    nearMessageBottomRef.current = isNearMessageBottom(target);
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
    submittedDraftRef.current = value;
    suppressSubmittedInputUntilRef.current = performance.now() + 300;
    setDraft("");
    window.requestAnimationFrame(() => setDraft(""));
    nearMessageBottomRef.current = true;
    const sent = await onSend(value, attachments);
    if (sent) setUploads([]);
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
  const timeline = useMemo(() => {
    const items = [];
    for (const message of messages) {
      if (message.role === "user") {
        items.push({ key: `message:${message.id}`, kind: "message", at: Number(message.createdAt || 0), value: message });
        continue;
      }
      const segments = Array.isArray(message.segments) ? message.segments.filter((segment) => segment?.text) : [];
      if (segments.length) {
        for (const segment of segments) {
          const at = Number(segment.at || message.createdAt || 0);
          const value = segment.type === "reasoning"
            ? { ...message, text: "", reasoning: segment.text, segment: true, createdAt: at }
            : { ...message, text: segment.text, reasoning: "", segment: true, createdAt: at };
          items.push({ key: `segment:${message.id}:${segment.id}`, kind: segment.type === "reasoning" ? "reasoning" : "message", at, value });
        }
        if (message.error) items.push({ key: `message-error:${message.id}`, kind: "message", at: Number(message.completedAt || message.createdAt || 0), value: { ...message, text: "", reasoning: "", segments: [] } });
      } else {
        if (message.reasoning) items.push({ key: `reasoning:${message.id}`, kind: "reasoning", at: Number(message.createdAt || 0), value: message });
        if (message.text || message.error || !message.reasoning) items.push({ key: `message:${message.id}`, kind: "message", at: Number(message.completedAt || message.streamUpdatedAt || message.createdAt || 0), value: message });
      }
    }
    for (const item of trajectoryForVisibleMessages(insight?.trajectory || [], messages)) {
      items.push({ key: `activity:${item.id}`, kind: "tool", at: Number(item.at || item.createdAt || 0), value: item });
    }
    for (const request of permissions) items.push({ key: `permission:${request.id}`, kind: "permission", at: Number(request.createdAt || request.time?.created || Date.now()), value: request });
    return items.sort((left, right) => left.at - right.at || left.key.localeCompare(right.key));
  }, [messages, permissions, insight?.trajectory]);
  if (bootstrapping) return <section className="conversation empty-workbench loading-workbench" role="status"><div className="loading-orbit" /><strong>正在加载你的工作区</strong><span>正在同步模型、会话和 NAS 项目，请稍候…</span></section>;
  if (!session && bootstrapError) return <section className="conversation empty-workbench error-workbench"><div className="empty-icon"><Icon name="warning" size={23} /></div><strong>工作区加载失败</strong><span>{bootstrapError} 请点击右上角“刷新状态”重试。</span></section>;
  if (!session) return <section className="conversation empty-workbench"><div className="empty-icon"><Icon name="chatPlus" size={23} /></div><strong>创建会话，开始一个任务</strong><span>使用左上角菜单新建独立会话、创建项目，或接入已有 NAS 项目。</span></section>;
  return <section className="conversation"><header className="conversation-header"><button className="icon-button mobile-menu-button" aria-label="打开会话与项目" onClick={onOpenSidebar}><Icon name="menu" /></button>{sidebarCollapsed && !focusMode ? <button className="icon-button desktop-expand-button" aria-label="展开项目栏" onClick={onExpandSidebar}><Icon name="panel" /></button> : null}<div className="agent-logo"><YeutechMark /></div><div className="conversation-title"><small>{projectName || "独立会话"}{projectName ? <><Icon name="chevron" size={11} />项目会话</> : null}</small><h2>{session.title || "新会话"}</h2></div><button className="header-files-button" aria-label="查看当前会话的文件变更" title={hasRuntime ? "查看当前会话修改过的文件" : "此历史会话没有可用的文件变更记录"} disabled={!hasRuntime} onClick={onOpenDiff}><Icon name="edit" /><span>变更</span></button><button className="header-console-button" aria-haspopup="dialog" onClick={onOpenControl}><Icon name="shield" />Agent 控制台</button><button className="icon-button" aria-label="导出当前会话" onClick={onExport}><Icon name="download" /></button><button className="icon-button" aria-label={focusMode ? "退出专注模式" : "进入专注模式"} onClick={onToggleFocus}><Icon name={focusMode ? "minimize" : "maximize"} /></button><button className="header-files-button" aria-label="打开文件与附件" title="浏览、上传并附加文件" onClick={onOpenFiles}><Icon name="folder" /><span>文件</span></button></header>
    <AgentConsole insight={insight || {}} hasRuntime={hasRuntime} running={running} onOpen={onOpenControl} onCapabilities={onOpenCapabilities} onSummarize={() => onPanoramaOpen("summarize")} />
    <div className="messages" ref={messagesRef} onScroll={handleMessageScroll} onPointerDown={() => { userScrollIntentRef.current = true; initialBottomPinUntilRef.current = 0; }} onWheel={() => { userScrollIntentRef.current = true; initialBottomPinUntilRef.current = 0; }} onTouchStart={() => { userScrollIntentRef.current = true; initialBottomPinUntilRef.current = 0; }}>{timeline.length === 0 ? insight?.session?.error ? <article className="message-block assistant error"><div className="message assistant"><div className="assistant-mark"><YeutechMark /></div><div className="assistant-body"><MarkdownText text={insight.session.error.message} /><footer><span />本轮失败</footer></div></div></article> : <div className="empty-conversation"><div className="empty-icon"><Icon name="chatPlus" size={22} /></div><strong>开始会话</strong><span>{projectName ? "当前内容保存在这个项目中。" : "文件统一保存在你的“独立会话”文件夹中。"}</span></div> : <>{olderCursor ? <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlderWithoutJump()}>{loadingOlder ? "正在读取…" : "向上滚动继续加载"}</button> : null}<Activity running={running} status={status} />{timeline.map((item) => <TimelineItem key={item.key} item={item} running={running} onPermissionReply={onPermissionReply} onOpenFile={onOpenFiles} projectName={projectNames} />)}<ImageArtifacts artifacts={insight?.artifacts} onOpenFiles={onOpenFiles} /></>}</div>
    <div className={`composer-wrap ${dragActive ? "drag-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }} onDrop={dropFiles}>
      <div className="composer-upload-queue"><UploadQueue items={uploads} onCancel={cancelUpload} onRetry={retryUpload} /></div>
      {attachments.length ? <div className="attached-files" aria-label="已附加文件">{attachments.map((item) => <span key={item.workspacePath || `${fileSpaceKey(item.space)}:${item.path}`}><Icon name="paperclip" size={13} /><b>{item.workspacePath || item.path}</b><button aria-label={`从本轮移除引用 ${item.name || item.path}`} onClick={() => void onRemoveAttachment(item)}>×</button></span>)}</div> : null}
      <div className="composer glass-control">
        {dragActive ? <div className="composer-drop-hint">松开即上传到当前会话</div> : null}
        <textarea aria-label="向 Agent 发送消息" value={draft} onChange={(event) => { const next = event.target.value; if (performance.now() < suppressSubmittedInputUntilRef.current && next.trim() === submittedDraftRef.current) return; setDraft(next); }} onPaste={pasteFiles} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; suppressImeEnterUntilRef.current = performance.now() + 120; }} onKeyDown={(event) => { const imeConfirming = composingRef.current || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || performance.now() < suppressImeEnterUntilRef.current; if (event.key === "Enter" && !event.shiftKey && !imeConfirming) { event.preventDefault(); void submit(); } }} placeholder={running ? "输入补充要求，发送后继续当前任务…" : "描述任务，或拖入、粘贴、选择任意文件…"} />
        <div className="composer-tools">
          <input ref={uploadRef} type="file" multiple hidden onChange={quickUpload} />
          <button className="add-file-button" aria-label="添加文件" title={projectName ? "上传到当前项目" : "上传到本独立会话的受控附件目录"} onClick={() => uploadRef.current?.click()}><Icon name="plus" /><span>添加文件</span></button>
          <span className="attachment-label"><Icon name="paperclip" size={14} />{attachments.length ? `${attachments.length} 个附件` : projectName ? "当前项目" : "独立会话文件夹"}</span>
          <select aria-label="当前会话模型" value={model} onChange={(event) => onModelChange(event.target.value)}>{models.length ? models.map((item) => <option value={item.id} key={item.id} disabled={!item.selectable}>{item.name}{item.selectable ? "" : ` · ${item.disabledReason || "暂不可用"}`}</option>) : <option value="">正在读取模型…</option>}</select>
          <select aria-label="推理强度" value={reasoningEffort} disabled={!models.find(item => item.id === model)?.reasoningEfforts?.length} onChange={event => onReasoningEffortChange(event.target.value)}><option value="">模型默认</option>{(models.find(item => item.id === model)?.reasoningEfforts || []).map(level => <option key={level} value={level}>{({minimal:"最少",low:"低",medium:"中",high:"高",xhigh:"超高",max:"最大",ultra:"极高"})[level] || level}</option>)}</select>
          <select aria-label="响应速度" value={serviceTier} disabled={!models.find(item => item.id === model)?.serviceTiers?.length} onChange={event => onServiceTierChange(event.target.value)}><option value="">标准</option>{(models.find(item => item.id === model)?.serviceTiers || []).map(tier => <option key={tier} value={tier}>{tier === "ultrafast" ? "Ultrafast" : "Fast"}</option>)}</select>
          <select aria-label="权限模式" value={permissionMode} onChange={(event) => onPermissionModeChange(event.target.value)} title="控制 Agent 在当前用户工作区内的操作审批"><option value="ask">请求批准</option><option value="smart">帮我批准</option><option value="full">完全访问</option></select>
          <div className="composer-spacer" />
          {selectedCapability && !selectedCapability.selectable ? <span className="model-warning" title={selectedCapability.disabledReason}>能力待补全</span> : null}
          {running ? <button className="tool-button stop" aria-label={stopping ? "正在停止" : "停止"} title={stopping ? "正在等待 Agent 确认停止" : "停止当前执行"} disabled={stopping} onClick={onStop}>{stopping ? <span className="button-spinner" /> : <Icon name="stop" />}</button> : null}
          <button className="send-button" aria-label="发送" disabled={!canSend} title={hasPendingUploads ? "附件上传完成后可发送" : hasFailedUploads ? "请先重试或移除上传失败的文件" : !modelCanSend ? "当前没有能力完整的可用模型" : hasContent ? "发送" : "输入内容或添加文件"} onClick={() => void submit()}><Icon name="arrowUp" /></button>
        </div>
      </div>
    </div>
  </section>;
}

