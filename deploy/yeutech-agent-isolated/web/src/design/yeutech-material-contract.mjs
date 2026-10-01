/*
 * YEUTECH Material Contract 2.1.0 runtime
 *
 * Canonical source: yeutech-home-platform/frontend/design/yeutech-material-contract.mjs
 * Vendored copies are produced by yeutech-home-platform/scripts/sync-material-contract.mjs.
 * Edit only the canonical file.
 *
 * The runtime has exactly one responsibility: turn the portal appearance payload into the
 * raw --yt-* inputs consumed by yeutech-material-contract.css. It never derives layer
 * colours itself, so no site can grow a second opacity or radius mapping.
 */

export const MATERIAL_CONTRACT_VERSION = "2.1.0"

export const APPEARANCE_SITES = Object.freeze([
  "nas",
  "media",
  "print",
  "router",
  "codex",
  "creator",
  "agent",
  "api",
  "kaoyan",
  "write",
  "review",
  "worklog",
])

export const DEFAULT_BACKGROUND_IMAGES = Object.freeze({
  light: "/backgrounds/light-architecture.webp",
  dark: "/backgrounds/dark-structure.webp",
})

export const DEFAULT_APPEARANCE = Object.freeze({
  version: 1,
  updatedAt: null,
  theme: "system",
  accentColor: "#0071e3",
  backgroundStyle: "image",
  backgroundImage: DEFAULT_BACKGROUND_IMAGES.light,
  lightBackgroundImage: DEFAULT_BACKGROUND_IMAGES.light,
  darkBackgroundImage: DEFAULT_BACKGROUND_IMAGES.dark,
  backgroundOpacity: 24,
  surfaceOpacity: 78,
  materialOpacity: 90,
  chromeOpacity: 46,
  controlOpacity: 42,
  overlayOpacity: 72,
  overlayDim: 14,
  glassBlur: 14,
  liquidIntensity: 56,
  lensEdgeWidth: 18,
  cornerRadius: 14,
  density: "standard",
  fontScale: "normal",
  subjectColors: Object.freeze({
    english: "#0071e3",
    politics: "#af52de",
    p731: "#5856d6",
    p837: "#0a7d66",
  }),
})

/** Numeric appearance fields and their inclusive ranges. */
export const APPEARANCE_RANGES = Object.freeze({
  backgroundOpacity: [0, 100],
  surfaceOpacity: [0, 100],
  materialOpacity: [0, 100],
  chromeOpacity: [0, 100],
  controlOpacity: [0, 100],
  overlayOpacity: [0, 100],
  overlayDim: [0, 80],
  glassBlur: [0, 48],
  liquidIntensity: [0, 100],
  lensEdgeWidth: [0, 48],
  cornerRadius: [0, 40],
})

/** The complete set of CSS inputs the contract stylesheet consumes. */
export const CONTRACT_INPUT_VARIABLES = Object.freeze([
  "--yt-accent",
  "--yt-background-opacity",
  "--yt-surface-alpha",
  "--yt-material-alpha",
  "--yt-chrome-alpha",
  "--yt-control-alpha",
  "--yt-overlay-alpha",
  "--yt-dim-alpha",
  "--yt-blur",
  "--yt-liquid",
  "--yt-lens",
  "--yt-radius",
  "--yt-wallpaper-light",
  "--yt-wallpaper-dark",
])

function clamp(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function hexColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback
}

