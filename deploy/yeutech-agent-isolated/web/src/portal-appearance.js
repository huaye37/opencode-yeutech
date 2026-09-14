const DEFAULT_APPEARANCE = {
  theme: "system",
  accentColor: "#1473e6",
  backgroundStyle: "aurora",
  lightBackgroundImage: "",
  darkBackgroundImage: "",
  backgroundOpacity: 24,
  surfaceOpacity: 78,
  materialOpacity: 90,
  chromeOpacity: 46,
  controlOpacity: 42,
  overlayOpacity: 72,
  overlayDim: 14,
  glassBlur: 14,
  cornerRadius: 14,
  liquidIntensity: 100,
  lensEdgeWidth: 31,
  density: "standard",
  fontScale: "normal",
};

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function safeImage(value) {
  if (typeof value !== "string" || !value.trim()) return "none";
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "none";
    return `url("${url.href.replace(/["\\\n\r]/g, "")}")`;
  } catch { return "none"; }
}

function percent(value, fallback) {
  return `${clamp(value, 0, 100, fallback)}%`;
}

export function applyPortalAppearance(value = DEFAULT_APPEARANCE) {
  const settings = { ...DEFAULT_APPEARANCE, ...(value || {}) };
  const root = document.documentElement;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const dark = settings.theme === "dark" || (settings.theme === "system" && prefersDark);
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accentColor || "") ? settings.accentColor : DEFAULT_APPEARANCE.accentColor;
  root.dataset.portalTheme = dark ? "dark" : "light";
  root.dataset.backgroundStyle = ["plain", "grid", "aurora", "image"].includes(settings.backgroundStyle) ? settings.backgroundStyle : "aurora";
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.setProperty("--primary", accent);
  root.style.setProperty("--surface-opacity", percent(settings.surfaceOpacity, 78));
  root.style.setProperty("--material-opacity", percent(settings.materialOpacity, 90));
  root.style.setProperty("--chrome-opacity", percent(settings.chromeOpacity, 46));
  root.style.setProperty("--control-opacity", percent(settings.controlOpacity, 42));
  root.style.setProperty("--overlay-opacity", percent(settings.overlayOpacity, 72));
  root.style.setProperty("--overlay-dim-opacity", `${clamp(settings.overlayDim, 0, 80, 14)}%`);
  root.style.setProperty("--glass-blur", `${clamp(settings.glassBlur, 0, 48, 14)}px`);
  root.style.setProperty("--portal-radius", `${clamp(settings.cornerRadius, 0, 40, 14)}px`);
  const liquidIntensity = clamp(settings.liquidIntensity, 0, 100, 100);
  const lensEdgeWidth = clamp(settings.lensEdgeWidth, 0, 100, 31);
  const fontScale = { small: 0.94, normal: 1, large: 1.08 }[settings.fontScale] || 1;
  const density = { compact: 0.88, standard: 1, comfortable: 1.12 }[settings.density] || 1;
  root.style.setProperty("--liquid-highlight-opacity", `${liquidIntensity * 0.22}%`);
  root.style.setProperty("--liquid-saturation", String(1 + liquidIntensity / 250));
  root.style.setProperty("--lens-edge-width", `${lensEdgeWidth / 24}px`);
  root.style.setProperty("--ui-font-scale", String(fontScale));
  root.style.setProperty("--ui-density", String(density));
  root.style.setProperty("--wallpaper-opacity", String(clamp(settings.backgroundOpacity, 0, 100, 24) / 100));
  root.style.setProperty("--wallpaper-image", safeImage(dark ? settings.darkBackgroundImage : settings.lightBackgroundImage));
}

export async function syncPortalAppearance() {
  try {
    const response = await fetch("/api/portal/appearance?site=codex", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error("portal appearance unavailable");
    applyPortalAppearance(payload.settings);
    return payload.settings;
  } catch {
    applyPortalAppearance();
    return null;
  }
}
