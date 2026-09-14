#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECT_SPACE_MARKER = ".yeutech-space-id";

function requireSpaceID(value) {
  const spaceID = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(spaceID)) throw new Error("Project spaceId is invalid");
  return spaceID;
}

function contained(parent, candidate) {
  return candidate.startsWith(`${parent}${path.sep}`) && path.dirname(candidate) === parent;
}

export async function resolveProjectSpace(options) {
  if (!path.isAbsolute(options.parent || "")) throw new Error("Project space parent must be an absolute path");
  const parentInput = path.resolve(options.parent);
  const parentInfo = await lstat(parentInput).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`Project space parent is unavailable: ${parentInput}`);
  const parent = await realpath(parentInput);
  const expected = requireSpaceID(options.spaceId);
  const markerName = options.markerName || PROJECT_SPACE_MARKER;
  if (path.basename(markerName) !== markerName || markerName === "." || markerName === "..") throw new Error("Project space marker name is invalid");
  const entries = await readdir(parent, { withFileTypes: true });
  const candidates = (await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (entry) => {
    const directory = path.join(parent, entry.name);
    const marker = path.join(directory, markerName);
    const markerInfo = await lstat(marker).catch(() => null);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) return null;
    if ((await readFile(marker, "utf8")).trim() !== expected) return null;
    const resolved = await realpath(directory);
    return contained(parent, resolved) ? resolved : null;
  }))).filter(Boolean);
  if (candidates.length === 0) throw new Error(`No project space with spaceId ${expected} exists directly under ${parent}`);
  if (candidates.length !== 1) throw new Error(`Multiple project spaces with spaceId ${expected} exist directly under ${parent}`);
  return candidates[0];
}

function argumentsFrom(argv) {
  const values = Object.fromEntries(argv.flatMap((value, index) => value.startsWith("--") ? [[value.slice(2), argv[index + 1]]] : []));
  return {
    parent: values.parent || process.env.YEUTECH_PROJECT_SPACE_PARENT,
    spaceId: values["space-id"] || process.env.YEUTECH_PROJECT_SPACE_ID,
    markerName: values.marker || process.env.YEUTECH_PROJECT_SPACE_MARKER,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  resolveProjectSpace(argumentsFrom(process.argv.slice(2)))
    .then((directory) => process.stdout.write(`${directory}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