function imageSource(value, fallback) {
  if (typeof value !== "string") return fallback
  const raw = value.trim().slice(0, 2048)
  if (!raw) return ""
  try {
    const url = new URL(raw, "https://yeutech.invalid")
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return fallback
    }
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw
    return /^https?:\/\//i.test(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

export function normalizeAppearance(value) {
  const input = value && typeof value === "object" ? value : {}
  const legacyImage = imageSource(input.backgroundImage, "")
  const lightBackgroundImage = imageSource(
    input.lightBackgroundImage,
    legacyImage || DEFAULT_BACKGROUND_IMAGES.light
  )
  const darkBackgroundImage = imageSource(
    input.darkBackgroundImage,
    legacyImage || DEFAULT_BACKGROUND_IMAGES.dark
  )
  const subjects =
    input.subjectColors && typeof input.subjectColors === "object"
      ? input.subjectColors
      : DEFAULT_APPEARANCE.subjectColors
  const numbers = {}
  for (const [key, [min, max]] of Object.entries(APPEARANCE_RANGES)) {
    numbers[key] = clamp(input[key], min, max, DEFAULT_APPEARANCE[key])
  }
  return {
    ...DEFAULT_APPEARANCE,
    ...numbers,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
    theme: input.theme === "light" || input.theme === "dark" ? input.theme : "system",
    accentColor: hexColor(input.accentColor, DEFAULT_APPEARANCE.accentColor),
    backgroundStyle: ["plain", "grid", "aurora", "image"].includes(input.backgroundStyle)
      ? input.backgroundStyle
      : "grid",
    backgroundImage: lightBackgroundImage,
    lightBackgroundImage,
    darkBackgroundImage,
    density:
      input.density === "compact" || input.density === "comfortable" ? input.density : "standard",
    fontScale: input.fontScale === "large" ? "large" : "normal",
    subjectColors: {
      english: hexColor(subjects.english, DEFAULT_APPEARANCE.subjectColors.english),
      politics: hexColor(subjects.politics, DEFAULT_APPEARANCE.subjectColors.politics),
      p731: hexColor(subjects.p731, DEFAULT_APPEARANCE.subjectColors.p731),
      p837: hexColor(subjects.p837, DEFAULT_APPEARANCE.subjectColors.p837),
    },
  }
}

export function appearanceEndpoint(site) {
  if (!APPEARANCE_SITES.includes(site)) {
    throw new Error(`Unknown YEUTECH appearance site: ${site}`)
  }
  return `/api/portal/appearance?site=${encodeURIComponent(site)}`
}

function defaultResolveImage(source) {
  if (!source) return "none"
  try {
    const base =
      typeof window !== "undefined" && window.location ? window.location.origin : "https://yeutech.invalid"
    const url = new URL(source, base)
    if (url.protocol !== "http:" && url.protocol !== "https:") return "none"
    return `url("${url.href.replace(/["\\\n\r]/g, "")}")`
  } catch {
    return "none"
  }
}

/**
 * Pure mapping from appearance settings to contract inputs.
 * `resolveImage(source, mode)` lets a site rewrite wallpaper URLs (for example through its
 * own same-origin proxy) and must return a CSS <image> or "none".
 */
export function appearanceVariables(value, { resolveImage = defaultResolveImage } = {}) {
  const settings = normalizeAppearance(value)
  const wallpaper = (source, mode) =>
    settings.backgroundStyle === "image" ? resolveImage(source, mode) || "none" : "none"
  return {
    "--yt-accent": settings.accentColor,
    "--yt-background-opacity": (settings.backgroundOpacity / 100).toFixed(3),
    "--yt-surface-alpha": `${settings.surfaceOpacity}%`,
    "--yt-material-alpha": `${settings.materialOpacity}%`,
    "--yt-chrome-alpha": `${settings.chromeOpacity}%`,
    "--yt-control-alpha": `${settings.controlOpacity}%`,
    "--yt-overlay-alpha": `${settings.overlayOpacity}%`,
    "--yt-dim-alpha": `${settings.overlayDim}%`,
    "--yt-blur": `${settings.glassBlur}px`,
    "--yt-liquid": (settings.liquidIntensity / 100).toFixed(3),
    "--yt-lens": `${settings.lensEdgeWidth}px`,
    "--yt-radius": `${settings.cornerRadius}px`,
    "--yt-wallpaper-light": wallpaper(settings.lightBackgroundImage, "light"),
    "--yt-wallpaper-dark": wallpaper(settings.darkBackgroundImage, "dark"),
    "--subject-english": settings.subjectColors.english,
    "--subject-politics": settings.subjectColors.politics,
    "--subject-p731": settings.subjectColors.p731,
    "--subject-p837": settings.subjectColors.p837,
  }
}

export function prefersDarkScheme() {
  return Boolean(
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
  )
}

export function resolveDarkMode(value, prefersDark = prefersDarkScheme()) {
  const settings = normalizeAppearance(value)
  return settings.theme === "dark" || (settings.theme === "system" && prefersDark)
}

/**
 * Apply the portal appearance to an element (normally <html>). Returns the normalized
 * settings and the resolved light/dark mode.
 */
export function applyAppearance(value, { root, resolveImage, prefersDark } = {}) {
  const target = root || document.documentElement
  const settings = normalizeAppearance(value)
  const dark = resolveDarkMode(settings, prefersDark ?? prefersDarkScheme())
  target.dataset.ytContract = MATERIAL_CONTRACT_VERSION
  target.dataset.ytTheme = dark ? "dark" : "light"
  target.dataset.appTheme = settings.theme
  target.dataset.backgroundStyle = settings.backgroundStyle
  target.dataset.density = settings.density
  target.dataset.fontScale = settings.fontScale
  target.dataset.liquid = settings.liquidIntensity > 0 ? "on" : "off"
  target.style.colorScheme = dark ? "dark" : "light"
  for (const [name, cssValue] of Object.entries(appearanceVariables(settings, { resolveImage }))) {
    target.style.setProperty(name, cssValue)
  }
  return { settings, dark }
}

/** Re-apply when the OS scheme changes while the portal theme is "system". */
export function watchSystemScheme(getSettings, options = {}) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  const onChange = () => {
    const settings = normalizeAppearance(getSettings())
    if (settings.theme === "system") applyAppearance(settings, { ...options, prefersDark: query.matches })
  }
  query.addEventListener?.("change", onChange)
  return () => query.removeEventListener?.("change", onChange)
}

/** Read the portal payload for one site. Throws when the portal cannot confirm settings. */
export async function fetchAppearance(site, { fetchImpl, endpoint } = {}) {
  const request = fetchImpl || fetch
  const response = await request(endpoint || appearanceEndpoint(site), {
    cache: "no-store",
    credentials: "same-origin",
  })
  const type = response.headers?.get?.("content-type") || ""
  const payload = type.includes("application/json") ? await response.json() : null
  if (!response.ok || !payload?.ok || !payload.settings) {
    throw new Error("portal appearance unavailable")
  }
  return {
    ...payload,
    settings: normalizeAppearance(payload.settings),
    baseline: payload.baseline ? normalizeAppearance(payload.baseline) : null,
  }
}
