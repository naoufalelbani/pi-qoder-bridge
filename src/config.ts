/**
 * Centralized bridge configuration.
 *
 * pi extensions receive no structured settings from the host, so every knob
 * is an environment variable (same pattern as opencode-qoder-bridge).
 * All names are documented in README "Configuration" and `.env.example`.
 */
export interface PiQoderBridgeConfig {
  /** Probe model used for the live-catalog discovery query. Default "auto". */
  defaultModel: string;
  /** Live discovery timeout in ms. Default 10_000, clamped to 1s..60s. */
  discoveryTimeoutMs: number;
  /** When true, skip live discovery and use built-in fallbacks only. */
  disableDiscovery: boolean;
  /**
   * Kill-switch for token streaming. Token-level partials are on by default;
   * set to fall back to complete-message delivery.
   */
  disablePartials: boolean;
  /**
   * Per-control-request timeout in ms for turns (opencode parity default).
   * Bounds the "initialize" stall that otherwise hangs minutes on the SDK
   * default. Default 60_000, clamped to 10s..5min.
   */
  controlTimeoutMs: number;
  /**
   * Budget in ms for the first SDK message of a turn. The SDK's own
   * initialize timeout is hardcoded and a wedged runtime can starve the
   * iterator entirely, so this watchdog aborts independently. Default
   * 60_000, clamped to 10s..5min.
   */
  initTimeoutMs: number;
  /** Grace period in ms for SDK shutdown. Default 2_000, clamped to 0..30s. */
  closeGraceMs: number;
  /** Cap on SDK agent goal pursuits per turn (positive int; omitted by default). */
  goalMaxTurns: number | undefined;
  /**
   * Forward --debug to the qodercli child (verbose runtime logs).
   * Independent from debug: CLI stderr is captured whenever debug is on.
   */
  sdkDebug: boolean;
  /** Verbose startup/status notices. */
  debug: boolean;
}

const DEFAULT_MODEL = "auto";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const MIN_DISCOVERY_TIMEOUT_MS = 1_000;
const MAX_DISCOVERY_TIMEOUT_MS = 60_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 60_000;
const MIN_CONTROL_TIMEOUT_MS = 10_000;
const MAX_CONTROL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const MAX_CLOSE_GRACE_MS = 30_000;
const MAX_MODEL_ID_LENGTH = 256;

function cleanModelId(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value.length > MAX_MODEL_ID_LENGTH) return undefined;
  if (value === "__proto__" || value === "prototype" || value === "constructor") return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  return value;
}

function cleanTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DISCOVERY_TIMEOUT_MS;
  return Math.min(MAX_DISCOVERY_TIMEOUT_MS, Math.max(MIN_DISCOVERY_TIMEOUT_MS, Math.floor(parsed)));
}

function cleanControlTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CONTROL_TIMEOUT_MS;
  return Math.min(MAX_CONTROL_TIMEOUT_MS, Math.max(MIN_CONTROL_TIMEOUT_MS, Math.floor(parsed)));
}

function cleanInitTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_INIT_TIMEOUT_MS;
  return Math.min(MAX_CONTROL_TIMEOUT_MS, Math.max(MIN_CONTROL_TIMEOUT_MS, Math.floor(parsed)));
}

function cleanCloseGraceMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CLOSE_GRACE_MS;
  return Math.min(MAX_CLOSE_GRACE_MS, Math.max(0, Math.floor(parsed)));
}

function cleanGoalMaxTurns(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function isTruthy(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PiQoderBridgeConfig {
  return {
    defaultModel: cleanModelId(env.PI_QODER_DEFAULT_MODEL) ?? DEFAULT_MODEL,
    discoveryTimeoutMs: cleanTimeoutMs(env.PI_QODER_DISCOVERY_TIMEOUT_MS),
    disableDiscovery: isTruthy(env.PI_QODER_DISABLE_DISCOVERY),
    disablePartials: isTruthy(env.PI_QODER_DISABLE_PARTIALS),
    controlTimeoutMs: cleanControlTimeoutMs(env.PI_QODER_CONTROL_TIMEOUT_MS),
    initTimeoutMs: cleanInitTimeoutMs(env.PI_QODER_INIT_TIMEOUT_MS),
    closeGraceMs: cleanCloseGraceMs(env.PI_QODER_CLOSE_GRACE_MS),
    goalMaxTurns: cleanGoalMaxTurns(env.PI_QODER_GOAL_MAX_TURNS),
    sdkDebug: isTruthy(env.PI_QODER_SDK_DEBUG),
    debug: env.QODER_BRIDGE_DEBUG === "1" || env.PI_QODER_BRIDGE_DEBUG === "1",
  };
}
