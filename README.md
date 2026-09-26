# pi-qoder-bridge

Qoder provider extension for [pi.dev](https://pi.dev) (`pi` coding agent), powered by the official [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk).

Port of [`opencode-qoder-bridge`](https://www.npmjs.com/package/opencode-qoder-bridge) concepts to pi's `ExtensionAPI`:

| opencode-qoder-bridge | pi-qoder-bridge (this) |
|---|---|
| `Plugin.config()` injects `provider.qoder` models | `pi.registerProvider("qoder", ...)` |
| AI SDK v3 `languageModel` streaming | pi-ai `streamSimple` via `createAssistantMessageEventStream` |
| `tool()` + TUI slash commands | `pi.registerTool()` + `pi.registerCommand()` |
| `getAvailableModels()` live discovery (10s) + cache + `lite/auto/performance` fallbacks | pi-native `refreshModels` + provider-scoped store + same fallbacks (in `src/models.ts`) |
| local cost ledger + `getUsageInfo()` | v1: live `getUsageInfo()` only (cached 60s) |

> Independent community project. Not affiliated with Qoder or pi. Qoder usage subject to [Qoder Product Service Terms](https://qoder.com/product-service).

> Separate repo, lockstep versions with [`opencode-qoder-bridge`](https://www.npmjs.com/package/opencode-qoder-bridge).
> Both packages share version numbers and release together (aligned from `0.2.0`).
> The pi package intentionally stays provider + usage only.

## Quick start

Requirements: Node 22.22.2+ or 24.15.0+, `pi` installed, Qoder auth.

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
# or: qoder login  (CN region: CN-CLI login)

cd pi-qoder-bridge
npm install
npm run build

# quick test without installing:
pi -e ./dist/index.js

# inside pi:
/model          # select qoder/auto
/qoder_usage
/qoder_models
```

## Install as pi package

> Until the first `npm publish`, the package is **not** on the npm registry —
> use the local-checkout flow below, not `packages: ["npm:pi-qoder-bridge"]`.

```bash
# from a clone of this repo:
npm install
npm run build
pi -e "$PWD/dist/index.js"   # temporary: this run only
```

To load it on every run, add the **absolute** path to the `extensions`
array in `~/.pi/agent/settings.json` (user level) instead of `packages`:

```json
{
  "extensions": ["/absolute/path/to/pi-qoder-bridge/dist/index.js"]
}
```

Once published:

```bash
# local link test (mirrors pi publishing guide):
npm link
pi install link:pi-qoder-bridge

# or npm:
npm publish
pi install npm:pi-qoder-bridge
```

`package.json` uses the `pi.extensions` manifest pointing at compiled JS:

```json
{ "pi": { "extensions": ["./dist/index.js"] } }
```

Runtime deps must stay in `dependencies` (pi installs with `--omit=dev`).

## Configuration

The bridge takes no structured settings from pi — everything is env-based
(see `src/config.ts`, `.env.example`). User-side pi config lives in
`~/.pi/agent/settings.json` (user level) or `.pi/settings.json` (project
level); a template is provided in `settings.example.json`.

```json
{
  "packages": ["npm:pi-qoder-bridge"],
  "defaultProvider": "qoder",
  "defaultModel": "auto"
}
```

For a local checkout instead of npm, point pi at the built file:

```bash
pi -e ./dist/index.js
```

or list `./dist/index.js` under the `extensions` array in settings.

| Variable | Default | Purpose |
|---|---|---|
| `QODER_PERSONAL_ACCESS_TOKEN` | — | Preferred auth (SDK Worker runtime). Without it, the SDK falls back to `qoder` / CN-CLI login files. |
| `QODER_REGION` | `auto` | `auto` \| `global` \| `cn`. `cn` yields the CN login hint. |
| `PI_QODER_DEFAULT_MODEL` | `auto` | Probe model for the live-catalog discovery query. |
| `PI_QODER_DISCOVERY_TIMEOUT_MS` | `10000` | Live discovery timeout in ms (clamped 1000–60000). |
| `PI_QODER_DISABLE_DISCOVERY` | — | Set to `1`/`true` to skip live discovery (offline / fast startup, built-in `lite`/`auto`/`performance` fallbacks only). |
| `PI_QODER_DISABLE_PARTIALS` | — | Set to `1`/`true` to disable token streaming (falls back to complete-message delivery). |
| `PI_QODER_GOAL_MAX_TURNS` | — | Cap on SDK agent goal pursuits per turn (positive int; omitted by default). |
| `PI_QODER_SDK_DEBUG` | — | Set to `1`/`true` to forward `--debug` to qodercli (verbose). CLI stderr is captured in the debug log whenever debugging is on, regardless. |
| `PI_QODER_CONTROL_TIMEOUT_MS` | `60000` | Per-control-request timeout in ms for turns (10s–5min). Bounds a stalled Qoder runtime (e.g. hanging `initialize`) instead of hanging for minutes on the SDK default. |
| `PI_QODER_INIT_TIMEOUT_MS` | `60000` | Budget in ms for the first SDK message of a turn (10s–5min). Independent watchdog — the SDK's own initialize timeout is hardcoded, so this aborts a fully wedged runtime instead. |
| `PI_QODER_CLOSE_GRACE_MS` | `2000` | SDK shutdown grace in ms (0–30s). |
| `PI_QODER_BRIDGE_STATE_DIR` | `~/.config/pi-qoder-bridge` | Isolated on-disk state dir (respects `XDG_CONFIG_HOME`). |
| `PI_QODER_BRIDGE_DEBUG` / `QODER_BRIDGE_DEBUG` | — | Set to `1` for startup/status notices. |

Model catalog behavior: built-ins (`lite`/`auto`/`performance`) register
immediately and are always present (same as opencode); pi refreshes the live
catalog via `refreshModels` (SDK `getAvailableModels()`, bounded by the
discovery timeout), and the extension also warms it in the background after
load. Live results overlay the built-ins and persist both in pi's
provider-scoped store and in `catalog.json` under the state dir, so the next
start lists everything instantly — even offline. Any failure falls back
through stored catalog to built-ins; the list is never empty. Note Qoder
marks models `isEnabled: false` per account (e.g. on exhausted quota) and
both bridges hide those — if opencode shows more models than pi, compare the
accounts: set the same `QODER_PERSONAL_ACCESS_TOKEN` in both.

Live models are listed under friendly alias ids derived from their display
names (`qfmodel` → `qwen3.8-flash`), because pi prints ids in `/model` rows.
Aliases transparently map back to SDK values on every turn (including
restored sessions), never shadow fallback ids or raw SDK values, and are
shown with their mapping in `/qoder_models`. Built-ins keep their ids, so
`defaultModel: auto` keeps working.

## What v1 does / doesn't do

- Does: provider registration, token-streamed text/thinking, `/qoder_usage`, `/qoder_models`, PAT + `qoder login` / CN login auth (via SDK `qodercliAuth()`), live catalog via `refreshModels` with persisted + built-in fallbacks.
- Tool execution model: the Qoder runtime runs its own tools (Bash/Read/Edit/…) inside its process. Its tool calls are recorded in the transcript as text (`[Qoder tool call: …]`) and are never forwarded as pi tool calls — forwarding them would execute every side effect twice. `/model` open triggers a catalog refresh; background warm + file cache keep listings instant.
- Costs: model `cost` rates are Qoder price multipliers (like opencode), not dollars — pi session $ totals for qoder are rough relative estimates, not real charges.
- Doesn't (by design, stays provider + usage only): local cost ledger, session persistence mapping, MCP bridging, permission-mode options, image passthrough, plan-mode/memory/evolution flags. These live in `opencode-qoder-bridge` only.

## State isolation

- State dir: `~/.config/pi-qoder-bridge` (override `PI_QODER_BRIDGE_STATE_DIR`, respects `XDG_CONFIG_HOME`).
- Never shares state with `~/.config/opencode-qoder-bridge`; `QODER_BRIDGE_STATE_DIR` is not honored here.

## Sync contract with opencode-qoder-bridge

Kept in sync on every lockstep release: SDK range, auth (PAT + `.qoderwork`/`.qoder`/`.qoder-cn` + region-aware hint), model fallbacks + filtering + 10s discovery, usage cache + hint wording, Node engines. See `RELEASING.md`.

## Auth

- `QODER_PERSONAL_ACCESS_TOKEN` (recommended, uses SDK Worker runtime)
- or `qoder login` → `~/.qoder/.auth/user` (also `.qoderwork`), CN-CLI → `~/.qoder-cn/.auth/user`
- `QODER_REGION=cn` yields the CN login hint; `QODER_BRIDGE_DEBUG=1` or `PI_QODER_BRIDGE_DEBUG=1` for verbose startup notify.
- Auth discovery for turns and the model catalog runs through the SDK
  (`qodercliAuth()`), independent of pi's own `apiKey` resolution — CLI-login
  users get live models and streaming without a PAT.

## Troubleshooting

### Can't find qoder in `/model`?

pi only lists a provider's models when the extension loaded **and** its auth
is configured. Check in order:

1. **Extension loaded?** `pi list` shows installed extensions. Startup errors
   surface in the TUI — with a local checkout, make sure you built first
   (`npm run build`) and load it (`pi -e ./dist/index.js`). Note the npm
   package must be published before `packages: ["npm:pi-qoder-bridge"]` works.
2. **Auth configured?** Either set `QODER_PERSONAL_ACCESS_TOKEN`, or run
   `/login qoder` inside pi (works with `qoder` / CN-CLI login — the bridge
   verifies your CLI session and stores a marker; request auth always happens
   SDK-side). Without one of these, pi hides `qoder/*` from the model list.
3. **Still nothing?** Run with `PI_QODER_BRIDGE_DEBUG=1` — the bridge logs how
   many models registered at session start. `PI_QODER_DISABLE_DISCOVERY=1`
   isolates listing problems from network/catalog issues.

### `Qoder error_during_execution` on a turn?

That text comes from the Qoder backend (most often quota/plan limits), passed
through unchanged. Check your plan/quota, then retry. Run `/qoder_usage` for
the account snapshot. Credential-shaped failures additionally point at
`/login qoder`.

### Agent acts neutered (no file/shell actions)?

If the runtime denies a tool call, the turn now records
`[Qoder permission denied: <tool> — <reason>]` in the transcript instead of
silently doing less. Check that line for the rule/mode that blocked it.

### Turn hangs, then `Control request "initialize" timed out`?

The Qoder runtime (backend or `qodercli` subprocess) stalled instead of
starting the turn — this is Qoder-side, not pi. The bridge caps every control
round-trip at `PI_QODER_CONTROL_TIMEOUT_MS` (default 60s, opencode parity) so
it fails fast with a hint instead of hanging for minutes. If it keeps
happening: check network, re-run `qoder login` (or `/login qoder`), try
`qoder/auto`, and only raise the timeout if you are on a genuinely slow
connection.

## Dev

```bash
npm run typecheck
npm run build
pi -e ./dist/index.js
/reload   # hot-reload after edits + rebuild
```
