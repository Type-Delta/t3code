// oxlint-disable t3code/no-test-in-loop -- These cases intentionally exercise independent provider/process variants.
import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { creditRedeemRequestId, makeCliproxyApi } from "./cliproxyApi.ts";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make as makeUsageLimitSources } from "./UsageLimitSources.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<unknown>;
    upstream?: (request: RequestBody) => { status: number; body?: unknown; rawBody?: string };
    managementStatus?: (key: string, path: string) => number;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      const status = options.managementStatus?.(request.headers.authorization ?? "", path) ?? 200;
      if (status !== 200) return HttpClientResponse.fromWeb(request, Response.json({}, { status }));
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: options.accounts ?? accounts }),
        );
      expect(path).toBe("/v0/management/api-call");
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: upstream.status,
          body: upstream.rawBody ?? encodeJson(upstream.body),
        }),
      );
    }),
  );
  return {
    requests,
    http,
    api: makeCliproxyApi.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

describe("CLIProxyAPI built-in management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect("deduplicates account redemption without sending credit_id or clearing cooldowns", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: creditRedeemRequestId("account-b", "credit-b"),
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual([]);
    }),
  );

  it.effect.each([
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ] as const)("reports %s accurately", ([code, outcome]) =>
    Effect.gen(function* () {
      const test = fixture({ upstream: () => ({ status: 200, body: { code } }) });
      const api = yield* test.api;
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({ outcome });
      expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(false);
    }),
  );

  for (const rawBody of ["", "{}", '{"code":"new_success"}', "not JSON"]) {
    it.effect(
      `accepts a successful redemption with unfamiliar body ${JSON.stringify(rawBody)}`,
      () =>
        Effect.gen(function* () {
          const test = fixture({ upstream: () => ({ status: 200, rawBody }) });
          const api = yield* test.api;
          expect(yield* api.consume(config, "first.json", "credit")).toEqual({
            outcome: "accepted",
          });
          expect(test.requests).toHaveLength(2);
        }),
    );
  }

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        0,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );

  for (const status of [401, 403]) {
    it.effect(`pauses all management calls after HTTP ${status} until credentials change`, () =>
      Effect.gen(function* () {
        const test = fixture({
          managementStatus: (key) => (key === "Bearer corrected-key" ? 200 : status),
        });
        const api = yield* test.api;
        const failure = yield* api.readAccounts(config).pipe(Effect.result);
        expect(failure._tag).toBe("Failure");
        if (failure._tag === "Failure") expect(failure.failure.detail).toContain(`HTTP ${status}`);
        for (let i = 0; i < 6; i++) yield* api.readAccounts(config).pipe(Effect.result);
        yield* api.consume(config, "first.json", "credit").pipe(Effect.result);
        yield* api.readAccounts({ ...config, label: "New label" }).pipe(Effect.result);
        expect(test.requests).toHaveLength(1);
        yield* api
          .readAccounts({ ...config, url: "http://another-hub.test:8317" })
          .pipe(Effect.result);
        expect(test.requests).toHaveLength(2);
        const result = yield* api.readAccounts({ ...config, managementKey: "corrected-key" });
        expect(result).toHaveLength(2);
        expect(result[0]?.usageLimits.windows).toHaveLength(1);
      }),
    );
  }

  it.effect(
    "continues refreshing after transient management errors and upstream authentication errors",
    () =>
      Effect.gen(function* () {
        let status = 503;
        const test = fixture({
          managementStatus: () => status,
          upstream: () => ({ status: 401, body: {} }),
        });
        const api = yield* test.api;
        yield* api.readAccounts(config).pipe(Effect.result);
        yield* api.readAccounts(config).pipe(Effect.result);
        expect(test.requests).toHaveLength(2);
        status = 200;
        expect((yield* api.readAccounts(config))[0]?.usageLimits.unavailable?.reason).toBe(
          "probeFailed",
        );
        expect((yield* api.readAccounts(config))[0]?.usageLimits.unavailable?.reason).toBe(
          "probeFailed",
        );
        expect(test.requests).toHaveLength(8);
      }),
  );

  it.effect("stops queued account probes when management access fails during a refresh", () =>
    Effect.gen(function* () {
      const test = fixture({
        managementStatus: (_, path) => (path.endsWith("auth-files") ? 200 : 401),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.detail).toContain("paused");
      yield* Effect.forEach(
        Array.from({ length: 8 }),
        () => api.readAccounts(config).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(test.requests).toHaveLength(2);
    }),
  );

  it.effect("does not interpret blank percentages as zero usage", () =>
    Effect.gen(function* () {
      const api = yield* fixture({
        upstream: () => ({
          status: 200,
          body: {
            rate_limit: {
              primary_window: { used_percent: "  " },
              secondary_window: { used_percent: "" },
            },
          },
        }),
      }).api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows).toEqual([]);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  for (const limits of [
    null,
    "malformed",
    [null, { kind: "weekly_scoped", percent: "85", scope: { model: { display_name: "Sonnet" } } }],
  ]) {
    it.effect(`keeps Claude windows with optional limits ${JSON.stringify(limits)}`, () =>
      Effect.gen(function* () {
        const api = yield* fixture({
          accounts: [null, { ...accounts[0]!, provider: "claude", id_token: null }],
          upstream: () => ({
            status: 200,
            body: {
              five_hour: { utilization: "10", resets_at: { unexpected: true } },
              seven_day: { utilization: "invalid" },
              limits,
            },
          }),
        }).api;
        const result = yield* api.readAccounts(config);
        expect(result).toHaveLength(1);
        expect(result[0]?.usageLimits.windows[0]).toMatchObject({
          id: "five_hour",
          usedPercent: 10,
        });
        expect(result[0]?.usageLimits.windows[0]?.resetsAt).toBeUndefined();
        expect(result[0]?.usageLimits.windows).toHaveLength(Array.isArray(limits) ? 2 : 1);
      }),
    );
  }

  it.effect("keeps usable Codex fields and credits despite malformed optional data", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1788710400000);
      const api = yield* fixture({
        accounts: [
          { ...accounts[0]!, id_token: { chatgpt_account_id: "account-a", plan_type: "free" } },
        ],
        upstream: (request) => ({
          status: 200,
          body: request.url?.endsWith("rate-limit-reset-credits")
            ? { credits: [null, { id: "invalid" }, credit("usable")] }
            : {
                plan_type: { unknown: true },
                rate_limit: {
                  primary_window: {
                    used_percent: "20",
                    reset_at: "invalid",
                    reset_after_seconds: "60",
                    limit_window_seconds: -1,
                  },
                  secondary_window: { used_percent: "invalid" },
                },
              },
        }),
      }).api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.plan).toBe("ChatGPT Free Subscription");
      expect(result[0]?.usageLimits.windows).toMatchObject([
        { id: "primary", usedPercent: 20, kind: "monthly", resetsAt: "2026-09-06T16:01:00.000Z" },
      ]);
      expect(result[0]?.usageLimits.resetCredits?.availableCount).toBe(1);
    }),
  );

  it.effect(
    "reports unavailable usage rather than inventing windows from missing percentages",
    () =>
      Effect.gen(function* () {
        const api = yield* fixture({
          upstream: () => ({ status: 200, body: { plan_type: "pro", rate_limit: null } }),
        }).api;
        const result = yield* api.readAccounts(config);
        expect(result[0]?.usageLimits.windows).toEqual([]);
        expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      }),
  );

  it.effect("refreshes usage and credits after an accepted redemption", () =>
    Effect.gen(function* () {
      const sourceId = UsageLimitSourceId.make("hub");
      let consumed = false;
      const test = fixture({
        accounts: [accounts[0]!],
        upstream: (request) => {
          if (request.url?.endsWith("/consume")) {
            consumed = true;
            return { status: 200, rawBody: "" };
          }
          return {
            status: 200,
            body: request.url?.endsWith("rate-limit-reset-credits")
              ? { credits: consumed ? [] : [credit("first")] }
              : { rate_limit: { primary_window: { used_percent: consumed ? 0 : 100 } } },
          };
        },
      });
      const service = yield* makeUsageLimitSources.pipe(
        Effect.provideService(HttpClient.HttpClient, test.http),
      );
      yield* Stream.runHead(
        service.streamChanges.pipe(Stream.filter((sources) => sources[0]?.accounts.length === 1)),
      );
      expect((yield* service.current)[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(
        100,
      );
      expect(
        yield* service.consumeResetCredit({ sourceId, accountId: "first.json", creditId: "first" }),
      ).toEqual({ outcome: "accepted" });
      const limits = (yield* service.current)[0]?.accounts[0]?.usageLimits;
      expect(limits?.windows[0]?.usedPercent).toBe(0);
      expect(limits?.resetCredits?.availableCount).toBe(0);
      expect(
        test.requests.filter((request) => request.body?.url?.endsWith("/consume")),
      ).toHaveLength(1);
      expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(false);
    }).pipe(
      Effect.provideService(
        BackgroundPolicy,
        BackgroundPolicy.of({
          reportClientActivity: () => Effect.void,
          removeRpcClient: () => Effect.void,
          reportHostPowerState: () => Effect.void,
          snapshot: Effect.die("unused"),
          streamChanges: Stream.empty,
          subscribe: Effect.die("unused"),
          hasDemand: () => Effect.succeed(true),
          shouldRunScopeWork: () => Effect.succeed(true),
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
      ),
      Effect.provide(
        ServerSettingsService.layerTest({
          usageLimitSources: { [UsageLimitSourceId.make("hub")]: config },
        }),
      ),
      Effect.scoped,
    ),
  );
});
