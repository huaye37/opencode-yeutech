import { useEffect, useState } from "react";
import { workbenchApi } from "./api.js";
import { Icon } from "./icons.jsx";
import { activityTitle } from "./workbench-timeline.jsx";

export function ProjectDiscoveryDialog({ open, projects, busyProjectId, error, onClose, onRegister, onRescan }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭 NAS 项目发现" onClick={onClose} /><section className="capability-center discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="discovery-title"><header><div><span className="panel-kicker">NAS DISCOVERY</span><h2 id="discovery-title">发现 NAS 项目</h2><p>这里只列出尚未登记的目录；接入后才会出现在项目树中。</p></div><button className="panel-close" aria-label="关闭 NAS 项目发现" onClick={onClose}>×</button></header><div className="discovery-body">{error ? <div className="file-error">{error}</div> : null}{projects.length ? <div className="discovery-list">{projects.map((item) => <article key={item.id || item.workspaceDirectory || item.name}><Icon name="folderIn" /><span><b>{item.name}</b><small>{item.workspaceDirectory || "NAS 工作区目录"}</small></span><button disabled={Boolean(busyProjectId)} onClick={() => onRegister(item)}>{busyProjectId === (item.id || item.workspaceDirectory) ? "正在接入…" : "接入项目"}</button></article>)}</div> : <div className="discovery-empty"><Icon name="check" /><b>没有待接入的 NAS 目录</b><p>已登记项目不会重复显示。</p></div>}<div className="dialog-actions"><button onClick={onRescan}><Icon name="refresh" size={15} />重新扫描</button><button className="console-primary" onClick={onClose}>完成</button></div></div></section></div>;
}

export function ProjectDialog({ open, busy, error, onClose, onCreate }) {
  const [name, setName] = useState("");
  useEffect(() => { if (!open) { setName(""); } }, [open]);
  if (!open) return null;
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭新建项目" onClick={onClose} /><section className="capability-center project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title"><header><div><span className="panel-kicker">NAS PROJECT</span><h2 id="project-dialog-title">新建项目</h2><p>项目会创建在你自己的 NAS 工作区，并自动建立独立项目标识。</p></div><button className="panel-close" aria-label="关闭新建项目" onClick={onClose}>×</button></header><div className="project-dialog-body"><label>项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) void onCreate(name.trim()); }} placeholder="例如：家庭网络优化" /></label>{error ? <div className="file-error">{error}</div> : null}<div className="dialog-actions"><button onClick={onClose}>取消</button><button className="console-primary" disabled={busy || !name.trim()} onClick={() => void onCreate(name.trim())}>{busy ? "正在创建…" : "创建并进入"}</button></div></div></section></div>;
}

export function CapabilityCenter({ open, loading, error, profiles, skills, skillReport, models, onClose, onRetry }) {
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

export function PluginCenter({ open, loading, error, plugins, project, onClose, onRetry, onChange }) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  if (!open) return null;
  const installed = plugins.filter((plugin) => plugin.installed).length;
  const enabled = plugins.filter((plugin) => plugin.enabled).length;
  return <div className="capability-layer" role="presentation"><button className="capability-scrim" aria-label="关闭插件中心" onClick={onClose} /><section className="capability-center plugin-center" role="dialog" aria-modal="true" aria-labelledby="plugin-center-title">
    <header><div><span className="panel-kicker">YEUTECH PLUGINS</span><h2 id="plugin-center-title">插件中心</h2><p>{project ? `当前配置作用于“${project.name}”；未单独设置的插件继承工作台配置。` : "工作台默认插件会装载到所有会话；项目可以覆盖可选插件。"}</p></div><button className="panel-close" aria-label="关闭插件中心" onClick={onClose}>×</button></header>
    <div className="capability-summary"><span><strong>{plugins.length}</strong> 已收录</span><span><strong>{installed}</strong> 已安装</span><span><strong>{enabled}</strong> 已启用</span></div>
    {loading ? <div className="panel-state"><span className="activity-spinner" />正在读取插件状态…</div> : error ? <div className="panel-state error"><p>{error}</p><button onClick={onRetry}>重试</button></div> : <div className="capability-content"><section className="capability-section"><div className="section-heading"><h3>默认装载能力</h3><span>核心插件不可关闭，可选插件按工作台或项目配置</span></div><div className="plugin-grid">{plugins.map((plugin) => <article key={plugin.id} className={plugin.enabled ? "enabled" : "disabled"}><div className="plugin-card-head"><span className={`skill-status ${plugin.enabled ? "available" : ""}`} /><div><strong>{plugin.name}</strong><small>{plugin.source} · {plugin.version} · {plugin.runtime}</small></div><em>{plugin.required ? "系统内置" : plugin.installed ? plugin.enabled ? "已启用" : "已停用" : "未安装"}</em></div><p>{plugin.description}</p><div className="plugin-tags">{plugin.tools.map((tool) => <code key={tool}>{tool}</code>)}</div><details><summary>权限与技术信息</summary><small>{plugin.permissions.join(" · ") || "无额外权限"}</small><code>{plugin.id}</code></details>{plugin.configurable ? <div className="plugin-actions">{plugin.installed ? <><button onClick={() => onChange(plugin, { enabled: !plugin.enabled })}>{plugin.enabled ? "停用" : "启用"}</button><button className="danger" onClick={() => onChange(plugin, { installed: false })}>卸载</button></> : <button className="console-primary" onClick={() => onChange(plugin, { installed: true, enabled: true })}>安装并启用</button>}</div> : <div className="plugin-locked">所有会话默认装载</div>}</article>)}</div></section></div>}
  </section></div>;
}

