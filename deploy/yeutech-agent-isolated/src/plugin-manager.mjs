import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const BUILTIN_PLUGINS = Object.freeze([
  { id: "yeutech.plugin-manager", name: "插件管理", description: "统一展示、安装和配置工作台扩展能力。", version: "1.0.0", source: "YEUTECH", runtime: "host", category: "system", defaultInstalled: true, defaultEnabled: true, required: true, permissions: ["plugin:read", "plugin:configure"], tools: [] },
  { id: "yeutech.image-generation", name: "图片生成", description: "根据实时模型能力选择生图线路，生成图片并保存到当前项目。", version: "1.0.0", source: "YEUTECH", runtime: "opencode-tool", category: "media", defaultInstalled: true, defaultEnabled: true, required: true, permissions: ["network:model-gateway", "workspace:write-output"], tools: ["generate_image"] },
  { id: "yeutech.document-ocr", name: "Mac mini OCR", description: "按需识别图片文字、坐标和置信度，任务结束即退出。", version: "1.0.0", source: "YEUTECH", runtime: "opencode-tool", category: "document", defaultInstalled: true, defaultEnabled: true, required: false, permissions: ["artifact:read"], tools: ["document_ocr"] },
  { id: "yeutech.media-inspect", name: "Mac mini 媒体分析", description: "按需分析视频和音频编码、时长与流信息，任务结束即退出。", version: "1.0.0", source: "YEUTECH", runtime: "opencode-tool", category: "media", defaultInstalled: true, defaultEnabled: true, required: false, permissions: ["artifact:read"], tools: ["media_inspect"] },
  { id: "yeutech.project-files", name: "项目文件", description: "读取、检索、修改和预览当前授权项目中的文件。", version: "1.0.0", source: "YEUTECH", runtime: "host", category: "workspace", defaultInstalled: true, defaultEnabled: true, required: true, permissions: ["workspace:read", "workspace:write"], tools: ["read", "glob", "grep", "list", "edit", "write"] },
  { id: "opencode.skills", name: "Skills", description: "发现并按需加载项目和系统 Skills。", version: "builtin", source: "OpenCode", runtime: "opencode-native", category: "knowledge", defaultInstalled: true, defaultEnabled: true, required: false, permissions: ["workspace:read"], tools: ["skill"] },
  { id: "opencode.web-research", name: "网页检索", description: "搜索并读取公开网页，用于需要在线资料的任务。", version: "builtin", source: "OpenCode", runtime: "opencode-native", category: "research", defaultInstalled: true, defaultEnabled: true, required: false, permissions: ["network:web"], tools: ["websearch", "webfetch"] },
  { id: "opencode.subagents", name: "子 Agent", description: "把独立子任务交给隔离的子 Agent 并汇总结果。", version: "builtin", source: "OpenCode", runtime: "opencode-native", category: "orchestration", defaultInstalled: true, defaultEnabled: true, required: false, permissions: ["agent:delegate"], tools: ["task"] },
]);

function requireUser(value) {
  const user = Number(value);
  if (!Number.isSafeInteger(user) || user <= 0) throw Object.assign(new Error("Portal user is invalid"), { statusCode: 400 });
  return user;
}

function requireScope(value) {
  const scope = String(value || "workspace").trim();
  if (!/^(?:workspace|project:[A-Za-z0-9_-]{3,160})$/.test(scope)) throw Object.assign(new Error("Plugin scope is invalid"), { statusCode: 400 });
  return scope;
}

function requirePlugin(catalog, value) {
  const plugin = catalog.find((item) => item.id === String(value || ""));
  if (!plugin) throw Object.assign(new Error("Plugin is not in the managed catalog"), { statusCode: 404, code: "plugin_not_found" });
  return plugin;
}

export function createPluginManager(databasePath, options = {}) {
  const catalog = Object.freeze((options.catalog ?? BUILTIN_PLUGINS).map((item) => Object.freeze({ ...item, permissions: [...item.permissions], tools: [...item.tools] })));
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS plugin_preferences (
      portal_user_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      installed INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (portal_user_id, scope, plugin_id)
    );
  `);
  const preference = database.prepare("SELECT installed, enabled, updated_at FROM plugin_preferences WHERE portal_user_id = ? AND scope = ? AND plugin_id = ?");
  const save = database.prepare(`INSERT INTO plugin_preferences VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_user_id, scope, plugin_id) DO UPDATE SET installed=excluded.installed, enabled=excluded.enabled, updated_at=excluded.updated_at`);
  const resolve = (portalUserId, scope, plugin) => {
    const user = requireUser(portalUserId);
    const legacy = plugin.id === "yeutech.document-ocr" || plugin.id === "yeutech.media-inspect" ? "yeutech.mac-capabilities" : null;
    const row = preference.get(user, requireScope(scope), plugin.id)
      ?? (scope === "workspace" ? null : preference.get(user, "workspace", plugin.id))
      ?? (legacy ? preference.get(user, requireScope(scope), legacy) : null)
      ?? (legacy && scope !== "workspace" ? preference.get(user, "workspace", legacy) : null);
    const installed = plugin.required || Boolean(row ? row.installed : plugin.defaultInstalled);
    const enabled = plugin.required || Boolean(installed && (row ? row.enabled : plugin.defaultEnabled));
    return { ...plugin, installed, enabled, configurable: !plugin.required, updatedAt: row?.updated_at ?? null };
  };
  return {
    catalog() { return catalog.map((plugin) => ({ ...plugin, permissions: [...plugin.permissions], tools: [...plugin.tools] })); },
    list(portalUserId, scope = "workspace") { return catalog.map((plugin) => resolve(portalUserId, requireScope(scope), plugin)); },
    set(portalUserId, scope, pluginId, input = {}) {
      const plugin = requirePlugin(catalog, pluginId);
      const normalizedScope = requireScope(scope);
      if (plugin.required) throw Object.assign(new Error("Required system plugins cannot be disabled or uninstalled"), { statusCode: 409, code: "plugin_required" });
      const current = resolve(portalUserId, normalizedScope, plugin);
      const installed = input.installed === undefined ? current.installed : Boolean(input.installed);
      const enabled = installed && (input.enabled === undefined ? current.enabled : Boolean(input.enabled));
      save.run(requireUser(portalUserId), normalizedScope, plugin.id, installed ? 1 : 0, enabled ? 1 : 0, Date.now());
      return resolve(portalUserId, normalizedScope, plugin);
    },
    toolPolicy(portalUserId, scope = "workspace") {
      return Object.fromEntries(this.list(portalUserId, scope).flatMap((plugin) => plugin.tools.map((tool) => [tool, plugin.enabled])));
    },
    close() { database.close(); },
  };
}
