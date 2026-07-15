// @effect-diagnostics nodeBuiltinImport:off - reads vendor CLI credential files at fixed paths.
// @effect-diagnostics globalFetch:off - fire-and-forget usage poll; failures degrade to "no usage".
// @effect-diagnostics globalDate:off - normalizes vendor epoch/ISO timestamps to ISO strings.
/**
 * Best-effort subscription usage fetchers for Claude and Codex.
 *
 * Reads the CLI-managed OAuth credential files and calls the same usage
 * endpoints the vendor status bars use:
 *   - Claude: GET https://api.anthropic.com/api/oauth/usage
 *     (token from `<home>/.claude/.credentials.json`, `claudeAiOauth.accessToken`)
 *   - Codex:  GET https://chatgpt.com/backend-api/wham/usage
 *     (token from `$CODEX_HOME/auth.json` or `<home>/.codex/auth.json`)
 *
 * Every failure (missing/invalid credentials, network, HTTP error) resolves
 * to `undefined` — usage is decoration, never a probe failure.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";

const FETCH_TIMEOUT_MS = 10_000;

function toIsoOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds or millis.
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : new Date(ts).toISOString();
  }
  return null;
}

function makeWindow(usedPercent: unknown, resetsAt: unknown): ServerProviderUsageWindow | null {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: toIsoOrNull(resetsAt),
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) return undefined;
    const body: unknown = await response.json();
    return body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Map a Claude `GET /api/oauth/usage` response (five_hour/seven_day windows). */
export function mapClaudeUsageResponse(body: Record<string, unknown>): ServerProviderUsage {
  const fiveHour = record(body["five_hour"]);
  const sevenDay = record(body["seven_day"]);
  return {
    session: fiveHour ? makeWindow(fiveHour["utilization"], fiveHour["resets_at"]) : null,
    weekly: sevenDay ? makeWindow(sevenDay["utilization"], sevenDay["resets_at"]) : null,
  };
}

/** Map a Codex `wham/usage` response (primary/secondary rate-limit windows). */
export function mapCodexUsageResponse(body: Record<string, unknown>): ServerProviderUsage {
  const rateLimit = record(body["rate_limit"]);
  const primary = record(rateLimit?.["primary_window"]);
  const secondary = record(rateLimit?.["secondary_window"]);
  return {
    session: primary ? makeWindow(primary["used_percent"], primary["reset_at"]) : null,
    weekly: secondary ? makeWindow(secondary["used_percent"], secondary["reset_at"]) : null,
  };
}

const hasAnyWindow = (usage: ServerProviderUsage): boolean =>
  usage.session !== null || usage.weekly !== null;

/**
 * Fetch Claude subscription usage using the OAuth credentials file under
 * `homeDir` (the instance's resolved HOME).
 */
export async function fetchClaudeSubscriptionUsage(
  homeDir: string,
): Promise<ServerProviderUsage | undefined> {
  const credentials = await readJsonFile(NodePath.join(homeDir, ".claude", ".credentials.json"));
  const oauth = record(credentials?.["claudeAiOauth"]);
  const accessToken = typeof oauth?.["accessToken"] === "string" ? oauth["accessToken"] : "";
  if (accessToken.length === 0) return undefined;
  const scopes = Array.isArray(oauth?.["scopes"]) ? oauth["scopes"] : [];
  // Inference-only tokens cannot call the usage endpoint.
  if (scopes.length > 0 && !scopes.includes("user:profile")) return undefined;

  const body = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "anthropic-beta": "oauth-2025-04-20",
  });
  if (body === undefined) return undefined;
  const usage = mapClaudeUsageResponse(body);
  return hasAnyWindow(usage) ? usage : undefined;
}

/**
 * Fetch Codex subscription usage using `auth.json` under `codexHome`
 * (the instance's resolved CODEX_HOME, defaulting to `~/.codex`).
 */
export async function fetchCodexSubscriptionUsage(
  codexHome: string = NodePath.join(NodeOS.homedir(), ".codex"),
): Promise<ServerProviderUsage | undefined> {
  const auth = await readJsonFile(NodePath.join(codexHome, "auth.json"));
  const tokens = record(auth?.["tokens"]);
  const accessToken = typeof tokens?.["access_token"] === "string" ? tokens["access_token"] : "";
  if (accessToken.length === 0) return undefined;
  const accountId = typeof tokens?.["account_id"] === "string" ? tokens["account_id"] : "";

  const body = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
    ...(accountId.length > 0 ? { "ChatGPT-Account-Id": accountId } : {}),
  });
  if (body === undefined) return undefined;
  const usage = mapCodexUsageResponse(body);
  return hasAnyWindow(usage) ? usage : undefined;
}
