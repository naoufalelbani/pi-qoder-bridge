import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiQoderModel } from "./models.js";
import { isValidStoredModel } from "./models.js";
import { resolveStateDir } from "./state-dir.js";

const CATALOG_FILE = "catalog.json";
const MAX_CATALOG_BYTES = 256 * 1024;

interface CatalogCachePayload {
  version: 2;
  models: PiQoderModel[];
  /** Alias -> SDK value map (see src/aliases.ts). */
  aliases: Record<string, string>;
}

function cacheFile(stateDir: string = resolveStateDir()): string {
  return join(stateDir, CATALOG_FILE);
}

/**
 * Last-known-good catalog (opencode parity: instant complete list at load,
 * refreshed in the background). Sync, local file only. Returns null when
 * missing, oversized, or failing validation — callers use fallbacks.
 */
export function readCatalogCache(stateDir: string = resolveStateDir()): PiQoderModel[] | null {
  try {
    const file = cacheFile(stateDir);
    if (!existsSync(file)) return null;
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_CATALOG_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Partial<CatalogCachePayload>;
    if (payload.version !== 2 || !Array.isArray(payload.models) || payload.models.length === 0) return null;
    const valid = payload.models.filter(isValidStoredModel);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/** Read the persisted alias map (v2 payloads only; v1 caches are ignored). */
export function readCatalogAliases(stateDir: string = resolveStateDir()): Record<string, string> | null {
  try {
    const raw = readFileSync(cacheFile(stateDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Partial<CatalogCachePayload>;
    if (payload.version !== 2 || !payload.aliases || typeof payload.aliases !== "object") return null;
    const entries = Object.entries(payload.aliases).filter(
      ([alias, sdkValue]) =>
        typeof alias === "string" &&
        alias.length > 0 &&
        alias.length <= 256 &&
        typeof sdkValue === "string" &&
        sdkValue.length > 0 &&
        sdkValue.length <= 256,
    );
    if (entries.length === 0 || entries.length > 1024) return null;
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

/** Persist the live catalog + alias map (best-effort, never throws). */
export function writeCatalogCache(
  models: PiQoderModel[],
  aliases: Record<string, string> = {},
  stateDir: string = resolveStateDir(),
): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const payload: CatalogCachePayload = { version: 2, models: models.slice(0, 512), aliases };
    writeFileSync(cacheFile(stateDir), JSON.stringify(payload), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
