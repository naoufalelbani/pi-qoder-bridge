# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

Lockstep policy: `pi-qoder-bridge` and `opencode-qoder-bridge` share version
numbers and release together. `0.2.0` is the first aligned release. The pi
package intentionally stays provider + usage only (no cost ledger, sessions,
MCP bridging, or TUI sidebar).

## [Unreleased]

### Fixed

- True token streaming: the bridge now sets the SDK `includePartialMessages`
  flag and translates `stream_event` frames into token deltas. Previously pi
  only received complete assistant messages, so each response appeared
  all-at-once after generation. Complete blocks already covered by partials
  are suppressed (opencode `sawStreamText` parity); `PI_QODER_DISABLE_PARTIALS`
  falls back to complete-message delivery.
- Agent activity is visible while it happens: native tool calls emit
  `[Qoder running: <tool>…]` the moment the model invokes them, with the
  argument summary following at completion — previously the whole
  invocation+execution window was silent until the stop frame. Stop frames
  are matched by event index (not tool id), fixing orphaned summaries that
  arrived out of order at result time.

- Register the provider with `baseUrl` (pi requires it for custom models and
  rejected the registration otherwise, so `qoder/*` never appeared in
  `/model` — the error was silent in list mode).
- Added `/login qoder` support (OAuth passthrough): CLI-login users
  (`qoder` / CN-CLI sessions) can now light up the provider without a PAT.
  Request auth still happens SDK-side.
- Auto-load the full catalog like opencode: background warm + re-register
  after load, last-known-good `catalog.json` in the isolated state dir, and
  live-over-fallback merging (opencode `rebuildIndex` parity — `qoder/auto`
  default never disappears). Previously only the 3 fallbacks showed until
  pi's own refresh pass ran.
- Friendly alias ids in the picker (`qfmodel` → `qwen3.8-flash`), since pi
  rows print ids while Qoder's values are opaque. Aliases map back to SDK
  values on turns (restored sessions included), never shadow fallback ids or
  raw values, and persist in the v2 catalog cache (v1 caches are ignored and
  regenerate).
- System prompt now travels on the SDK `systemPrompt` channel instead of
  being inlined as `<system>` user text.
- Terminal stop reasons: `max_tokens` closes turns as `length` (with
  `rawStopReason`); everything else stays `stop`.
- `permission_denied` runtime events surface as transcript text instead of
  silently neutering agentic turns; credential-shaped failures hint
  `/login qoder` (token-limit errors excluded).
- Live `available_models_update` frames refresh the file cache for the next
  start; concurrent catalog refreshes share one in-flight SDK discovery
  instead of spawning a runtime each; the abort forwarder is released on turn
  end.
- Bound every turn control round-trip (`PI_QODER_CONTROL_TIMEOUT_MS`,
  default 60s opencode parity; `PI_QODER_CLOSE_GRACE_MS`, default 2s) so a
  stalled Qoder runtime fails fast instead of hanging minutes on the SDK
  default. Transport timeouts now surface with retry guidance instead of the
  raw SDK message.
- Independent init watchdog (`PI_QODER_INIT_TIMEOUT_MS`, default 60s): the
  SDK's own initialize timeout is hardcoded and a wedged runtime can starve
  the event iterator entirely, so the bridge aborts on first-message budget
  instead.
- Runtime observability without new behavior: `PI_QODER_GOAL_MAX_TURNS` caps
  SDK goal pursuits, `PI_QODER_SDK_DEBUG` forwards `--debug` to qodercli,
  and qodercli stderr is captured into the debug log whenever debugging is
  on.
- Exception hardening across every async boundary: terminal stream failures
  can no longer escape as unhandled rejections even if the event machinery
  itself is broken; null/garbage catalog entries, poisoned stored models,
  and malformed contexts degrade instead of throwing; command handlers and
  `refreshModels` fall back instead of failing listings.
- Native SDK tool calls are recorded as transcript text, never forwarded as
  pi tool calls. Forwarding them made pi re-execute runtime-owned side
  effects (double Bash/Read/Edit) or fail on name/schema mismatches; turns
  now always close as `stop`, and toolCall/toolResult bodies survive in the
  serialized history.
- Fixed a crash: the background catalog warm could re-register after pi
  invalidated the extension context (session replacement/reload), killing pi
  with an "extension ctx is stale" dump. The detached task is now guarded.
- No-credential startup warning is debug-only (it nagged every pi launch),
  and background discovery is skipped without credentials.
- Documented that model `cost` rates are Qoder multipliers, not dollars.

### Added

- Centralized env-based configuration (`src/config.ts`): `PI_QODER_DEFAULT_MODEL`
  (default `auto`), `PI_QODER_DISCOVERY_TIMEOUT_MS` (default `10000`, clamped
  1s–60s), `PI_QODER_DISABLE_DISCOVERY` (offline / fast startup).
- Pi-native model catalog via `refreshModels`: fallbacks register immediately
  (no blocking startup discovery); live results persist in pi's
  provider-scoped store and are reused offline, falling back to
  stored catalog then built-ins.
- User-side config templates: `settings.example.json` (packages +
  defaultProvider/defaultModel) and `.env.example`.

## [0.2.0] - 2026-09-26

### Added

- First lockstep release aligned with `opencode-qoder-bridge@0.2.0`.
- Added isolated on-disk state identity (`src/state-dir.ts`):
  default `~/.config/pi-qoder-bridge`, override `PI_QODER_BRIDGE_STATE_DIR`.
  `QODER_BRIDGE_STATE_DIR` is deliberately not honored so one bridge can never
  redirect the other's state.
- Added `.qoderwork` login detection alongside `.qoder` / `.qoder-cn`,
  matching the opencode bridge.
- Added region-aware auth hint (`QODER_REGION=cn` yields the CN login hint).
- Added `CHANGELOG.md`, `LICENSE`, `RELEASING.md` with the two-repo lockstep
  checklist.

### Changed

- Hardened live model filtering to match the opencode bridge: unsafe ids
  rejected, control characters stripped/rejected, 512-model cap.
- Usage tool reports the same credential hint wording as the opencode bridge.
- Package metadata: author, repository, homepage, bugs, publish config.

## [0.1.0] - 2026-09-26

### Added

- Initial Qoder provider extension for pi (`pi.registerProvider("qoder")`)
  with `streamSimple` streaming (text / thinking / toolCall), 10s startup
  model discovery with `lite` / `auto` / `performance` fallbacks.
- `qoder_usage` and `qoder_models` tools plus `/qoder_usage` and
  `/qoder_models` commands (live `getUsageInfo()`, cached 60s).
