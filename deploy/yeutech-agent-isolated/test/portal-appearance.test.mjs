import assert from "node:assert/strict";
import test from "node:test";
import { applyPortalAppearance, APPEARANCE_SITE } from "../web/src/portal-appearance.js";
import { appearanceEndpoint, CONTRACT_INPUT_VARIABLES } from "../web/src/design/yeutech-material-contract.mjs";

function withBrowser(run) {
  const values = new Map();
  const root = { dataset: {}, style: { colorScheme: "", setProperty(name, value) { values.set(name, value); } } };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { origin: "https://agent.yeutech.cn", hostname: "agent.yeutech.cn" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.document = { documentElement: root };
  try { run(root, values); } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
}

test("the workbench reads only the portal appearance contract for the agent site", () => {
  assert.equal(APPEARANCE_SITE, "agent");
  assert.equal(appearanceEndpoint(APPEARANCE_SITE), "/api/portal/appearance?site=agent");
});

test("maps every portal-owned appearance control into contract inputs", () => {
  withBrowser((root, values) => {
    applyPortalAppearance({
      theme: "dark",
      backgroundStyle: "image",
      darkBackgroundImage: "/backgrounds/dark.webp",
      surfaceOpacity: 61,
      materialOpacity: 33,
      chromeOpacity: 12,
      controlOpacity: 7,
      overlayOpacity: 88,
      overlayDim: 40,
      glassBlur: 22,
      liquidIntensity: 50,
      lensEdgeWidth: 48,
      cornerRadius: 0,
      density: "comfortable",
      fontScale: "large",
    });
    assert.equal(root.dataset.ytTheme, "dark");
    assert.equal(root.dataset.backgroundStyle, "image");
    assert.equal(root.dataset.density, "comfortable");
    assert.equal(root.dataset.fontScale, "large");
    assert.equal(root.style.colorScheme, "dark");
    for (const name of CONTRACT_INPUT_VARIABLES) assert.ok(values.has(name), name);
    assert.equal(values.get("--yt-wallpaper-dark"), "url(\"https://yeutech.cn/backgrounds/dark.webp\")");
    assert.equal(values.get("--yt-surface-alpha"), "61%");
    assert.equal(values.get("--yt-material-alpha"), "33%");
    assert.equal(values.get("--yt-chrome-alpha"), "12%");
    assert.equal(values.get("--yt-control-alpha"), "7%");
    assert.equal(values.get("--yt-overlay-alpha"), "88%");
    assert.equal(values.get("--yt-dim-alpha"), "40%");
    assert.equal(values.get("--yt-blur"), "22px");
    assert.equal(values.get("--yt-liquid"), "0.500");
    assert.equal(values.get("--yt-lens"), "48px");
    assert.equal(values.get("--yt-radius"), "0px");
  });
});