export function ChildTree({ nodes = [], root = true }) {
  if (!nodes.length) return root ? <p className="honest-empty">本会话未报告 Worker 子会话。</p> : null;
  return <ul className="control-tree">{nodes.map((node) => <li key={node.id}><span><b>{node.title}</b><em>{node.status}</em></span><ChildTree nodes={node.children} root={false} /></li>)}</ul>;
}

export function ControlCenter({ open, onClose, project, session, runtimeSessionId, insight, attachments, hasRuntime, model }) {
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
      <section className="control-wide"><div className="control-section-heading"><span>最近操作</span><em>{latestActivities.length ? `最近 ${latestActivities.length} 条` : "暂无"}</em></div>{latestActivities.length ? <div className="trajectory-list simple">{latestActivities.map((item) => <article key={`${item.id}:${item.ordinal}`}><span>{item.ordinal}</span><div><b>{activityTitle(item).replace("工具 · ", "执行：").replace("子任务 · ", "分项任务：")}</b><small>{item.error?.message || (item.status === "completed" ? "已完成" : item.status === "running" ? "进行中" : item.status || "已记录")}</small></div></article>)}</div> : <p className="honest-empty">发送消息后，这里会显示最近的读取、修改和检查操作。</p>}</section>
      <details className="control-advanced control-wide"><summary>高级信息 <span>面向排障与性能分析</span></summary><div className="advanced-grid"><section><b>运行容量</b><p>{budget ? `${budget.requestedInteractiveWorkers} / ${budget.maxInteractiveWorkers} 个执行位` : "暂无数据"}</p></section><section><b>上下文</b><p>{hasRuntime ? `${insight?.context?.messageCount || 0} 条消息 · ${tokenSummary}` : "暂无运行数据"}</p></section><section><b>交付记录</b><p>{evidenceLabel}</p></section><section><b>项目文件校验</b><p>{attachments.length ? `已附加 ${attachments.length} 个文件` : insight?.executionContextReceipt ? `本轮已应用 ${insight.executionContextReceipt.sources?.length || 0} 个来源` : "未附加文件"}</p><button disabled={!project || !attachments.length} onClick={() => void makePack()}>校验当前文件</button>{contextPack ? <code className="hash-code">{contextPack.hash}</code> : null}</section><section><b>回放实验室</b><p>{replay?.status ? `隔离回放：${replay.status}` : replay?.metrics ? Object.entries(replay.metrics).map(([key, value]) => `${key}: ${value.delta}`).join("；") : "在隔离目录真实重放最近一轮"}</p><button disabled={!hasRuntime || !model || new Set(["queued", "running"]).has(replay?.status)} onClick={() => void executeReplay()}>执行安全回放</button></section><section><b>分项任务</b><ChildTree nodes={insight?.childTree || []} /></section></div></details>
    </div>}
  </section></div>;
}
