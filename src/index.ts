import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  discoverQoderModels,
  FALLBACK_MODELS,
  mergeWithFallbacks,
  readStoredCatalog,
  toProviderModelConfigs,
  writeStoredCatalog,
} from "./models.js";
import type { PiQoderModel } from "./models.js";
import { streamQoder } from "./stream.js";
import { getQoderUsage } from "./usage.js";
import { cliLoginHint, hasQoderCredential } from "./auth.js";
import { getQoderApiKey, loginQoder, refreshQoderToken } from "./oauth.js";
import { loadConfig } from "./config.js";
import { readCatalogAliases, readCatalogCache, writeCatalogCache } from "./catalog-cache.js";
import { buildAliasMap, getAliasRegistry, resolveSdkModel, setAliasRegistry } from "./aliases.js";
import { resolveStateDir } from "./state-dir.js";

const PROVIDER_ID = "qoder";
const API_ID = "qoder-custom";
// pi requires baseUrl when a provider defines custom models. The SDK-based
// transport in streamQoder never uses it; it is metadata only.
const BASE_URL = "https://qoder.com";

/**
 * pi-qoder-bridge — Qoder provider extension for pi.dev
 *
 * Port of opencode-qoder-bridge concepts to pi's ExtensionAPI:
 * - opencode `Plugin.config()` injecting provider models -> pi.registerProvider()
 * - opencode AI SDK v3 `languageModel` streaming -> pi-ai `streamSimple`
 * - opencode `tool()` + TUI commands -> pi.registerTool() + pi.registerCommand()
 *
 * Reuses @qoder-ai/qoder-agent-sdk directly (no vendoring), same as opencode bridge.
 * Tool execution is delegated to the Qoder runtime (agentic handoff).
 *
 * Configuration is env-based (pi passes no structured settings to extensions);
 * see `src/config.ts`, `.env.example`, and README "Configuration".
 */
