import assert from "node:assert/strict";
import test from "node:test";
import { applyPortalAppearance } from "../web/src/portal-appearance.js";

test("maps every portal-owned appearance control into workbench tokens", () => {
  const values = new Map();
  const root = {
    dataset: {},
    style: {
      colorScheme: "",
      setProperty(name, value) { values.set(name, value); },
    },
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { origin: "https://agent.yeutech.cn" },
    matchMedia: () => ({ matches: false }),
  };
  globalThis.document = { documentElement: root };
  try {
    applyPortalAppearance({
      theme: "dark",
      backgroundStyle: "image",
      darkBackgroundImage: "/backgrounds/dark.webp",
      liquidIntensity: 50,
      lensEdgeWidth: 48,
      density: "comfortable",
      fontScale: "large",
    });
    assert.equal(root.dataset.portalTheme, "dark");
    assert.equal(root.dataset.backgroundStyle, "image");
    assert.equal(root.style.colorScheme, "dark");
    assert.equal(values.get("--wallpaper-image"), "url(\"https://agent.yeutech.cn/backgrounds/dark.webp\")");
    assert.equal(values.get("--liquid-highlight-opacity"), "11%");
    assert.equal(values.get("--liquid-saturation"), "1.2");
    assert.equal(values.get("--lens-edge-width"), "2px");
    assert.equal(values.get("--ui-density"), "1.12");
    assert.equal(values.get("--ui-font-scale"), "1.08");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
