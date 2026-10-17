# 2026-10-17 shared model and OpenCode candidate

This isolated candidate preserves the installed `fd6dc0a2d304` Agent baseline,
not the stale NAS source directory. Historical sessions, model selections,
consumer allowlists and maintenance admission guards remain unchanged.
No proxy, gateway, Web Driver or paired API manager is installed by this work.

| Upstream commit / capability | Existing providers and call chain | Implementation | Frontend | Evidence / conclusion |
| --- | --- | --- | --- | --- |
| v1.19.3 / d12161eec reasoning variants | Existing proxy providers -> generated provider config -> official OpenCode binary | packages/core/src/v1/config/provider.ts; packages/opencode/src/provider/{provider,transform}.ts; deploy/yeutech-agent-isolated/src/generate-opencode-config.mjs | Existing independent reasoning and speed controls; no new controls required | Merged. Configured variants retain their override semantics. Provider/transform regressions pass; new production binary acceptance remains pending. |
| v1.19.2 / 3be039593 update discovery | Official CLI -> npm 1.x discovery; YEUTECH still uses independent pinned updater | packages/opencode/src/installation/index.ts; cli/upgrade.ts | No YEUTECH control change | Installation/upgrade regressions pass. Initial test inherited corporate registry; command-scoped npm_config_registry corrected the environment, all 39 installation cases then passed. Global npm config untouched. |
| v1.19.1 / d320177aa discontinued public sharing | Official engine session create/import; BFF does not expose upstream public-share controls | packages/opencode/src/share/session.ts; cli/cmd/import.ts | Not applicable to YEUTECH UI; existing task history is not public sharing | Import regressions pass; no history migration, deletion or new share service. |
| v1.19.0-3 release / generated SDK / Zen documentation | Existing pinned binary, no Zen supplier enabled | package versions, bun.lock, SDK generation, upstream docs | No new supplier or pricing UI | Version-only conflicts resolved to 1.19.3. Bun 1.3.14 frozen-lockfile install passed using command-scoped official registry. |
| Capability schema v2 / verified model identity | CLIProxyAPI -> BFF shared catalog -> workbench and system consumers including Kaoyan | deploy/yeutech-agent-isolated/src/model-catalog.mjs | Existing filtered model picker | v1/v2 compatibility tests pass. Media do not become text agents; unresolved model identities remain unselectable. Proxy candidate is required for corrected source metadata. |
| xAI independent image adapter | Creator / novel -> business image HTTP plugin -> existing xAI channel | image-generation-plugin.mjs; agent-bff.mjs | Provider-declared quality, existing image workload entry | 238 BFF tests pass, including allowlist-safe defaults, parameter rejection, receipt dimensions, idempotency and bounded errors. No additional paid generation; previous real-model audit is separate evidence. |
| Failed-send recovery and preference persistence | Workbench -> BFF session update/prompt | web/src/workbench-actions.js; workbench-conversation.jsx | Yes; installed v3 split interface retained | Desktop and 390x844 fixture browser checks passed: failed draft retained, retry in same session, rapid reasoning/speed edits persist after refresh. Fixture checks are not production model acceptance. |

Validation: OpenCode package typecheck passed; 734 targeted upstream test cases
passed after correcting the command-local registry environment (695 unaffected
cases plus the 39-case installation rerun). Agent tests: 238 passed. Production
web build and unified material-artifact checks passed. Core typecheck and exact
candidate staging are recorded in the external release receipt once completed.

The v1.19.0 preliminary image is superseded by this v1.19.3 candidate. A prepared
image is not a deployment or proof of Fast entitlement. Release requires exact
mergeCommit/sourceDigest/image matching, idle maintenance admission and history
backup. If corrected capabilities require an uninstalled proxy candidate, hold
the consumer until the user installs the paired proxy candidate. Preserve all
original paused worktrees and do not expand workflow credentials.
