import { query } from "@qoder-ai/qoder-agent-sdk";
import { cliLoginHint, hasQoderCredential, qoderAuth } from "./auth.js";

let cached: unknown = null;
let expiry = 0;
const TTL = 60_000;

export async function getQoderUsage(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cached && now < expiry) return formatUsage(cached);
  if (!hasQoderCredential()) {
    return `No Qoder credential found. ${cliLoginHint()}`;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  if (typeof timer.unref === "function") timer.unref();
  let q: ReturnType<typeof query> | undefined;
  try {
    q = query({
      prompt: "ping",
      options: { auth: qoderAuth(), abortController: ac, persistSession: false, maxTurns: 1 },
    });
    const info = await q.getUsageInfo();
    cached = info;
    expiry = Date.now() + TTL;
    return formatUsage(info);
  } catch (e) {
    if (cached) return formatUsage(cached) + "\n(live refresh failed, showing cached)";
    return `Qoder usage unavailable: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
    ac.abort();
    if (q) {
      try {
        await q.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function formatUsage(u: unknown): string {
  if (!u || typeof u !== "object") return "Qoder usage: no data";
  try {
    return `Qoder Account Usage\n${JSON.stringify(u, null, 2).slice(0, 4000)}`;
  } catch {
    return "Qoder usage: unformattable response";
  }
}
