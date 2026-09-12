#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const snapshotRoot = path.resolve(process.argv[2] || "");
if (!process.argv[2] || path.parse(snapshotRoot).root === snapshotRoot) {
  throw new Error("Usage: node scripts/create-migration-manifest.mjs /absolute/snapshot/root");
}

const metadataRoot = path.join(snapshotRoot, "metadata");
const projectsRoot = path.join(snapshotRoot, "projects");
const databaseRoot = path.join(snapshotRoot, "database");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function walk(directory, relative = "") {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!relative && entry.name === "metadata") continue;
    const childRelative = path.join(relative, entry.name);
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (entry.isDirectory()) {
      records.push({ path: childRelative, type: "directory", bytes: 0 });
      records.push(...await walk(absolute, childRelative));
    } else if (entry.isSymbolicLink()) {
      records.push({ path: childRelative, type: "symlink", bytes: stat.size });
    } else if (entry.isFile()) {
      records.push({ path: childRelative, type: "file", bytes: stat.size, sha256: await sha256(absolute) });
    }
  }
  return records;
}

function summarize(records) {
  return {
    entries: records.length,
    files: records.filter((item) => item.type === "file").length,
    directories: records.filter((item) => item.type === "directory").length,
    symlinks: records.filter((item) => item.type === "symlink").length,
    bytes: records.reduce((total, item) => total + item.bytes, 0),
  };
}

function nestedSummary(records, prefix) {
  const normalized = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
  return summarize(records.filter((item) => item.path === prefix || item.path.startsWith(normalized)));
}

async function listProjectInventory(records) {
  const users = [];
  for (const owner of await readdir(projectsRoot, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.name === "#recycle") continue;
    const ownerRelative = path.join("projects", owner.name);
    const projects = [];
    let attachments = null;
    for (const entry of await readdir(path.join(projectsRoot, owner.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectRelative = path.join(ownerRelative, entry.name);
      if (entry.name === ".独立会话附件") attachments = nestedSummary(records, projectRelative);
      else projects.push({ name: entry.name, relativePath: projectRelative, ...nestedSummary(records, projectRelative) });
    }
    users.push({
      directory: owner.name,
      relativePath: ownerRelative,
      ...nestedSummary(records, ownerRelative),
      attachments,
      projects,
    });
  }
  return users;
}

async function inspectDatabase() {
  const candidates = [];
  for (const entry of await readdir(databaseRoot, { withFileTypes: true })) {
    if (entry.isFile() && /^codex-.*\.sqlite$/.test(entry.name)) candidates.push(entry.name);
  }
  candidates.sort();
  const filename = candidates.at(-1);
  if (!filename) return { file: null, integrityCheck: "missing" };
  const database = new DatabaseSync(path.join(databaseRoot, filename), { readOnly: true });
  try {
    const count = (table) => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const portalConversations = count("portal_codex_threads");
    const portalVisibleMessages = count("portal_codex_messages");
    const importedConversations = count("codex_imported_threads");
    const importedHistoricalEvents = count("codex_imported_messages");
    const linkedPortalConversations = Number(database.prepare(`
      SELECT COUNT(DISTINCT runtime_portal_thread_id) AS count
      FROM codex_imported_threads WHERE runtime_portal_thread_id IS NOT NULL
    `).get().count);
    return {
      file: path.join("database", filename),
      integrityCheck: database.prepare("PRAGMA integrity_check").get().integrity_check,
      logicalCounts: {
        portalConversations,
        portalVisibleMessages,
        importedConversations,
        importedHistoricalEvents,
        mergedConversations: portalConversations - linkedPortalConversations + importedConversations,
        mergedVisibleMessages: portalVisibleMessages + importedHistoricalEvents,
      },
    };
  } finally {
    database.close();
  }
}

await mkdir(metadataRoot, { recursive: true });
const records = (await walk(snapshotRoot)).sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
const inventory = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  snapshotDate: path.basename(snapshotRoot),
  snapshotRoot,
  sources: [
    { source: "/Volumes/codex项目空间", destination: "projects", mode: "local snapshot" },
    { source: "/Volumes/codex工作台数据", destination: "conversations", mode: "local snapshot" },
    { source: "Codex workbench SQLite", destination: "database", mode: "SQLite consistent copy plus raw WAL set" },
  ],
  exclusions: ["#recycle"],
  preservation: [".git", "hidden files", ".独立会话附件"],
  totals: summarize(records),
  sections: ["projects", "conversations", "database"].map((name) => ({ name, ...nestedSummary(records, name) })),
  users: await listProjectInventory(records),
  database: await inspectDatabase(),
};

const checksumLines = records.filter((item) => item.type === "file").map((item) => `${item.sha256}  ${item.path}`).join("\n");
await writeFile(path.join(metadataRoot, "project-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(metadataRoot, "checksums.sha256"), `${checksumLines}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(inventory.totals)}\n`);
