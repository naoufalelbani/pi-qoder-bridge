import { query } from "@qoder-ai/qoder-agent-sdk";
import type { Options } from "@qoder-ai/qoder-agent-sdk";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { qoderAuth } from "./auth.js";
import { buildAliasMap, resolveSdkModel } from "./aliases.js";
import { loadConfig } from "./config.js";
import { fromModelInfos, mergeWithFallbacks } from "./models.js";
import { writeCatalogCache } from "./catalog-cache.js";

/**
 * Test seam: streamQoder calls `__testHooks.queryFn` instead of the SDK
 * directly, so token-streaming/dedupe behavior can be verified with canned
 * SDK frames (live turns need quota). Production always uses the real query.
 */
export const __testHooks: { queryFn: typeof query } = { queryFn: query };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Translate SDK transport failures into actionable messages. A stalled
 * runtime surfaces as `Control request "<op>" timed out after Nms` with no
 * other context; users need to know it is the Qoder backend/CLI hanging,
 * not pi, and what to try next.
 */
function friendlyTurnError(error: unknown, modelId: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/control request .* timed out/i.test(raw)) {
    return (
      `${raw} — the Qoder runtime did not respond for model '${modelId}'. ` +
      `Check your network and 'qoder login' session, then retry or try another model ` +
      `(e.g. qoder/auto). Slow connections can raise PI_QODER_CONTROL_TIMEOUT_MS ` +
      `(default 60000ms).`
    );
  }
  // (Bare "token" is deliberately excluded: usage errors mention token
  // limits without any credential problem.)
  if (/auth|credential|unauthori|forbidden|invalid token|api key|\blogin\b|expired/i.test(raw)) {
    return (
      `${raw} — Qoder rejected the credentials for model '${modelId}'. ` +
      `Run /login qoder inside pi or set QODER_PERSONAL_ACCESS_TOKEN, then retry.`
    );
  }
  return raw;
}

function messageText(msg: { role: string; content: unknown }): string {
  const c = (msg as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const out: string[] = [];
  for (const part of c) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") out.push(part.text);
    else if (part.type === "thinking" && typeof part.thinking === "string")
      out.push(`[thinking] ${part.thinking}`);
    else if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "tool";
      out.push(`[toolCall ${name} ${truncateJson(part.arguments)}]`);
    } else if (part.type === "toolResult") {
      const name =
        typeof (part as { name?: unknown }).name === "string"
          ? (part as { name?: string }).name
          : typeof (part as { toolName?: unknown }).toolName === "string"
            ? (part as { toolName?: string }).toolName
            : "tool";
      out.push(`[toolResult ${name} ${truncateJson((part as { output?: unknown }).output)}]`);
    } else if (part.type === "image") out.push(`[Image attached]`);
  }
  return out.join("\n");
}

function truncateJson(value: unknown, max = 500): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (!s) return "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return "";
  }
}

/**
 * Render an SDK-native tool call as transcript text.
 *
 * The Qoder runtime executes its own tools (Bash/Read/Edit/…) inside its
 * process; assistant tool_use blocks are records of that, NOT requests for
 * the host to execute (opencode makes the same distinction via
 * provider-executed tracking). Forwarding them as pi toolCalls would run
 * every side effect twice — or fail on name/schema mismatches — so they
 * become readable history text and the turn closes as "stop".
 */
export function nativeToolSummary(name: unknown, args: unknown): string {
  const tool = typeof name === "string" && name ? name : "qoder_tool";
  const detail = truncateJson(args, 300);
  return `[Qoder tool call: ${tool}${detail ? ` ${detail}` : ""}]`;
}

/** Serialize a pi Context into a single prompt string for the Qoder agent SDK. */
export function contextToPrompt(context: Context): string {
  // Note: the system prompt travels via the SDK systemPrompt option (proper
  // channel), not here — this function carries tools + conversation only.
  // Defensive shapes: pi guarantees these, but a malformed context must
  // degrade to a short prompt, never throw the turn away.
  const tools = Array.isArray(context.tools) ? context.tools : [];
  const messages = Array.isArray(context.messages) ? context.messages : [];

  const lines: string[] = [];
  if (tools.length > 0) {
    const names = tools
      .filter(isRecord)
      .map((t) => {
        const name = typeof t.name === "string" ? t.name : "tool";
        const desc = typeof t.description === "string" ? t.description : "";
        return `- ${name}: ${desc}`.slice(0, 500);
      });
    if (names.length > 0) lines.push(`<available_tools>\n${names.join("\n")}\n</available_tools>`);
  }
  lines.push("<conversation>");
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const role = (m as { role?: string }).role ?? "user";
    if (role === "system") continue;
    const text = messageText(m as { role: string; content: unknown }).slice(0, 200_000);
    if (!text.trim()) continue;
    lines.push(`${role.toUpperCase()}:\n${text}`);
  }
  lines.push("</conversation>");
  return lines.join("\n\n");
}

