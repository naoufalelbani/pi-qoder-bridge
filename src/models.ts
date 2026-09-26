import { query } from "@qoder-ai/qoder-agent-sdk";
import type { ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import type { ProviderModelsStore } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { aliasForModel } from "./aliases.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface PiQoderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const FALLBACK_MODELS: PiQoderModel[] = [
  {
    id: "lite",
    name: "Qoder Lite (free)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
  {
    id: "auto",
    name: "Qoder Auto (1.0x)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
  {
    id: "performance",
    name: "Qoder Performance (1.1x)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1.1, output: 1.1, cacheRead: 0.11, cacheWrite: 1.1 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
];

const UNSAFE_IDS = new Set(["__proto__", "prototype", "constructor"]);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_LENGTH = 128;
const MAX_DYNAMIC_MODELS = 512;

/** Map live ModelInfos to internal defs (shared by discovery + stream updates). */
export function fromModelInfos(models: ModelInfo[]): PiQoderModel[] {
  const mapped: PiQoderModel[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const entry = mapModelInfo(m as ModelInfo);
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      mapped.push(entry);
      if (mapped.length >= MAX_DYNAMIC_MODELS) break;
    }
  }
  return mapped;
}

function mapModelInfo(m: ModelInfo): PiQoderModel | null {
  if (!isRecord(m)) return null;
  const value = (m as { value?: unknown }).value;
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.length > MAX_ID_LENGTH) return null;
  if (UNSAFE_IDS.has(value)) return null;
  if (CONTROL_CHARS.test(value)) return null;
  if ((m as { isEnabled?: unknown }).isEnabled === false) return null;
  const factor =
    typeof m.priceFactor === "number" && Number.isFinite(m.priceFactor) && m.priceFactor >= 0
      ? m.priceFactor
      : 1;
  const vl = m.isVl === undefined ? true : m.isVl === true;
  const rawDisplay =
    typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : value;
  const display = rawDisplay
    .replace(CONTROL_CHARS, " ")
    .trim()
    .slice(0, MAX_DISPLAY_LENGTH);
  if (!display) return null;
  const context =
    typeof m.maxInputTokens === "number" && m.maxInputTokens > 0 ? Math.floor(m.maxInputTokens) : 200_000;
  const output =
    typeof m.maxOutputTokens === "number" && m.maxOutputTokens > 0 ? Math.floor(m.maxOutputTokens) : 32_000;
  return {
    id: value,
    name: display || value,
    reasoning: m.isReasoning === true,
    input: vl ? ["text", "image"] : ["text"],
    cost: {
      input: factor,
      output: factor,
      cacheRead: Number((factor * 0.1).toFixed(4)),
      cacheWrite: factor,
    },
    contextWindow: context,
    maxTokens: output,
  };
}

/**
 * Bounded live discovery. Returns null when offline/unauthenticated so the
 * caller falls back to FALLBACK_MODELS (or a persisted catalog).
 * Mirrors opencode-qoder-bridge/src/models.ts fetchDynamicModels() filtering:
 * disabled entries dropped, unsafe ids and control chars rejected, 512 cap.
 */
export async function discoverQoderModels(
  timeoutMs = 10_000,
  probeModel = "auto",
): Promise<PiQoderModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  let q: ReturnType<typeof query> | undefined;
  try {
    const { qoderAuth } = await import("./auth.js");
    q = query({
      prompt: "ping",
      options: {
        auth: qoderAuth(),
        model: probeModel,
        abortController: controller,
        persistSession: false,
        env: process.env as Record<string, string | undefined>,
        controlRequestTimeoutMs: 5_000,
        closeGraceMs: 500,
      },
    });
    await q.initializationResult();
    const models = await q.getAvailableModels({ fetchStrategy: "live" });
    if (!Array.isArray(models) || models.length === 0) return null;
    const mapped = fromModelInfos(models as ModelInfo[]);
    return mapped.length > 0 ? mapped : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (q) {
      try {
        await q.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Merge live models over the built-in fallbacks (opencode parity:
 * `rebuildIndex` always keeps lite/auto/performance; live entries win on
 * id collision with fresher metadata). Guarantees a non-empty catalog that
 * always contains the default model id.
 */
export function mergeWithFallbacks(live: PiQoderModel[]): PiQoderModel[] {
  const merged = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
  for (const m of live) merged.set(m.id, m);
  return [...merged.values()];
}

/** Map internal model defs to pi provider model configs (registration + refresh). */
export function toProviderModelConfigs(
  models: PiQoderModel[],
  aliases?: Map<string, string>,
): ProviderModelConfig[] {
  return models.map((m) => {
    const id = aliases ? aliasForModel(m, aliases) : m.id;
    return {
      id,
      name: m.name,
      reasoning: m.reasoning,
      input: [...m.input],
      cost: { ...m.cost },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    };
  });
}

export function isValidStoredModel(m: unknown): m is PiQoderModel {
  if (!isRecord(m)) return false;
  const r = m as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    r.id.length === 0 ||
    r.id.length > MAX_ID_LENGTH ||
    UNSAFE_IDS.has(r.id) ||
    CONTROL_CHARS.test(r.id)
  )
    return false;
  if (
    typeof r.name !== "string" ||
    r.name.length === 0 ||
    typeof r.contextWindow !== "number" ||
    typeof r.maxTokens !== "number"
  )
    return false;
  // Display paths call input.join() and read cost multipliers; reject shapes
  // that would throw there instead of failing at render time.
  if (!Array.isArray(r.input) || !r.input.every((v) => v === "text" || v === "image")) return false;
  const cost = r.cost;
  if (!isRecord(cost)) return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof cost[key] !== "number" || !Number.isFinite(cost[key] as number)) return false;
  }
  return true;
}

/** Read the persisted catalog (pi-managed store, scoped to our provider id). */
export async function readStoredCatalog(
  store: ProviderModelsStore,
): Promise<PiQoderModel[] | null> {
  try {
    const entry = await store.read();
    const models = (entry as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(models) || models.length === 0) return null;
    const valid = models.filter(isValidStoredModel).slice(0, MAX_DYNAMIC_MODELS);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/**
 * Persist the live catalog (best-effort). Stored as full Model objects so
 * pi's freshness bookkeeping (`checkedAt`) applies; never throws.
 */
export async function writeStoredCatalog(
  store: ProviderModelsStore,
  models: PiQoderModel[],
  api: string,
  provider: string,
): Promise<void> {
  try {
    const full = models.map((m) => ({ ...toProviderModelConfigs([m])[0], api, provider }));
    await store.write({ models: full as never, checkedAt: Date.now() });
  } catch {
    /* best-effort */
  }
}
