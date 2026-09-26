import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { cliLoginHint, isQoderCliLoggedIn, QODER_PAT_ENV } from "./auth.js";

/**
 * `/login qoder` support.
 *
 * pi only lists a provider's models once its auth is "configured" (stored
 * OAuth credential or resolvable `apiKey`). The Qoder SDK authenticates
 * itself (PAT or `qoder`/CN-CLI login files), so this OAuth flow is a
 * passthrough: it verifies a usable credential exists and stores a marker.
 * Actual request auth always happens SDK-side in `streamQoder`.
 */
const CLI_MARKER_ACCESS = "qoder-cli-login";
const CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function patCredentials(env: NodeJS.ProcessEnv = process.env): OAuthCredentials | null {
  const token = env[QODER_PAT_ENV]?.trim();
  if (!token) return null;
  return { refresh: `pat:${token}`, access: `pat:${token}`, expires: Date.now() + CREDENTIAL_TTL_MS };
}

export async function loginQoder(
  callbacks: OAuthLoginCallbacks,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OAuthCredentials> {
  const pat = patCredentials(env);
  if (pat) return pat;
  if (isQoderCliLoggedIn()) {
    return { refresh: CLI_MARKER_ACCESS, access: CLI_MARKER_ACCESS, expires: Date.now() + CREDENTIAL_TTL_MS };
  }
  await callbacks.onPrompt({
    message: `No Qoder credential found. ${cliLoginHint(env)} Then press Enter to continue.`,
    allowEmpty: true,
  });
  if (isQoderCliLoggedIn()) {
    return { refresh: CLI_MARKER_ACCESS, access: CLI_MARKER_ACCESS, expires: Date.now() + CREDENTIAL_TTL_MS };
  }
  const retry = patCredentials(env);
  if (retry) return retry;
  throw new Error(`Qoder login not detected. ${cliLoginHint(env)}`);
}

export async function refreshQoderToken(
  credentials: OAuthCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OAuthCredentials> {
  const pat = patCredentials(env);
  if (pat) return pat;
  if (credentials.access === CLI_MARKER_ACCESS && isQoderCliLoggedIn()) {
    return { ...credentials, expires: Date.now() + CREDENTIAL_TTL_MS };
  }
  throw new Error(`Qoder credential expired. ${cliLoginHint(env)}`);
}

/** pi needs a key string for its auth gate; turns authenticate SDK-side. */
export function getQoderApiKey(
  credentials: OAuthCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = env[QODER_PAT_ENV]?.trim();
  if (token) return token;
  return credentials.access;
}
