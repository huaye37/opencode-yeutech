/* YEUTECH Material Contract 2.0.0 type declarations. Canonical source; see the .mjs header. */

export type AppearanceSite =
  | "nas"
  | "media"
  | "print"
  | "router"
  | "codex"
  | "creator"
  | "api"
  | "kaoyan"
  | "worklog"

export type SubjectColors = Record<"english" | "politics" | "p731" | "p837", string>

export type PortalAppearance = {
  version: 1
  updatedAt: string | null
  theme: "light" | "dark" | "system"
  accentColor: string
  backgroundStyle: "plain" | "grid" | "aurora" | "image"
  backgroundImage: string
  lightBackgroundImage: string
  darkBackgroundImage: string
  backgroundOpacity: number
  surfaceOpacity: number
  materialOpacity: number
  chromeOpacity: number
  controlOpacity: number
  overlayOpacity: number
  overlayDim: number
  glassBlur: number
  liquidIntensity: number
  lensEdgeWidth: number
  cornerRadius: number
  density: "compact" | "standard" | "comfortable"
  fontScale: "normal" | "large"
  subjectColors: SubjectColors
}

export type AppearanceNumericField =
  | "backgroundOpacity"
  | "surfaceOpacity"
  | "materialOpacity"
  | "chromeOpacity"
  | "controlOpacity"
  | "overlayOpacity"
  | "overlayDim"
  | "glassBlur"
  | "liquidIntensity"
  | "lensEdgeWidth"
  | "cornerRadius"

export type ResolveImage = (source: string, mode: "light" | "dark") => string

export declare const MATERIAL_CONTRACT_VERSION: "2.0.0"
export declare const APPEARANCE_SITES: readonly AppearanceSite[]
export declare const DEFAULT_BACKGROUND_IMAGES: Readonly<{ light: string; dark: string }>
export declare const DEFAULT_APPEARANCE: Readonly<PortalAppearance>
export declare const APPEARANCE_RANGES: Readonly<Record<AppearanceNumericField, readonly [number, number]>>
export declare const CONTRACT_INPUT_VARIABLES: readonly string[]

export declare function normalizeAppearance(value?: Partial<PortalAppearance> | null): PortalAppearance
export declare function appearanceEndpoint(site: AppearanceSite): string
export declare function appearanceVariables(
  value?: Partial<PortalAppearance> | null,
  options?: { resolveImage?: ResolveImage }
): Record<string, string>
export declare function prefersDarkScheme(): boolean
export declare function resolveDarkMode(value?: Partial<PortalAppearance> | null, prefersDark?: boolean): boolean
export declare function applyAppearance(
  value?: Partial<PortalAppearance> | null,
  options?: { root?: HTMLElement; resolveImage?: ResolveImage; prefersDark?: boolean }
): { settings: PortalAppearance; dark: boolean }
export declare function watchSystemScheme(
  getSettings: () => Partial<PortalAppearance> | null,
  options?: { root?: HTMLElement; resolveImage?: ResolveImage }
): () => void
export declare function fetchAppearance(
  site: AppearanceSite,
  options?: { fetchImpl?: typeof fetch; endpoint?: string }
): Promise<{
  ok: true
  scope?: string
  customizedFields?: string[]
  settings: PortalAppearance
  baseline: PortalAppearance | null
  [key: string]: unknown
}>
