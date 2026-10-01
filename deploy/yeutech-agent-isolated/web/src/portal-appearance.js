import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  fetchAppearance,
  normalizeAppearance,
  watchSystemScheme,
} from "./design/yeutech-material-contract.mjs";

export const APPEARANCE_SITE = "agent";

// Portal-owned stock backgrounds live on the portal frontend, while per-user uploads
// remain same-origin API resources on every sub-site.
export function resolveWorkbenchImage(source) {
  if (typeof source !== "string" || !source.trim()) return "none";
  try {
    let url = new URL(source, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "none";
    if (url.origin === window.location.origin && url.pathname.startsWith("/backgrounds/") && window.location.hostname === "agent.yeutech.cn") {
      url = new URL(`${url.pathname}${url.search}`, "https://yeutech.cn");
    }
    return `url("${url.href.replace(/["\\\n\r]/g, "")}")`;
  } catch {
    return "none";
  }
}

let current = normalizeAppearance(DEFAULT_APPEARANCE);
let stopWatching = null;

export function applyPortalAppearance(value = DEFAULT_APPEARANCE) {
  const { settings } = applyAppearance(value, { resolveImage: resolveWorkbenchImage });
  current = settings;
  if (!stopWatching) stopWatching = watchSystemScheme(() => current, { resolveImage: resolveWorkbenchImage });
  return settings;
}

export async function syncPortalAppearance() {
  try {
    const payload = await fetchAppearance(APPEARANCE_SITE);
    applyPortalAppearance(payload.settings);
    return payload.settings;
  } catch {
    applyPortalAppearance();
    return null;
  }
}