export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  // Alias registry first: restored sessions reference picker ids, which must
  // resolve even before the background warm completes.
  const storedAliases = readCatalogAliases();
  if (storedAliases) setAliasRegistry(storedAliases);
  // Latest known catalog: file cache first (instant, opencode parity), then
  // built-in fallbacks. Live results replace it via background warm + refresh.
  let current: PiQoderModel[] = readCatalogCache() ?? FALLBACK_MODELS;

  if (!hasQoderCredential()) {
    // Register anyway so /model lists qoder/*; turns will surface the hint.
    // Matches opencode bridge behavior of falling back to cached/built-ins.
    // Debug-only: every pi launch loads this extension, even for non-users.
    if (config.debug) {
      console.warn(`[pi-qoder-bridge] No Qoder credential. ${cliLoginHint(process.env)}.`);
    }
  }

  const refreshLiveCatalog = async (): Promise<PiQoderModel[] | null> => {
    try {
      // defaultModel may be a picker alias; the SDK needs the raw value.
      return await discoverQoderModels(
        config.discoveryTimeoutMs,
        resolveSdkModel(config.defaultModel),
      );
    } catch {
      return null;
    }
  };

  // Opening /model, the background warm, and TUI refreshes can otherwise
  // fire simultaneously, spawning a qodercli process per caller. Share one
  // in-flight discovery across all of them.
  let inflightDiscovery: Promise<PiQoderModel[] | null> | null = null;
  const sharedLiveCatalog = (): Promise<PiQoderModel[] | null> => {
    if (!inflightDiscovery) {
      inflightDiscovery = refreshLiveCatalog().finally(() => {
        inflightDiscovery = null;
      });
    }
    return inflightDiscovery;
  };

  /** Register a catalog with friendly picker ids (aliases map to SDK values). */
  const configsFor = (catalog: PiQoderModel[]) => {
    const map = buildAliasMap(catalog);
    setAliasRegistry(map);
    return { configs: toProviderModelConfigs(catalog, map), record: Object.fromEntries(map) };
  };

  const registerCatalog = (catalog: PiQoderModel[], persist = true) => {
    current = catalog;
    const { configs, record } = configsFor(catalog);
    if (persist) writeCatalogCache(catalog, record);
    // Re-registration replaces this provider's models (pi semantics).
    pi.registerProvider(PROVIDER_ID, {
      name: "Qoder",
      baseUrl: BASE_URL,
      apiKey: "$QODER_PERSONAL_ACCESS_TOKEN",
      api: API_ID,
      models: configs,
      oauth: {
        name: "Qoder (CLI login / PAT)",
        login: (callbacks) => loginQoder(callbacks),
        refreshToken: (credentials) => refreshQoderToken(credentials),
        getApiKey: (credentials) => getQoderApiKey(credentials),
      },
      refreshModels: async (ctx) => {
        // Listing must never fail because a refresh path threw: fall back.
        // Every inner call is already guarded, so this is pure defense in
        // depth against pi passing a hostile ctx (null store, throwing
        // accessors) or future code adding a throwing path.
        try {
          if (config.disableDiscovery) return configsFor(FALLBACK_MODELS).configs;
          if (!ctx.allowNetwork) {
            const cached = (await readStoredCatalog(ctx.store)) ?? readCatalogCache();
            const offline = cached ?? FALLBACK_MODELS;
            if (cached) current = cached;
            return configsFor(offline).configs;
          }
          const live = await sharedLiveCatalog();
          if (live && live.length > 0) {
            const merged = mergeWithFallbacks(live);
            current = merged;
            const { configs, record } = configsFor(merged);
            await writeStoredCatalog(ctx.store, merged, API_ID, PROVIDER_ID);
            writeCatalogCache(merged, record);
            return configs;
          }
          const cached = await readStoredCatalog(ctx.store);
          const fallback = cached ?? FALLBACK_MODELS;
          if (cached) current = cached;
          return configsFor(fallback).configs;
        } catch (error) {
          if (config.debug) {
            console.warn(
              "[pi-qoder-bridge] refreshModels failed, using fallbacks:",
              error instanceof Error ? error.message : String(error),
            );
          }
          return configsFor(FALLBACK_MODELS).configs;
        }
      },
      streamSimple: streamQoder as never,
    });
  };

  registerCatalog(current, false);

  // Opencode parity: warm the live catalog in the background right after
  // load so /model shows account models without waiting for pi's own
  // refresh pass. Best-effort and non-blocking; failures keep fallbacks.
  // Skipped without credentials (the SDK call would just fail auth).
  // The re-registration is guarded: pi invalidates the captured API object
  // after session replacement/reload, and throwing from this detached task
  // would crash the process with an "extension ctx is stale" error.
  if (!config.disableDiscovery && hasQoderCredential()) {
    void sharedLiveCatalog()
      .then((live) => {
        if (live && live.length > 0) {
          try {
            registerCatalog(mergeWithFallbacks(live));
          } catch {
            /* session moved on; pi will refresh with a live ctx if needed */
          }
        }
      })
      .catch(() => {
        /* discovery already returns null on failure; defensive */
      });
  }

  pi.registerTool({
    name: "qoder_usage",
    label: "Qoder Usage",
    description: "Show Qoder account usage and quota (live via SDK getUsageInfo(), cached 60s).",
    parameters: Type.Object({}),
    async execute() {
      const text = await getQoderUsage();
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "qoder_models",
    label: "Qoder Models",
    description: "List known Qoder models, capabilities, limits, and price multipliers.",
    parameters: Type.Object({}),
    async execute() {
      // Picker ids are aliases; show the SDK value they map to.
      const aliasBySdk = new Map<string, string>();
      for (const [alias, sdkValue] of Object.entries(getAliasRegistry())) {
        if (!aliasBySdk.has(sdkValue)) aliasBySdk.set(sdkValue, alias);
      }
      const text = current
        .map((m) => {
          const alias = aliasBySdk.get(m.id) ?? m.id;
          const shown = alias === m.id ? alias : `${alias} [sdk: ${m.id}]`;
          return `- ${shown} (${m.name}) reasoning=${m.reasoning} input=${m.input.join("+")} cost=${m.cost.input}x ctx=${m.contextWindow}`;
        })
        .join("\n");
      return { content: [{ type: "text", text: `Qoder models:\n${text}` }], details: {} };
    },
  });

  pi.registerCommand("qoder_usage", {
    description: "Show live Qoder quota",
    handler: async (_args, ctx) => {
      try {
        const text = await getQoderUsage(true);
        ctx.ui.notify(text.slice(0, 2000), "info");
      } catch (error) {
        // Never let a status command take down the session (stale ctx etc.).
        console.warn(
          "[pi-qoder-bridge] /qoder_usage failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  pi.registerCommand("qoder_models", {
    description: "List available Qoder models",
    handler: async (_args, ctx) => {
      try {
        const aliasBySdk = new Map<string, string>();
        for (const [alias, sdkValue] of Object.entries(getAliasRegistry())) {
          if (!aliasBySdk.has(sdkValue)) aliasBySdk.set(sdkValue, alias);
        }
        ctx.ui.notify(
          current.map((m) => aliasBySdk.get(m.id) ?? m.id).join(", ").slice(0, 2000) || "no models",
          "info",
        );
      } catch (error) {
        console.warn(
          "[pi-qoder-bridge] /qoder_models failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!config.debug) return;
    try {
      ctx.ui.notify(
        `[pi-qoder-bridge] ${current.length} Qoder model(s) registered (state: ${resolveStateDir()})`,
        "info",
      );
    } catch {
      /* best-effort status notice */
    }
  });
}
