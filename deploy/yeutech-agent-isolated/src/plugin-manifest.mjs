const TOP_LEVEL_KEYS = new Set(["contractVersion", "generation", "plugins"]);
const PLUGIN_KEYS = new Set(["id", "displayName", "description", "kind", "source", "scope", "activation", "permissions", "capabilities", "requires", "consumers", "service"]);
const KINDS = new Set(["tool", "skill", "context", "projection", "provider", "workflow", "ui"]);
const SOURCES = new Set(["builtin", "package", "platform-service"]);
const SCOPES = new Set(["host", "location", "session"]);
const TRIGGERS = new Set(["host-start", "location-open", "session-open", "first-use"]);
const PERMISSIONS = new Set(["catalog.read", "session.read", "session.write", "project.read", "project.write", "artifact.read", "artifact.write", "network.egress", "model.invoke", "secret.use", "user.interaction"]);
const CONSUMERS = new Set(["agent-workbench", "novel-workbench", "deepseek-harness"]);
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?::[a-z0-9][a-z0-9._-]*)+$/;

export function validatePluginCatalog(value) {
  requireRecord(value, "catalog");
  rejectUnknown(value, TOP_LEVEL_KEYS, "catalog");
  if (value.contractVersion !== "yeutech-plugin-v1") throw new TypeError("catalog.contractVersion must be yeutech-plugin-v1");
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw new TypeError("catalog.generation must be a non-negative safe integer");
  if (!Array.isArray(value.plugins)) throw new TypeError("catalog.plugins must be an array");
  const ids = new Set();
  value.plugins.forEach((plugin, index) => {
    validatePlugin(plugin, index);
    if (ids.has(plugin.id)) throw new TypeError(`catalog.plugins[${index}].id is duplicated`);
    ids.add(plugin.id);
  });
  for (const [index, plugin] of value.plugins.entries()) {
    for (const dependency of plugin.requires) {
      if (!ids.has(dependency)) throw new TypeError(`catalog.plugins[${index}].requires references unknown plugin ${dependency}`);
      if (dependency === plugin.id) throw new TypeError(`catalog.plugins[${index}].requires cannot reference itself`);
    }
  }
  rejectCycles(value.plugins);
  return value;
}

export function defaultPlugins(catalog, consumer) {
  validatePluginCatalog(catalog);
  if (!CONSUMERS.has(consumer)) throw new TypeError(`Unsupported plugin consumer: ${consumer}`);
  const selected = new Set(catalog.plugins.filter((plugin) => plugin.activation.defaultEnabled && plugin.consumers.includes(consumer)).map((plugin) => plugin.id));
  const includeDependencies = (id) => {
    const plugin = catalog.plugins.find((candidate) => candidate.id === id);
    for (const dependency of plugin?.requires || []) {
      const target = catalog.plugins.find((candidate) => candidate.id === dependency);
      if (!target?.consumers.includes(consumer)) throw new TypeError(`Plugin ${id} requires ${dependency}, which is unavailable to ${consumer}`);
      if (!selected.has(dependency)) {
        selected.add(dependency);
        includeDependencies(dependency);
      }
    }
  };
  [...selected].forEach(includeDependencies);
  return catalog.plugins.filter((plugin) => selected.has(plugin.id));
}

function validatePlugin(plugin, index) {
  const at = `catalog.plugins[${index}]`;
  requireRecord(plugin, at);
  rejectUnknown(plugin, PLUGIN_KEYS, at);
  requireString(plugin.id, `${at}.id`, ID, 120);
  requireString(plugin.displayName, `${at}.displayName`, null, 120);
  requireString(plugin.description, `${at}.description`, null, 500);
  requireEnum(plugin.kind, KINDS, `${at}.kind`);
  requireEnum(plugin.source, SOURCES, `${at}.source`);
  requireEnum(plugin.scope, SCOPES, `${at}.scope`);
  requireRecord(plugin.activation, `${at}.activation`);
  rejectUnknown(plugin.activation, new Set(["defaultEnabled", "trigger"]), `${at}.activation`);
  if (typeof plugin.activation.defaultEnabled !== "boolean") throw new TypeError(`${at}.activation.defaultEnabled must be a boolean`);
  requireEnum(plugin.activation.trigger, TRIGGERS, `${at}.activation.trigger`);
  requireUniqueEnumArray(plugin.permissions, PERMISSIONS, `${at}.permissions`);
  requireStringArray(plugin.capabilities, `${at}.capabilities`, CAPABILITY, true);
  requireStringArray(plugin.requires, `${at}.requires`, ID, false);
  requireUniqueEnumArray(plugin.consumers, CONSUMERS, `${at}.consumers`, true);
  if (plugin.source === "platform-service") {
    requireRecord(plugin.service, `${at}.service`);
    rejectUnknown(plugin.service, new Set(["id", "protocol"]), `${at}.service`);
    requireString(plugin.service.id, `${at}.service.id`, /^[a-z][a-z0-9-]*$/, 120);
    if (plugin.service.protocol !== "yeutech-plugin-http-v1") throw new TypeError(`${at}.service.protocol must be yeutech-plugin-http-v1`);
  } else if (plugin.service !== undefined) throw new TypeError(`${at}.service is only valid for platform-service plugins`);
}

function rejectCycles(plugins) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new TypeError(`Plugin dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id).requires.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  plugins.forEach((plugin) => visit(plugin.id));
}

function requireRecord(value, at) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${at} must be an object`);
}

function rejectUnknown(value, allowed, at) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`${at}.${unknown} is not allowed`);
}

function requireString(value, at, pattern, maxLength) {
  if (typeof value !== "string" || !value.length || value.length > maxLength || (pattern && !pattern.test(value))) throw new TypeError(`${at} is invalid`);
}

function requireEnum(value, allowed, at) {
  if (!allowed.has(value)) throw new TypeError(`${at} is invalid`);
}

function requireUniqueEnumArray(value, allowed, at, nonEmpty = false) {
  if (!Array.isArray(value) || (nonEmpty && !value.length) || new Set(value).size !== value.length || value.some((item) => !allowed.has(item))) throw new TypeError(`${at} is invalid`);
}

function requireStringArray(value, at, pattern, nonEmpty) {
  if (!Array.isArray(value) || (nonEmpty && !value.length) || new Set(value).size !== value.length || value.some((item) => typeof item !== "string" || !pattern.test(item))) throw new TypeError(`${at} is invalid`);
}