export function streamQoder(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    let q: ReturnType<typeof query> | undefined;
    let modelId = model.id;
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortForwarder: (() => void) | undefined;
    // Dedupe guards: with partials enabled the runtime yields both
    // token-level stream_event frames AND the assembled assistant message.
    // Streamed content wins; complete blocks already covered are skipped
    // (opencode mirrors this with sawStreamText/sawStreamReasoning).
    let sawStreamedText = false;
    let sawStreamedThinking = false;
    const streamedToolIds = new Set<string>();
    // Terminal stop reason reported by the runtime (message stop_reason /
    // message_delta). max_tokens maps to pi "length"; everything else closes
    // as "stop" (native tool_use is runtime-executed, never host execution).
    let lastStopReason: string | null = null;
    // Track open blocks by SDK index so delta events map to pi content indices.
    const blockIndex = new Map<number | string, number>();
    // Native tool_use blocks buffer here; a text summary is emitted at stop
    // (never forwarded as pi toolCalls — see nativeToolSummary).
    const pendingNativeTools = new Map<number | string, { name: string; buf: string }>();

    const emitTextBlock = (text: string): void => {
      if (!text) return;
      const idx = output.content.length;
      (output.content as { type: string; text: string }[]).push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex: idx, partial: output });
      (output.content[idx] as { text: string }).text = text;
      stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
    };

    try {
      stream.push({ type: "start", partial: output });

      const rawId = model.id.includes("/") ? model.id.split("/").pop()! : model.id;
      // Picker ids may be friendly aliases; the SDK needs the raw value.
      modelId = resolveSdkModel(rawId);
      const turnConfig = loadConfig();
      const sdkOptions: Options = {
        auth: qoderAuth(),
        model: modelId,
        persistSession: false,
        env: process.env as Record<string, string | undefined>,
        // System prompt on its proper channel (not inlined as user text).
        ...(context.systemPrompt?.trim()
          ? { systemPrompt: context.systemPrompt.trim() }
          : {}),
        // Stream token-level partials (SDK `stream_event` frames). Without
        // this the runtime only yields complete assistant messages and pi
        // displays each response all-at-once after generation finishes.
        // Opencode sets the same flag; kill-switch below for safety.
        includePartialMessages: !turnConfig.disablePartials,
        // Bound every control round-trip (opencode parity). Without this the
        // SDK default lets a stalled runtime (e.g. "initialize") hang the
        // turn for minutes before surfacing an error.
        controlRequestTimeoutMs: turnConfig.controlTimeoutMs,
        closeGraceMs: turnConfig.closeGraceMs,
        ...(turnConfig.goalMaxTurns !== undefined ? { goalMaxTurns: turnConfig.goalMaxTurns } : {}),
        // Runtime observability: capture qodercli stderr into the debug log;
        // forward --debug only on explicit opt-in (verbose).
        ...(turnConfig.debug
          ? {
              stderr: (data: string) => {
                try {
                  const text = String(data ?? "").slice(0, 500);
                  if (text.trim()) console.warn(`[pi-qoder-bridge:qodercli] ${text}`);
                } catch {
                  /* logging must never break turns */
                }
              },
            }
          : {}),
        ...(turnConfig.sdkDebug ? { debug: true } : {}),
      };
      if (options?.signal) {
        const ac = new AbortController();
        const forwardAbort = (): void => ac.abort();
        if (options.signal.aborted) ac.abort();
        else {
          options.signal.addEventListener("abort", forwardAbort, { once: true });
          removeAbortForwarder = () => options.signal?.removeEventListener("abort", forwardAbort);
        }
        (sdkOptions as { abortController?: AbortController }).abortController = ac;
      }

      q = __testHooks.queryFn({ prompt: contextToPrompt(context), options: sdkOptions });

      // Init watchdog: the SDK's own initialize timeout is hardcoded and a
      // wedged runtime can starve the iterator entirely (no events at all).
      // Abort when nothing arrives within the budget so the turn fails fast
      // with guidance instead of hanging a dead spinner.
      let sawFirstMessage = false;
      let initTimedOut = false;
      initTimer = setTimeout(() => {
        if (!sawFirstMessage) {
          initTimedOut = true;
          void q?.close().catch(() => {});
        }
      }, turnConfig.initTimeoutMs);
      if (typeof initTimer.unref === "function") initTimer.unref();

      for await (const msg of q) {
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        if (initTimedOut) {
          throw new Error(
            `Qoder runtime did not start within ${turnConfig.initTimeoutMs}ms (model '${modelId}'). ` +
              `The backend or qodercli process is stalled, not pi.`,
          );
        }
        if (!isRecord(msg)) continue;
        sawFirstMessage = true;
        const type = (msg as { type?: string }).type;

        if (type === "system") {
          const subtype = (msg as { subtype?: unknown }).subtype;
          if (subtype === "permission_denied") {
            // A runtime tool call was denied (rule/mode/safety). Without this
            // the turn silently does less than asked with no explanation.
            const denied = msg as unknown as {
              tool_name?: unknown;
              message?: unknown;
              decision_reason?: unknown;
            };
            const tool = typeof denied.tool_name === "string" ? denied.tool_name : "tool";
            const reason =
              typeof denied.message === "string" && denied.message.trim()
                ? denied.message.trim()
                : typeof denied.decision_reason === "string"
                  ? denied.decision_reason
                  : "denied by runtime policy";
            emitTextBlock(`[Qoder permission denied: ${tool} — ${reason.slice(0, 300)}]`);
          } else if (subtype === "available_models_update") {
            // Opencode applies these live; we persist them so the next start
            // (and offline refresh) sees the fresh catalog immediately.
            const live = (msg as unknown as { models?: unknown }).models;
            if (Array.isArray(live) && live.length > 0) {
              try {
                const mapped = fromModelInfos(
                  live as import("@qoder-ai/qoder-agent-sdk").ModelInfo[],
                );
                if (mapped.length > 0) {
                  const merged = mergeWithFallbacks(mapped);
                  writeCatalogCache(merged, Object.fromEntries(buildAliasMap(merged)));
                }
              } catch {
                /* best-effort */
              }
            }
          }
          // Other system frames (init/artifacts/commands_changed/…) carry no
          // turn content.
          continue;
        }

        if (type === "assistant") {
          const inner = (msg as { message?: unknown }).message;
          if (!isRecord(inner) || !Array.isArray((inner as { content?: unknown }).content)) continue;
          const innerStop = (inner as { stop_reason?: unknown }).stop_reason;
          if (typeof innerStop === "string" && innerStop) lastStopReason = innerStop;
          const blocks = (inner as { content: unknown[] }).content;
          for (const b of blocks) {
            if (!isRecord(b)) continue;
            const btype = (b as { type?: string }).type;
            if (btype === "text" && typeof (b as { text?: unknown }).text === "string") {
              const text = (b as { text: string }).text;
              if (!text) continue;
              // Already streamed token-by-token via stream_event frames.
              if (sawStreamedText) continue;
              const idx = output.content.length;
              (output.content as { type: string; text: string }[]).push({ type: "text", text: "" });
              stream.push({ type: "text_start", contentIndex: idx, partial: output });
              (output.content[idx] as { text: string }).text = text;
              stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
              stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
            } else if (
              (btype === "thinking" || btype === "reasoning") &&
              typeof (b as { thinking?: unknown; text?: unknown }).thinking === "string"
            ) {
              const thinking =
                ((b as { thinking?: string }).thinking ?? (b as { text?: string }).text ?? "") as string;
              if (!thinking) continue;
              // Already streamed token-by-token via stream_event frames.
              if (sawStreamedThinking) continue;
              const idx = output.content.length;
              (output.content as unknown[]).push({ type: "thinking", thinking: "" });
              stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
              ((output.content[idx] as unknown) as { thinking: string }).thinking = thinking;
              stream.push({ type: "thinking_delta", contentIndex: idx, delta: thinking, partial: output });
              stream.push({ type: "thinking_end", contentIndex: idx, content: thinking, partial: output });
            } else if (btype === "tool_use" || btype === "toolCall") {
              // Skip when the same call already streamed via partial frames.
              const completeId = (b as { id?: unknown }).id;
              if (typeof completeId === "string" && streamedToolIds.has(completeId)) continue;
              // Native SDK tool call: already handled inside the Qoder
              // runtime — record as text, never forward as a pi toolCall
              // (that would execute side effects a second time).
              const summary = nativeToolSummary(
                (b as { name?: unknown }).name,
                (b as { input?: unknown }).input ?? (b as { arguments?: unknown }).arguments,
              );
              emitTextBlock(summary);
            }
          }
          continue;
        }

        // Token-level partials arrive wrapped as { type: "stream_event",
        // event: <Anthropic raw stream event> } when includePartialMessages
        // is on. Unwrap so the handlers below see the raw frame.
        // message_start/delta/stop carry no content (usage comes via result).
        if (type === "stream_event") {
          const wrapped = (msg as unknown as { event?: unknown }).event;
          if (!isRecord(wrapped)) continue;
          const innerType = (wrapped as { type?: unknown }).type;
          if (innerType === "message_delta") {
            // Terminal reason can arrive here before the result frame.
            const deltaReason = (wrapped as { delta?: unknown }).delta;
            if (isRecord(deltaReason) && typeof deltaReason.stop_reason === "string") {
              lastStopReason = deltaReason.stop_reason;
            }
            continue;
          }
          if (innerType === "message_start" || innerType === "message_stop") {
            continue;
          }
        }
        const frame = (
          type === "stream_event" && isRecord((msg as unknown as { event?: unknown }).event)
            ? ((msg as unknown as { event?: unknown }).event as Record<string, unknown>)
            : msg
        ) as Record<string, unknown>;
        // Lower-level SDK stream parts (content_block_*), same shape
        // opencode-qoder-bridge/src/language-model.ts translates.
        const evType = (frame as { event?: string }).event ?? (frame as { type?: string }).type;
        if (evType === "content_block_start" && isRecord((frame as unknown as { content_block?: unknown }).content_block)) {
          const cb = (frame as unknown as { content_block: Record<string, unknown> }).content_block;
          const key = (cb.id as string | number | undefined) ?? (cb.index as number | undefined) ?? output.content.length;
          const cbType = cb.type as string | undefined;
          if (cbType === "text") {
            const idx = output.content.length;
            blockIndex.set(key, idx);
            (output.content as { type: string; text: string }[]).push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: idx, partial: output });
          } else if (cbType === "thinking" || cbType === "reasoning") {
            const idx = output.content.length;
            blockIndex.set(key, idx);
            (output.content as unknown[]).push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
          } else if (cbType === "tool_use") {
            const name = typeof cb.name === "string" && cb.name ? cb.name : "qoder_tool";
            // Key by event index first: stop/delta frames reference the
            // block by index, while content_block often carries only the
            // tool id. Keying by id here orphaned the stop lookup.
            const toolKey =
              ((frame as unknown as { index?: number | string }).index ??
                cb.id ??
                output.content.length) as number | string;
            pendingNativeTools.set(toolKey, { name, buf: "" });
            if (typeof cb.id === "string" && cb.id) streamedToolIds.add(cb.id);
            // Immediate visibility: tool input streams fast but execution
            // can take a while with zero SDK events. The summary (with args)
            // follows at block stop.
            emitTextBlock(`[Qoder running: ${name}…]`);
          }
          continue;
        }
        if (evType === "content_block_delta" && isRecord((frame as unknown as { delta?: unknown }).delta)) {
          const delta = (frame as unknown as { delta: Record<string, unknown> }).delta;
          const key =
            ((frame as unknown as { index?: number | string }).index ??
              (frame as unknown as { id?: number | string }).id ??
              "") as number | string;
          const idx = blockIndex.get(key);
          const pendingTool = pendingNativeTools.get(key);
          if (idx === undefined && pendingTool === undefined) continue;
          if (pendingTool) {
            // Native tool input streams here; summarized as text at stop.
            if (typeof delta.partial_json === "string") pendingTool.buf += delta.partial_json;
            continue;
          }
          const block = output.content[idx as number] as unknown as Record<string, unknown>;
          if (typeof delta.text === "string" && block?.type === "text") {
            sawStreamedText = true;
            block.text = String(block.text ?? "") + delta.text;
            stream.push({ type: "text_delta", contentIndex: idx as number, delta: delta.text, partial: output });
          } else if (typeof delta.thinking === "string" && block?.type === "thinking") {
            sawStreamedThinking = true;
            block.thinking = String(block.thinking ?? "") + delta.thinking;
            stream.push({ type: "thinking_delta", contentIndex: idx as number, delta: delta.thinking, partial: output });
          }
          continue;
        }
        if (evType === "content_block_stop") {
          const key = ((frame as unknown as { index?: number | string }).index ?? "") as number | string;
          const pendingTool = pendingNativeTools.get(key);
          if (pendingTool) {
            pendingNativeTools.delete(key);
            let args: unknown = pendingTool.buf;
            try {
              args = pendingTool.buf ? JSON.parse(pendingTool.buf) : "";
            } catch {
              /* keep raw */
            }
            emitTextBlock(nativeToolSummary(pendingTool.name, args));
            continue;
          }
          const idx = blockIndex.get(key);
          if (idx === undefined) continue;
          const block = output.content[idx] as unknown as Record<string, unknown>;
          if (block?.type === "text") {
            stream.push({ type: "text_end", contentIndex: idx, content: block.text as string, partial: output });
          } else if (block?.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: idx,
              content: block.thinking as string,
              partial: output,
            });
          }
          continue;
        }

        if (type === "result") {
          // Flush any native tool summaries missing their stop events.
          for (const pending of pendingNativeTools.values()) {
            let pendingArgs: unknown = pending.buf;
            try {
              pendingArgs = pending.buf ? JSON.parse(pending.buf) : "";
            } catch {
              /* keep raw */
            }
            emitTextBlock(nativeToolSummary(pending.name, pendingArgs));
          }
          pendingNativeTools.clear();
          const r = msg as {
            subtype?: string;
            is_error?: boolean;
            result?: unknown;
            usage?: Record<string, unknown>;
          };
          const usage = r.usage ?? {};
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
          output.usage.input = num(usage.input_tokens);
          output.usage.output = num(usage.output_tokens);
          output.usage.cacheRead = num(usage.cache_read_input_tokens);
          output.usage.cacheWrite = num(usage.cache_creation_input_tokens);
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          try {
            calculateCost(model as never, output.usage as never);
          } catch {
            /* cost is best-effort */
          }
          // Fallback text when the SDK only returns result string.
          if (output.content.length === 0 && typeof r.result === "string" && r.result) {
            const idx = 0;
            (output.content as { type: string; text: string }[]).push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: idx, partial: output });
            (output.content[idx] as { text: string }).text = r.result;
            stream.push({ type: "text_delta", contentIndex: idx, delta: r.result, partial: output });
            stream.push({ type: "text_end", contentIndex: idx, content: r.result, partial: output });
          }
          // Native tool calls already ran inside the Qoder runtime (see
          // nativeToolSummary); the SDK result is terminal, never a
          // host-execution request.
          if (r.is_error === true || (r.subtype && r.subtype !== "success")) {
            const detail =
              typeof r.result === "string" && r.result.trim()
                ? r.result.trim()
                : (r.subtype ?? "error_during_execution");
            throw new Error(`Qoder ${r.subtype ?? "error"}: ${String(detail).slice(0, 500)}`);
          }
          if (lastStopReason === "max_tokens") {
            output.stopReason = "length";
            output.rawStopReason = lastStopReason;
          } else {
            output.stopReason = "stop";
            if (lastStopReason) output.rawStopReason = lastStopReason;
          }
          continue;
        }
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (initTimedOut) {
        throw new Error(
          `Qoder runtime did not start within ${turnConfig.initTimeoutMs}ms (model '${modelId}'). ` +
            `The backend or qodercli process is stalled, not pi. Check network, re-run 'qoder login', ` +
            `or try another model (e.g. qoder/auto).`,
        );
      }
      if (output.stopReason === "pending") {
        // No explicit result frame but we streamed content.
        // (Flush any natively-executed tool summaries missing stop events.)
        for (const pending of pendingNativeTools.values()) {
          let args: unknown = pending.buf;
          try {
            args = pending.buf ? JSON.parse(pending.buf) : "";
          } catch {
            /* keep raw */
          }
          emitTextBlock(nativeToolSummary(pending.name, args));
        }
        pendingNativeTools.clear();
        if (lastStopReason === "max_tokens") {
          output.stopReason = "length";
          output.rawStopReason = lastStopReason;
        } else {
          output.stopReason = "stop";
          if (lastStopReason) output.rawStopReason = lastStopReason;
        }
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      try {
        output.errorMessage = friendlyTurnError(error, modelId);
      } catch {
        output.errorMessage = "Qoder request failed";
      }
      // The stream machinery itself may be the broken part; never let
      // reporting the failure escape as an unhandled rejection.
      try {
        stream.push({
          type: "error",
          reason: output.stopReason as "error" | "aborted",
          error: output,
        });
      } catch {
        /* nothing to report through */
      }
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    } finally {
      if (initTimer) clearTimeout(initTimer);
      removeAbortForwarder?.();
      if (q) {
        try {
          await q.close();
        } catch {
          /* best-effort */
        }
      }
    }
  })();

  return stream;
}
