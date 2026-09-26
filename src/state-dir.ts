import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single source of truth for pi-qoder-bridge on-disk state.
 *
 * Intentionally isolated from opencode-qoder-bridge:
 * - default dir: ~/.config/pi-qoder-bridge (vs opencode-qoder-bridge)
 * - override env: PI_QODER_BRIDGE_STATE_DIR (vs QODER_BRIDGE_STATE_DIR)
 *
 * Precedence: PI_QODER_BRIDGE_STATE_DIR > XDG_CONFIG_HOME > ~/.config.
 * QODER_BRIDGE_STATE_DIR is deliberately NOT honored here so a global export
 * for one bridge can never redirect the other bridge's ledger/cache.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_QODER_BRIDGE_STATE_DIR?.trim();
  if (override) return join(override);
  const configHome =
    env.XDG_CONFIG_HOME?.trim() || (process.platform === "win32" ? env.APPDATA?.trim() : undefined);
  return join(configHome || join(homedir(), ".config"), "pi-qoder-bridge");
}
