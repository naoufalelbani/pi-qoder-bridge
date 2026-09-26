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

Publishing is automated: creating (or publishing) a GitHub release runs
`.github/workflows/publish.yml`, which checks the tag out, verifies the tag
matches `package.json`, runs `typecheck` + `build`, and publishes with no OTP
involved. Auth, in order:

1. `NPM_TOKEN` repo secret (automation token — works immediately, including
   the first publish; create at npmjs.com → Access Tokens → Generate New
   Token → Automation, then `gh secret set NPM_TOKEN` and paste it).
2. Otherwise OIDC trusted publishing + provenance (one-time npmjs.com package
   Settings > Trusted Publisher setup for `naoufalelbani/pi-qoder-bridge`,
   workflow `publish.yml`, no environment).

The workflow also has a manual `workflow_dispatch` trigger (takes the tag as
required input) for re-running a publish — first publish via token, or
retrying a failed release publish — without cutting a new release.
Prereleases publish under the `next` dist-tag so `latest` stays stable;
concurrent runs are serialized via a concurrency group.

Release flow:

```bash
# 1. lockstep bump in both repos + changelogs (same version)
# 2. verify locally
npm install
npm run typecheck
npm run build
npm pack --dry-run
# verify dist/ + README + CHANGELOG + LICENSE in tarball
# 3. commit, tag, push
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "pi-qoder-bridge vX.Y.Z"
git push origin main vX.Y.Z
# 4. create the GitHub release (triggers the publish workflow)
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
# 5. watch it: gh run watch, then:
npm view pi-qoder-bridge
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
