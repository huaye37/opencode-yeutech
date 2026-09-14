import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_FILE_READ_LIMIT = 32 * 1024 * 1024;
export const DEFAULT_TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_MEDIA_PREVIEW_LIMIT = 16 * 1024 * 1024;

const ALWAYS_HIDDEN_NAMES = new Set([
  ".yeutech-project.json", ".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd",
  "@eaDir", "__MACOSX", "#recycle", "Thumbs.db", "desktop.ini",
]);
const ALWAYS_HIDDEN_SUFFIXES = [".uploading"];
const DEFAULT_HIDDEN_PREFIXES = ["._", "~$"];

const UPLOAD_TYPES = new Map([
  ["application/json", new Set([".json"])],
  ["application/msword", new Set([".doc"])],
  ["application/pdf", new Set([".pdf"])],
  ["application/vnd.ms-excel", new Set([".xls"])],
  ["application/vnd.ms-powerpoint", new Set([".ppt"])],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", new Set([".pptx"])],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Set([".xlsx"])],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Set([".docx"])],
  ["image/gif", new Set([".gif"])],
  ["image/jpeg", new Set([".jpeg", ".jpg"])],
  ["image/png", new Set([".png"])],
  ["image/webp", new Set([".webp"])],
  ["text/csv", new Set([".csv"])],
  ["text/markdown", new Set([".md", ".markdown"])],
  ["text/plain", new Set([".log", ".md", ".txt"])],
]);

const READ_TYPES = new Map([
  ...UPLOAD_TYPES,
  ["application/javascript", new Set([".js", ".mjs", ".cjs"])],
  ["application/xml", new Set([".xml"])],
  ["image/svg+xml", new Set([".svg"])],
  ["text/css", new Set([".css"])],
  ["text/html", new Set([".htm", ".html"])],
  ["text/javascript", new Set([".js", ".mjs", ".cjs"])],
  ["text/typescript", new Set([".ts", ".tsx"])],
  ["text/xml", new Set([".xml"])],
]);

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function requireProjectName(value) {
  const project = String(value || "").normalize("NFC").trim();
  if (!project || project === "." || project === ".." || project.includes("/") || project.includes("\\") || project.includes("\0")) {
    throw httpError("Project name is invalid", 400);
  }
  return project;
}

function requireRelativePath(value = "") {
  const relative = String(value || "").normalize("NFC").replaceAll("\\", "/");
  if (relative.includes("\0") || path.posix.isAbsolute(relative)) throw httpError("Project path must be relative", 400);
  const normalized = path.posix.normalize(relative || ".");
  if (normalized === ".." || normalized.startsWith("../")) throw httpError("Project path escapes the project", 400);
  return normalized === "." ? "" : normalized;
}

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function projectMarker(marker, portalUserId) {
  if (!marker) return null;
  const projectId = String(marker.projectId || marker.id || "").trim();
  const native = marker.version === 1 && Number(marker.portalUserId) === Number(portalUserId);
  const legacy = marker.portalUserId == null && typeof marker.ownerKey === "string" && marker.ownerKey.length >= 16;
  return projectId && (native || legacy) ? { ...marker, projectId } : null;
}

async function requireRealDirectory(candidate, boundary, label) {
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw httpError(`${label} was not found`, 404);
  const resolved = await realpath(candidate);
  if (!contained(boundary, resolved)) throw httpError(`${label} escapes the workspace`, 403);
  return resolved;
}

async function requireSafeTarget(root, relative, kind, options = {}) {
  const segments = requireRelativePath(relative).split("/").filter(Boolean);
  let candidate = root;
  for (const segment of segments) {
    const visibility = entryVisibility(segment);
    if (visibility === "system") throw httpError("System workspace files are not accessible", 403);
    if (visibility === "hidden" && !options.showHidden) throw httpError("Hidden workspace file access requires an explicit opt-in", 403);
    candidate = path.join(candidate, segment);
    const info = await lstat(candidate).catch(() => null);
    if (!info) throw httpError("Project file was not found", 404);
    if (info.isSymbolicLink()) throw httpError("Symbolic links are not accessible", 403);
  }
  const resolved = await realpath(candidate);
  if (!contained(root, resolved)) throw httpError("Project path escapes the project", 403);
  const info = await stat(resolved);
  if (kind === "directory" && !info.isDirectory()) throw httpError("Project directory was not found", 404);
  if (kind === "file" && !info.isFile()) throw httpError("Project file was not found", 404);
  return { path: resolved, info };
}

function contentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function mimeForFile(file) {
  const extension = path.extname(file).toLowerCase();
  return [...READ_TYPES.entries()].find(([, extensions]) => extensions.has(extension))?.[0] || "application/octet-stream";
}

function isAlwaysHidden(name) {
  return ALWAYS_HIDDEN_NAMES.has(name) || ALWAYS_HIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function isHiddenWorkspaceEntry(name) {
  const value = String(name || "");
  return isAlwaysHidden(value) || value.startsWith(".") || DEFAULT_HIDDEN_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function previewKind(originalType) {
  if (originalType === "application/json") return "json";
  if (originalType === "text/markdown") return "markdown";
  if (originalType === "text/html") return "html-source";
  if (originalType === "image/svg+xml") return "svg-source";
  if (originalType === "application/pdf") return "pdf";
  if (originalType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (originalType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (originalType.startsWith("image/")) return "image";
  if (originalType.startsWith("text/") || new Set(["application/javascript", "application/xml"]).has(originalType)) return "text";
  return "download";
}

function filePresentation(file, size, options = {}) {
  const name = path.basename(file);
  const originalType = mimeForFile(file);
  const kind = previewKind(originalType);
  const activeSource = kind === "html-source" || kind === "svg-source";
  const textual = new Set(["json", "markdown", "html-source", "svg-source", "text"]).has(kind);
  const media = new Set(["pdf", "image", "docx", "xlsx"]).has(kind);
  const previewLimit = textual ? options.textPreviewLimit : media ? options.mediaPreviewLimit : 0;
  const disposition = activeSource || kind === "download" ? "attachment" : "inline";
  const type = activeSource ? "text/plain; charset=utf-8" : textual && originalType.startsWith("text/") ? `${originalType}; charset=utf-8` : originalType;
  return {
    name,
    type,
    originalType,
    disposition,
    contentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    preview: { kind, inline: disposition === "inline", eligible: previewLimit > 0 && size <= previewLimit, maxBytes: previewLimit },
  };
}

function entryVisibility(name) {
  if (isAlwaysHidden(name) || DEFAULT_HIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) return "system";
  return name.startsWith(".") ? "hidden" : "visible";
}

export function sanitizeAttachmentName(value) {
  const original = path.basename(String(value || "").normalize("NFKC").replaceAll("\\", "/"));
  const cleaned = original.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw httpError("Attachment filename is invalid", 400);
  const extension = path.extname(cleaned).slice(0, 20);
  const stemLimit = Math.max(1, 120 - extension.length);
  return `${cleaned.slice(0, cleaned.length - extension.length).slice(0, stemLimit)}${extension}`;
}

function uploadType(suppliedType) {
  // Storage accepts arbitrary bytes. Preview and Agent-reading capability are
  // evaluated separately, so an unknown format remains downloadable.
  return contentType(suppliedType) || "application/octet-stream";
}

async function reserveAvailableName(directory, filename) {
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = path.join(directory, index === 1 ? filename : `${stem}_${index}${extension}`);
    const handle = await open(candidate, "wx", 0o600).catch((error) => error.code === "EEXIST" ? null : Promise.reject(error));
    if (handle) {
      await handle.close();
      return candidate;
    }
  }
  throw httpError("Attachment name could not be allocated", 409);
}

export async function createWorkspaceFiles(workspace, options = {}) {
  if (!path.isAbsolute(workspace)) throw new Error("Workspace must be an absolute path");
  const workspaceRoot = await requireRealDirectory(path.resolve(workspace), await realpath(path.resolve(workspace)), "Workspace");
  const attachmentLimit = Number.isFinite(Number(options.attachmentLimit)) && Number(options.attachmentLimit) >= 0
    ? Number(options.attachmentLimit)
    : null;
  const fileReadLimit = options.fileReadLimit ?? DEFAULT_FILE_READ_LIMIT;
  const textPreviewLimit = Math.min(fileReadLimit, options.textPreviewLimit ?? DEFAULT_TEXT_PREVIEW_LIMIT);
  const mediaPreviewLimit = Math.min(fileReadLimit, options.mediaPreviewLimit ?? DEFAULT_MEDIA_PREVIEW_LIMIT);

  async function projectRoot(projectName) {
    return requireRealDirectory(path.join(workspaceRoot, requireProjectName(projectName)), workspaceRoot, "Project");
  }

  function requireSessionKey(value) {
    const session = String(value || "").normalize("NFC").trim();
    if (!session || session.length > 512 || session.includes("\0")) throw httpError("Session file scope is invalid", 400);
    return session;
  }

  async function standaloneRoot(session, create = false) {
    requireSessionKey(session);
    const target = path.join(workspaceRoot, "独立会话");
    if (create) await mkdir(target, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    return requireRealDirectory(target, workspaceRoot, "Standalone conversation files");
  }

  async function fileSpaceRoot(space, create = false) {
    if (typeof space === "string") return projectRoot(space);
    if (space?.project) return projectRoot(space.project);
    return standaloneRoot(space?.session, create);
  }

  async function fileSpacePrefix(space) {
    if (typeof space === "string") return requireProjectName(space);
    if (space?.project) return requireProjectName(space.project);
    await standaloneRoot(space?.session);
    return "独立会话";
  }

  async function projects() {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isHiddenWorkspaceEntry(entry.name) || ["附件", "独立会话"].includes(entry.name)) continue;
      const root = await requireRealDirectory(path.join(workspaceRoot, entry.name), workspaceRoot, "Project");
      const markerFile = path.join(root, ".yeutech-project.json");
      let marker = null;
      try { marker = JSON.parse(await readFile(markerFile, "utf8")); }
      catch (error) { if (error?.code !== "ENOENT") throw httpError(`Project marker is invalid: ${entry.name}`, 409); }
      const normalizedMarker = projectMarker(marker, options.portalUserId);
      if (marker && !normalizedMarker) {
        throw httpError(`Project marker ownership is invalid: ${entry.name}`, 409);
      }
      result.push({
        id: normalizedMarker?.projectId || null,
        name: entry.name,
        workspaceDirectory: entry.name,
        registered: Boolean(marker),
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async function createProject(projectName) {
    if (!Number.isSafeInteger(Number(options.portalUserId)) || Number(options.portalUserId) <= 0) throw httpError("Portal user is invalid", 400);
    const name = requireProjectName(projectName);
    const directory = path.join(workspaceRoot, name);
    let created = false;
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      created = true;
      const projectId = `project_${randomUUID().replaceAll("-", "")}`;
      await writeFile(path.join(directory, ".yeutech-project.json"), `${JSON.stringify({ version: 1, projectId, portalUserId: Number(options.portalUserId) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return { id: projectId, name, workspaceDirectory: name, registered: true };
    } catch (error) {
      if (created) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error?.code === "EEXIST") throw Object.assign(httpError("Project already exists", 409), {
        code: "project_exists",
        retryable: false,
        scope: "project",
        recoveryAction: "choose_another_name",
      });
      throw error;
    }
  }

  async function registerProject(projectName) {
    if (!Number.isSafeInteger(Number(options.portalUserId)) || Number(options.portalUserId) <= 0) throw httpError("Portal user is invalid", 400);
    const name = requireProjectName(projectName);
    const root = await projectRoot(name);
    const markerFile = path.join(root, ".yeutech-project.json");
    let marker = null;
    try { marker = JSON.parse(await readFile(markerFile, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw httpError("Project marker is invalid", 409); }
    if (marker) {
      const normalizedMarker = projectMarker(marker, options.portalUserId);
      if (!normalizedMarker) throw httpError("Project belongs to another portal identity", 409);
      return { id: normalizedMarker.projectId, name, workspaceDirectory: name, registered: true };
    }
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await writeFile(markerFile, `${JSON.stringify({ version: 1, projectId, portalUserId: Number(options.portalUserId) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { id: projectId, name, workspaceDirectory: name, registered: true };
  }

  async function sourceReferences(projectName, paths) {
    if (!Array.isArray(paths) || paths.length === 0) throw httpError("At least one project source is required", 400);
    const root = await projectRoot(projectName);
    const references = [];
    for (const relative of [...new Set(paths.map((value) => requireRelativePath(value)))]) {
      const target = await requireSafeTarget(root, relative, "file");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(target.path)) hash.update(chunk);
      references.push({ path: relative, version: `${target.info.size}:${Math.trunc(target.info.mtimeMs)}`, hash: hash.digest("hex"), kind: "project-file" });
    }
    return references.sort((left, right) => left.path.localeCompare(right.path));
  }

  async function list(space, relative = "", options = {}) {
    const root = await fileSpaceRoot(space, Boolean(space?.session));
    const target = await requireSafeTarget(root, relative, "directory", { showHidden: options.showHidden === true });
    const entries = await readdir(target.path, { withFileTypes: true });
    const visibleEntries = [];
    let hiddenCount = 0;
    for (const entry of entries) {
      const visibility = entryVisibility(entry.name);
      if (visibility === "system") continue;
      if (visibility === "hidden" && !options.showHidden) { hiddenCount += 1; continue; }
      const entryPath = path.join(target.path, entry.name);
      const info = entry.isSymbolicLink() ? null : await stat(entryPath).catch(() => null);
      const presentation = entry.isFile() && info?.isFile()
        ? filePresentation(entryPath, info.size, { textPreviewLimit, mediaPreviewLimit })
        : null;
      visibleEntries.push({
        name: entry.name,
        path: path.posix.join(requireRelativePath(relative), entry.name),
        type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size: info?.isFile() ? info.size : null,
        modifiedAt: info?.mtimeMs ?? null,
        mimeType: presentation?.originalType || (entry.isFile() ? mimeForFile(entryPath) : null),
        preview: presentation?.preview || null,
        hidden: visibility === "hidden",
      });
    }
    return {
      space: typeof space === "string" ? { project: requireProjectName(space) } : space?.project ? { project: requireProjectName(space.project) } : { session: requireSessionKey(space?.session) },
      workspacePrefix: await fileSpacePrefix(space),
      path: requireRelativePath(relative),
      hiddenCount,
      entries: visibleEntries.sort((left, right) => (left.type === "directory" ? 0 : 1) - (right.type === "directory" ? 0 : 1) || left.name.localeCompare(right.name, "zh-CN")),
    };
  }

  async function file(space, relative, options = {}) {
    const root = await fileSpaceRoot(space);
    const target = await requireSafeTarget(root, relative, "file", { showHidden: options.showHidden === true });
    const presentation = filePresentation(target.path, target.info.size, { textPreviewLimit, mediaPreviewLimit });
    if (!options.download && !presentation.preview.eligible) throw httpError("Project file is too large or unsupported for inline preview", 413);
    return { stream: createReadStream(target.path), size: target.info.size, ...presentation };
  }

  async function upload(space, request, metadata = {}) {
    const root = await fileSpaceRoot(space, true);
    const filename = sanitizeAttachmentName(metadata.filename);
    const type = uploadType(metadata.type);
    const declared = Number(metadata.length ?? 0);
    if (attachmentLimit !== null && Number.isFinite(declared) && declared > attachmentLimit) throw httpError("Attachment is too large", 413);
    const requestedDirectory = metadata.directory === undefined || metadata.directory === null
      ? null
      : requireRelativePath(metadata.directory);
    const destination = requestedDirectory === null ? path.join(root, "附件") : path.join(root, requestedDirectory);
    if (requestedDirectory === null) await mkdir(destination, { recursive: true, mode: 0o700 });
    const safeDestination = requestedDirectory === null
      ? await requireRealDirectory(destination, root, "Attachment directory")
      : (await requireSafeTarget(root, requestedDirectory, "directory")).path;
    const temporary = path.join(safeDestination, `.${randomUUID()}.uploading`);
    let target;
    try {
      let size = 0;
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(attachmentLimit !== null && size > attachmentLimit ? httpError("Attachment is too large", 413) : null, chunk);
      } });
      await pipeline(request, limiter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      target = await reserveAvailableName(safeDestination, filename);
      await rename(temporary, target);
      const relative = path.posix.join(requestedDirectory === null ? "附件" : requestedDirectory, path.basename(target));
      return { name: path.basename(target), path: relative, workspacePath: path.posix.join(await fileSpacePrefix(space), relative), size, type, uploaded: true };
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (target) await unlink(target).catch(() => {});
      throw error;
    }
  }

  async function removeUpload(space, relative) {
    const normalized = requireRelativePath(relative);
    if (path.posix.dirname(normalized) !== "附件" || path.posix.basename(normalized) === ".") throw httpError("Only uploaded attachments can be deleted", 400);
    const root = await fileSpaceRoot(space);
    const target = await requireSafeTarget(root, normalized, "file");
    await unlink(target.path);
    return { path: normalized, deleted: true };
  }

  return { createProject, file, list, projectRoot, projects, registerProject, removeUpload, sourceReferences, upload };
}
