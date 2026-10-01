import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const assetRoot = resolve("dist/assets");
const cssFiles = (await readdir(assetRoot))
  .filter((name) => name.endsWith(".css"))
  .map((name) => resolve(assetRoot, name));
const css = (await Promise.all(cssFiles.map((file) => readFile(file, "utf8")))).join("\n");
const jsFiles = (await readdir(resolve("dist/assets")))
  .filter((name) => name.endsWith(".js"))
  .map((name) => resolve("dist/assets", name));
const js = (await Promise.all(jsFiles.map((file) => readFile(file, "utf8")))).join("\n");

const requiredDefinitions = [
  /--yt-accent\s*:\s*#0071e3/,
  /--yt-layer-page\s*:/,
  /--yt-layer-overlay\s*:/,
  /--yt-filter-chrome\s*:/,
];
const missing = requiredDefinitions.filter((pattern) => !pattern.test(css));

if (missing.length > 0) {
  throw new Error("Production CSS references the YEUTECH contract but does not contain its definitions.");
}

if (!js.includes("portal-shell yt-page")) {
  throw new Error("Production markup does not mount the portal-owned wallpaper layer.");
}

console.log(`YEUTECH material definitions verified in ${cssFiles.length} production CSS files.`);
