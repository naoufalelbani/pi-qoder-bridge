import { accessToken, accessTokenFromEnv, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import type { AuthOptions } from "@qoder-ai/qoder-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";
export const QODER_REGION_ENV = "QODER_REGION";

export function hasQoderPAT(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[QODER_PAT_ENV]?.trim());
}

function authFiles(): string[] {
  const home = homedir();
  return [
    join(home, ".qoderwork", ".auth", "user"),
    join(home, ".qoder", ".auth", "user"),
    // Qoder CN region uses a separate home (qoderclicn).
    join(home, ".qoder-cn", ".auth", "user"),
  ];
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isQoderCliLoggedIn(): boolean {
  try {
    return authFiles().some((p) => {
      try {
        return existsSync(p) && isRegularFile(p);
      } catch {
        return false;
      }
    });
  } catch {
    /* ignore */
    return false;
  }
}

export function hasQoderCredential(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasQoderPAT(env) || isQoderCliLoggedIn();
}

/** Prefer PAT when present, else fall back to qodercli login (global + CN). */
export function qoderAuth(env: NodeJS.ProcessEnv = process.env): AuthOptions {
  const token = env[QODER_PAT_ENV];
  if (!token?.trim()) return qodercliAuth();
  return token === token.trim() ? accessTokenFromEnv(QODER_PAT_ENV) : accessToken(token.trim());
}

export function cliLoginHint(env: NodeJS.ProcessEnv = process.env): string {
  const region = env[QODER_REGION_ENV]?.trim().toLowerCase();
  if (region === "cn") return "Run the CN CLI login or set QODER_PERSONAL_ACCESS_TOKEN.";
  return "Run `qoder login` (CN region: the CN CLI login) or set QODER_PERSONAL_ACCESS_TOKEN.";
}
