# Releasing pi-qoder-bridge

Separate repo, lockstep versions with `opencode-qoder-bridge`.
Both packages share version numbers and release together (`0.2.0` was the
first aligned release). The pi package intentionally stays provider + usage
only.

## Sync contract (port every change in these areas)

1. `@qoder-ai/qoder-agent-sdk` version — identical in both repos (currently
   pinned `1.0.50`, no caret).
2. `auth`: PAT env, `.qoderwork` / `.qoder` / `.qoder-cn` login files,
   region-aware hint wording.
3. `models`: fallback `lite` / `auto` / `performance` defs, unsafe-id and
   control-char filtering, 512 cap, 10s discovery timeout.
4. `usage`: `getUsageInfo()` with 60s cache, same credential hint.
5. `engines`: same Node range.

Host-specific code is never copied: pi uses `ExtensionAPI` +
`streamSimple`; opencode uses Plugin hooks + AI SDK v3 + TUI.

State is isolated: pi defaults to `~/.config/pi-qoder-bridge`
(`PI_QODER_BRIDGE_STATE_DIR` override). Never honor
`QODER_BRIDGE_STATE_DIR` here.

## Release gate

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
# verify dist/ + README + CHANGELOG + LICENSE in tarball
npm publish --access public
```

Then release `opencode-qoder-bridge` at the same version (see its
`RELEASING.md` lockstep section), and verify:

```bash
npm view pi-qoder-bridge
npm view opencode-qoder-bridge
```

```bash
pi -e ./dist/index.js
# /model -> qoder/auto, /qoder_usage, /qoder_models
```

Never reuse a published version. For a bad release, publish a new
lockstep patch in both repos and deprecate the defective one.
