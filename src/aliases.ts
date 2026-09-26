import type { PiQoderModel } from "./models.js";

/**
 * Friendly alias ids for the model picker.
 *
 * pi renders the model `id` in `/model` rows and `--list-models`, while the
 * Qoder SDK only understands its own opaque values (`qfmodel`, ...). Aliases
 * let users see/select `qwen3.8-flash` while turns transparently use the SDK
 * value. Built-in fallbacks (`lite`/`auto`/`performance`) keep their ids so
 * the default model and opencode parity never break.
 *
 * Safety rules (all verified by smoke tests):
 * - aliases never shadow a fallback id or any other model's SDK value, so
 *   unknown ids always resolve to themselves (old sessions keep working);
 * - mapping is deterministic per catalog: display order wins, collisions get
 *   `-2`/`-3` suffixes;
 * - the map persists in `catalog.json` (v2) and hydrates synchronously at
 *   load, so restored sessions resolve even before the background warm.
 */

/** Alias -> SDK value. Empty until a catalog registers/hydrates. */
let registry = new Map<string, string>();

export function setAliasRegistry(map: Map<string, string> | Record<string, string>): void {
  registry = map instanceof Map ? new Map(map) : new Map(Object.entries(map));
}

export function getAliasRegistry(): Record<string, string> {
  return Object.fromEntries(registry);
}

/** Resolve a picker id to the SDK model value. Unknown ids pass through. */
export function resolveSdkModel(id: string): string {
  return registry.get(id) ?? id;
}

function slugify(displayName: string): string | null {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 128);
  if (!slug || slug === "__proto__" || slug === "prototype" || slug === "constructor") return null;
  return slug;
}

/**
 * Build alias -> SDK value for a catalog. Fallback ids are reserved, and no
 * alias may equal any model's SDK value (keeps raw-id sessions unambiguous).
 */
export function buildAliasMap(models: PiQoderModel[]): Map<string, string> {
  const fallbackIds = new Set(["lite", "auto", "performance"]);
  const sdkValues = new Set(models.map((m) => m.id));
  const taken = new Set<string>([...fallbackIds, ...sdkValues]);
  const map = new Map<string, string>();
  for (const m of models) {
    if (fallbackIds.has(m.id)) {
      map.set(m.id, m.id);
      continue;
    }
    const base = slugify(m.name);
    if (!base || base === m.id) {
      map.set(m.id, m.id);
      continue;
    }
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
    taken.add(alias);
    map.set(alias, m.id);
  }
  return map;
}

/** Picker id for a model given a prebuilt alias map (falls back to SDK id). */
export function aliasForModel(m: PiQoderModel, aliases: Map<string, string>): string {
  for (const [alias, sdkValue] of aliases) {
    if (sdkValue === m.id) return alias;
  }
  return m.id;
}
