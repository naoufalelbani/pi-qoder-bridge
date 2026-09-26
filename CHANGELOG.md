# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

Lockstep policy: `pi-qoder-bridge` and `opencode-qoder-bridge` share version
numbers and release together. `0.2.0` is the first aligned release. The pi
package intentionally stays provider + usage only (no cost ledger, sessions,
MCP bridging, or TUI sidebar).

## [0.2.0] - 2026-09-26

First public release. Lockstep-aligned with `opencode-qoder-bridge@0.2.0`.

### Added

- Qoder provider for pi (`pi.registerProvider("qoder")`) with token
  streaming, `qoder_usage` / `qoder_models` tools, and `/qoder_usage` /
  `/qoder_models` commands (live `getUsageInfo()`, cached 60s).
- Pi-native model catalog via `refreshModels`: built-in `lite` / `auto` /
  `performance` fallbacks register immediately (no blocking startup
  discovery); live results persist in pi's provider-scoped store and a
  last-known-good `catalog.json`, with background warm + re-register after
  load and live-over-fallback merging (fallbacks never disappear).
- Friendly alias ids in the picker (`qfmodel` → `qwen3.8-flash`), since pi
  rows print ids while Qoder's values are opaque. Aliases map back to SDK
  values on turns (restored sessions included), never shadow fallback ids or
  raw values, and persist in the v2 catalog cache.
- `/login qoder` support (OAuth passthrough): CLI-login users (`qoder` /
  CN-CLI sessions) light up the provider without a PAT. Request auth always
  happens SDK-side.
- Centralized env-based configuration: `PI_QODER_DEFAULT_MODEL`,
  `PI_QODER_DISCOVERY_TIMEOUT_MS`, `PI_QODER_DISABLE_DISCOVERY`,
  `PI_QODER_DISABLE_PARTIALS`, `PI_QODER_CONTROL_TIMEOUT_MS`,
  `PI_QODER_CLOSE_GRACE_MS`, `PI_QODER_INIT_TIMEOUT_MS`,
  `PI_QODER_GOAL_MAX_TURNS`, `PI_QODER_SDK_DEBUG`. See `.env.example`.
- User-side config templates: `settings.example.json` and `.env.example`.
- Isolated on-disk state identity: default `~/.config/pi-qoder-bridge`,
  override `PI_QODER_BRIDGE_STATE_DIR`. `QODER_BRIDGE_STATE_DIR` is
  deliberately not honored so one bridge can never redirect the other's state.
- `.qoderwork` login detection alongside `.qoder` / `.qoder-cn`, matching
  the opencode bridge, plus a region-aware auth hint (`QODER_REGION=cn`).
- Terminal stop reasons: `max_tokens` closes turns as `length` (with
  `rawStopReason`); `permission_denied` runtime events surface as transcript
  text; credential-shaped failures hint `/login qoder`.
- Runtime observability: `qodercli` stderr captured into the debug log when
  debugging is on; system prompt travels on the SDK channel; live
  `available_models_update` frames refresh the file cache; concurrent
  catalog refreshes share one in-flight discovery.

### Changed

- Hardened live model filtering to match the opencode bridge: unsafe ids
  rejected, control characters stripped/rejected, 512-model cap.
- Usage tool reports the same credential hint wording as the opencode bridge.
- Model `cost` rates are Qoder price multipliers, not dollars: pi session $
  totals for qoder are relative estimates, not real charges.
- No-credential startup warning is debug-only; background discovery is
  skipped without credentials.
- Package metadata: author, repository, homepage, bugs, publish config.

### Fixed

- Register the provider with `baseUrl` (pi requires it for custom models and
  rejected the registration otherwise, so `qoder/*` never appeared in
  `/model` — the error was silent in list mode).
- Native SDK tool calls are recorded as transcript text, never forwarded as
  pi tool calls. Forwarding them made pi re-execute runtime-owned side
  effects (double Bash/Read/Edit) or fail on name/schema mismatches; turns
  now always close as `stop`.
- Agent activity is visible while it happens: tool calls emit
  `[Qoder running: <tool>…]` at invocation with the summary at completion;
  stop frames match by event index so summaries can't arrive out of order.
- Stalled runtimes fail fast instead of hanging minutes: bounded control
  round-trips plus an independent init watchdog (the SDK's own initialize
  timeout is hardcoded), with retry guidance instead of raw SDK messages.
- Fixed a crash: the background catalog warm could re-register after pi
  invalidated the extension context (session replacement/reload), killing pi
  with an "extension ctx is stale" dump. The detached task is now guarded.
- Exception hardening across every async boundary: terminal stream failures
  can't escape as unhandled rejections; null/garbage catalog entries,
  poisoned stored models, and malformed contexts degrade instead of
  throwing; command handlers and `refreshModels` fall back instead of
  failing listings.

## [0.1.0] - 2026-09-26

### Added

- Initial internal snapshot (superseded by 0.2.0 before any public release).
