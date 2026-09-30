import * as NodeCrypto from "node:crypto";

import {
  ForwardCompatibleArray,
  ProviderDriverKind,
  TrimmedNonEmptyString,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { codexPlanLabel } from "../provider/Layers/CodexProvider.ts";
import { codexRateLimitsToLimits } from "../provider/Layers/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import { makeUnavailableUsageLimits } from "../provider/providerUsageLimits.ts";

// Optional upstream fields must not discard otherwise usable account/window data.
const forgivingOptional = <S extends Schema.Constraint>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.catchDecoding<Schema.NullOr<S>>(() => Effect.succeed(Option.some(null))),
    Schema.optional,
  );
const UsageNumber = Schema.Union([
  Schema.Finite,
  TrimmedNonEmptyString.pipe(Schema.decodeTo(Schema.FiniteFromString)),
]);
const NonNegativeUsageNumber = UsageNumber.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveUsageNumber = UsageNumber.check(Schema.isGreaterThan(0));
const AuthFile = Schema.Struct({
  id: TrimmedNonEmptyString,
  auth_index: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  email: forgivingOptional(TrimmedNonEmptyString),
  disabled: Schema.optional(Schema.Boolean),
  id_token: forgivingOptional(
    Schema.Struct({
      chatgpt_account_id: forgivingOptional(TrimmedNonEmptyString),
      plan_type: forgivingOptional(TrimmedNonEmptyString),
      chatgpt_plan_type: forgivingOptional(TrimmedNonEmptyString),
    }),
  ),
});
const AuthFiles = Schema.Struct({ files: ForwardCompatibleArray(AuthFile) });
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });
const CodexWindow = Schema.Struct({
  used_percent: UsageNumber,
  reset_at: forgivingOptional(PositiveUsageNumber),
  reset_after_seconds: forgivingOptional(NonNegativeUsageNumber),
  limit_window_seconds: forgivingOptional(PositiveUsageNumber),
});
const CodexUsage = Schema.Struct({
  plan_type: forgivingOptional(TrimmedNonEmptyString),
  rate_limit: forgivingOptional(
    Schema.Struct({
      primary_window: forgivingOptional(CodexWindow),
      secondary_window: forgivingOptional(CodexWindow),
    }),
  ),
});
const ClaudeWindow = Schema.Struct({
  utilization: UsageNumber,
  resets_at: forgivingOptional(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  five_hour: forgivingOptional(ClaudeWindow),
  seven_day: forgivingOptional(ClaudeWindow),
  limits: forgivingOptional(
    ForwardCompatibleArray(
      Schema.Struct({
        kind: Schema.String,
        percent: forgivingOptional(UsageNumber),
        resets_at: forgivingOptional(Schema.String),
        scope: forgivingOptional(
          Schema.Struct({
            model: forgivingOptional(Schema.Struct({ display_name: TrimmedNonEmptyString })),
          }),
        ),
      }),
    ),
  ),
});
const CreditList = Schema.Struct({
  credits: ForwardCompatibleArray(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditList));
const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeUsage));
const decodeCodexUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexUsage));
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
export function creditRedeemRequestId(accountId: string, creditId: string): string {
  const bytes = NodeCrypto.createHash("sha1")
    .update(Buffer.from("6f1c2a9e2d4b4c1e9a7f3b8d5e0c1a42", "hex"))
    .update(`${accountId}:${creditId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const managementLocks = new Map<string, Semaphore.Semaphore>();
  const denied = new Map<string, { key: string; error: UsageLimitSourceError }>();

  const management = Effect.fn("CliproxyApi.management")(
    function* (config: UsageLimitSourceConfig, path: string, body?: unknown) {
      const previous = denied.get(config.url);
      if (previous?.key === config.managementKey) return yield* previous.error;
      denied.delete(config.url);
      const url = yield* Effect.try({
        try: () => new URL(`/v0/management/${path}`, config.url).toString(),
        catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
      });
      const request = (
        body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
      ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${config.managementKey}`));
      const response = yield* client
        .execute(
          body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        )
        .pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (response) {
              if (response.status === 401 || response.status === 403) {
                const error = new UsageLimitSourceError({
                  detail: `The hub denied management access (HTTP ${response.status}). Requests are paused until the hub URL or management key changes.`,
                });
                denied.set(config.url, { key: config.managementKey, error });
                return yield* error;
              }
              if (response.status < 200 || response.status >= 300) {
                return yield* new UsageLimitSourceError({
                  detail: `The hub management request failed (HTTP ${response.status}).`,
                });
              }
              return yield* response.json;
            }),
          ),
          Effect.timeout("15 seconds"),
          Effect.mapError((error) =>
            isUsageLimitSourceError(error)
              ? error
              : new UsageLimitSourceError({ detail: "The hub management request failed." }),
          ),
        );
      return response;
    },
    (effect, config) => {
      // One request per hub prevents queued account probes from accumulating auth failures.
      const lock = managementLocks.get(config.url) ?? Semaphore.makeUnsafe(1);
      managementLocks.set(config.url, lock);
      return lock.withPermits(1)(effect);
    },
  );

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (config: UsageLimitSourceConfig) {
    const response = yield* management(config, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
    url: string,
    data?: unknown,
  ) {
    const header =
      account.provider === "codex"
        ? {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
            ...(account.id_token?.chatgpt_account_id
              ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id }
              : {}),
          }
        : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" };
    const raw = yield* management(config, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new UsageLimitSourceError({
        detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
      });
    }
    return response.body;
  });

  const credits = Effect.fn("CliproxyApi.credits")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const body = yield* apiCall(config, account, CREDIT_URL);
    const response = yield* decodeCreditList(body);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return response.credits
      .filter(
        (credit) =>
          credit.reset_type === "codex_rate_limits" &&
          credit.status === "available" &&
          Date.parse(credit.expires_at) > now,
      )
      .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: account.id,
      driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),
      ...(account.email ? { email: account.email } : {}),
    };
    const read = Effect.gen(function* () {
      if (account.provider === "claude") {
        const body = yield* apiCall(config, account, "https://api.anthropic.com/api/oauth/usage");
        const usage = yield* decodeClaudeUsage(body);
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        return {
          ...base,
          plan: "Claude Subscription",
          usageLimits: claudeUsageResponseToLimits({
            checkedAt,
            response: {
              rate_limits_available: true,
              rate_limits: {
                five_hour: usage.five_hour
                  ? { ...usage.five_hour, resets_at: usage.five_hour.resets_at ?? null }
                  : null,
                seven_day: usage.seven_day
                  ? { ...usage.seven_day, resets_at: usage.seven_day.resets_at ?? null }
                  : null,
                model_scoped,
              } as unknown as NonNullable<
                Parameters<typeof claudeUsageResponseToLimits>[0]["response"]["rate_limits"]
              >,
            },
          }).limits,
        };
      }
      const body = yield* apiCall(config, account, `${CODEX_BASE}/usage`);
      const usage = yield* decodeCodexUsage(body);
      const planType =
        usage.plan_type ?? account.id_token?.plan_type ?? account.id_token?.chatgpt_plan_type;
      const nowSeconds = DateTime.toEpochMillis(yield* DateTime.now) / 1000;
      const toWindow = (window: typeof CodexWindow.Type | null | undefined) =>
        window
          ? {
              usedPercent: window.used_percent,
              resetsAt:
                window.reset_at ??
                (window.reset_after_seconds == null
                  ? null
                  : nowSeconds + window.reset_after_seconds),
              ...(window.limit_window_seconds == null
                ? {}
                : { windowDurationMins: Math.ceil(window.limit_window_seconds / 60) }),
            }
          : null;
      // A credits outage must not hide successfully fetched quota windows.
      const available = yield* credits(config, account).pipe(Effect.orElseSucceed(() => undefined));
      const next = available?.[0];
      return {
        ...base,
        plan: codexPlanLabel(planType),
        usageLimits: {
          ...codexRateLimitsToLimits({
            checkedAt,
            snapshot: {
              planType: planType ?? null,
              primary: toWindow(usage.rate_limit?.primary_window),
              secondary: toWindow(usage.rate_limit?.secondary_window),
            },
          }),
          ...(available
            ? {
                resetCredits: {
                  availableCount: available.length,
                  ...(next
                    ? {
                        nextCreditId: next.id,
                        nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
    });
    return yield* read.pipe(
      Effect.map((result) =>
        result.usageLimits.windows.length > 0
          ? result
          : {
              ...result,
              usageLimits: {
                ...result.usageLimits,
                unavailable: {
                  reason: "probeFailed" as const,
                  message: "The hub returned no readable usage windows.",
                },
              },
            },
      ),
      Effect.orElseSucceed(() => ({
        ...base,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "The hub could not read this account's usage.",
        }),
      })),
    );
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    config: UsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(config).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    const result = yield* Effect.forEach(
      accounts.filter(
        (account) =>
          !account.disabled && (account.provider === "codex" || account.provider === "claude"),
      ),
      (account) => readAccount(config, account),
      { concurrency: 4 },
    );
    const failure = denied.get(config.url);
    if (failure?.key === config.managementKey) return yield* failure.error;
    return result;
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(config)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(config, account, `${CREDIT_URL}/consume`, {
        redeem_request_id: creditRedeemRequestId(
          account.id_token?.chatgpt_account_id ?? account.id,
          creditId,
        ),
      });
      const response = yield* decodeConsumeResponse(body).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!response) return { outcome: "accepted" } as const;
      const outcome = (
        {
          reset: "reset",
          nothing_to_reset: "nothingToReset",
          no_credit: "noCredit",
          already_redeemed: "alreadyRedeemed",
        } as const
      )[response.code];
      return { outcome };
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: "The hub returned an unexpected reset-credit response.",
            }),
      ),
    );
  });
  return { readAccounts, consume };
});
