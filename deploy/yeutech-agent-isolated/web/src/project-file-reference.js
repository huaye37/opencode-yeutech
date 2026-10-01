function decodeReference(value) {
  const source = String(value || "").trim().replace(/^<|>$/g, "");
  try { return decodeURIComponent(source); }
  catch { return source; }
}

function internalFilePath(value) {
  try {
    const url = new URL(value, "https://workbench.invalid");
    if (!new Set(["/codex/files", "/api/workbench/file", "/api/workbench/files"]).has(url.pathname)) return "";
    const path = url.searchParams.get("path") || "";
    if (path) return path;
    const directory = url.searchParams.get("directory") || "";
    const name = url.searchParams.get("name") || "";
    return [directory, name].filter(Boolean).join("/");
  } catch { return ""; }
}

export function projectFilePath(value, projectName = "", { allowBare = false } = {}) {
  let decoded = decodeReference(value);
  const internal = internalFilePath(decoded);
  if (internal) decoded = decodeReference(internal);
  else if (/^file:\/\//i.test(decoded)) decoded = decoded.replace(/^file:\/\//i, "");
  else if (/^[a-z][a-z\d+.-]*:/i.test(decoded) && !/^[a-z]:[\\/]/i.test(decoded)) return "";

  let normalized = decoded.split(/[?#]/, 1)[0].replaceAll("\\", "/").trim();
  const wasAbsolute = normalized.startsWith("/") || normalized.startsWith("~/") || /^[a-z]:\//i.test(normalized);
  const projects = (Array.isArray(projectName) ? projectName : [projectName])
    .map((name) => String(name || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  let matchedProject = false;
  for (const project of projects) {
    const marker = `/${project}/`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex >= 0) {
      normalized = normalized.slice(markerIndex + marker.length);
      matchedProject = true;
      break;
    }
    if (normalized.startsWith(`${project}/`)) {
      normalized = normalized.slice(project.length + 1);
      matchedProject = true;
      break;
    }
  }
  normalized = normalized.replace(/^\.\//, "").replace(/:(?:\d+)(?::\d+)?$/, "");
  if (wasAbsolute && !matchedProject && !internal) return "";
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) return "";
  if (!allowBare && !normalized.includes("/")) return "";
  if (!/(?:^|\/)[^/]+\.[\p{L}\p{N}][\p{L}\p{N}._-]{0,31}$/iu.test(normalized)) return "";
  return normalized;
}

function citationPath(body, projectName) {
  const match = String(body || "").match(/(?:^|\s)path\s*=\s*"((?:\\.|[^"])*)"/);
  if (!match) return "";
  const decoded = match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return projectFilePath(decoded, projectName, { allowBare: true });
}

function markdownFileLink(label, path) {
  return `[${label}](${encodeURI(path).replaceAll("(", "%28").replaceAll(")", "%29")})`;
}

export function normalizeProjectFileReferences(content, projectName = "") {
  // Some imported Codex messages lost their line breaks and persisted a
  // complete fenced block as "```text value ```" on one line. Restore the
  // block shape before the renderer classifies lines so fence markers never
  // leak into the conversation.
  let rendered = String(content || "").replace(
    /```([a-z\d_+.-]+)[ \t]+([^`\n][\s\S]*?)[ \t]+```/gi,
    (_fence, language, code) => `\n\`\`\`${language}\n${code.trim()}\n\`\`\`\n`,
  ).replace(
    /\[([^\]\n]+)\]\(\[[^\]\n]+\]\(([^)\s]+)\)\)/g,
    (nested, label, href) => {
      const path = projectFilePath(href, projectName, { allowBare: true });
      return path ? markdownFileLink(label, path) : nested;
    },
  );
  rendered = rendered.replace(
    /\[([^\]\n]+)\]\(\s*:codex-file-citation\{([^}]+)\}\s*\)/g,
    (citation, label, body) => {
      const path = citationPath(body, projectName);
      return path ? markdownFileLink(label, path) : citation;
    },
  );
  return rendered.replace(/:codex-file-citation\{([^}]+)\}/g, (citation, body) => {
    const path = citationPath(body, projectName);
    const label = path.split("/").at(-1) || "打开文件";
    return path ? markdownFileLink(label, path) : citation;
  });
}
