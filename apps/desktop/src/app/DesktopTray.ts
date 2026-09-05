import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
} from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as Electron from "electron";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const REFRESH_INTERVAL = Duration.seconds(5);
const REQUEST_TIMEOUT_MS = 3_000;
const { logWarning } = makeComponentLogger("desktop-tray");

export const formatRunningThreadCount = (count: number): string =>
  `${count} ${count === 1 ? "thread" : "threads"} running`;

export const formatRunningThreadCountStatus = (
  count: number,
  freshness: "live" | "stale" | "unavailable",
): string =>
  freshness === "unavailable"
    ? "Running thread count unavailable"
    : freshness === "stale"
      ? `${formatRunningThreadCount(count)} (last known)`
      : formatRunningThreadCount(count);

export const activateFromTray = <E, R>(
  quitting: Ref.Ref<boolean>,
  activate: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  Ref.get(quitting).pipe(Effect.flatMap((isQuitting) => (isQuitting ? Effect.void : activate)));

export type RunningThreadCountResult =
  | { readonly status: "fresh" | "stale"; readonly count: number }
  | { readonly status: "stopped" | "unavailable" };

export const summarizeRunningThreadCounts = (
  results: ReadonlyArray<RunningThreadCountResult>,
): { readonly count: number; readonly freshness: "live" | "stale" | "unavailable" } => ({
  count: results.reduce(
    (sum, result) =>
      result.status === "fresh" || result.status === "stale" ? sum + result.count : sum,
    0,
  ),
  freshness: results.some((result) => result.status === "unavailable")
    ? "unavailable"
    : results.some((result) => result.status === "stale")
      ? "stale"
      : "live",
});

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

export const layer = Layer.effect(
  DesktopTray,
  Effect.gen(function* () {
    const assets = yield* DesktopAssets.DesktopAssets;
    const backendPool = yield* DesktopBackendPool.DesktopBackendPool;
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const desktopState = yield* DesktopState.DesktopState;
    const httpClient = yield* HttpClient.HttpClient;
    const context = yield* Effect.context<DesktopWindow.DesktopWindow | ElectronApp.ElectronApp>();
    const runEffect = Effect.runPromiseWith(context);
    const lastCounts = new Map<string, number>();
    const failedBackendIds = new Set<string>();

    const loadCount = Effect.fn("desktop.tray.loadCount")(function* (
      instance: DesktopBackendPool.DesktopBackendInstance,
    ) {
      const config = yield* instance.currentConfig;
      if (Option.isNone(config)) return Option.none<number>();

      const token = yield* localAuth.getBearerToken(instance.id);
      const client = yield* makeEnvironmentHttpApiClient(config.value.httpBaseUrl.href);
      const count = yield* executeEnvironmentHttpRequest(
        new URL("/api/orchestration/running-thread-count", config.value.httpBaseUrl).href,
        REQUEST_TIMEOUT_MS,
        client.orchestration.runningThreadCount({
          headers: { authorization: `Bearer ${token}` },
        }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      return Option.some(count);
    });

    const configure = Effect.gen(function* () {
      const iconPaths = yield* assets.iconPaths;
      const macTemplatePath =
        environment.platform === "darwin"
          ? yield* assets
              .resolveResourcePath("trayTemplate.png")
              .pipe(
                Effect.catch((error) =>
                  logWarning("Failed to resolve the macOS tray icon", { error }).pipe(
                    Effect.as(Option.none<string>()),
                  ),
                ),
              )
          : Option.none<string>();
      const preferredIcon = environment.platform === "win32" ? iconPaths.ico : iconPaths.png;
      const iconPath = Option.getOrElse(
        Option.orElse(preferredIcon, () => Option.orElse(iconPaths.png, () => iconPaths.ico)),
        () => "",
      );
      const icon =
        environment.platform === "darwin"
          ? Option.match(macTemplatePath, {
              onNone: () => Electron.nativeImage.createEmpty(),
              onSome: (templatePath) => Electron.nativeImage.createFromPath(templatePath),
            })
          : iconPath === ""
            ? Electron.nativeImage.createEmpty()
            : iconPath;
      if (typeof icon !== "string" && environment.platform === "darwin") {
        icon.setTemplateImage(true);
      }
      const tray = yield* Effect.acquireRelease(
        Effect.sync(() => new Electron.Tray(icon)),
        (currentTray) => Effect.sync(() => currentTray.destroy()),
      );
      let displayedLabel = "";

      const updateMenu = (countLabel: string) =>
        Effect.sync(() => {
          if (countLabel === displayedLabel) return;
          displayedLabel = countLabel;
          tray.setToolTip(`T3 Code: ${countLabel}`);
          tray.setContextMenu(
            Electron.Menu.buildFromTemplate([
              {
                label: "Open T3 Code",
                click: () => {
                  void runEffect(
                    activateFromTray(desktopState.quitting, desktopWindow.activate),
                  ).catch(() => undefined);
                },
              },
              { label: countLabel, enabled: false },
              { type: "separator" },
              {
                label: "Quit T3 Code",
                click: () => {
                  void runEffect(electronApp.quit);
                },
              },
            ]),
          );
        });

      const refresh = Effect.gen(function* () {
        const instances = yield* backendPool.list;
        const instanceIds = new Set<string>(instances.map((instance) => instance.id));
        for (const id of lastCounts.keys()) {
          if (!instanceIds.has(id)) lastCounts.delete(id);
        }
        for (const id of failedBackendIds) {
          if (!instanceIds.has(id)) failedBackendIds.delete(id);
        }

        const results = yield* Effect.forEach(
          instances,
          (instance) =>
            loadCount(instance).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.map((count) => {
                if (Option.isNone(count)) {
                  lastCounts.delete(instance.id);
                  failedBackendIds.delete(instance.id);
                  return { status: "stopped" as const };
                }
                lastCounts.set(instance.id, count.value);
                failedBackendIds.delete(instance.id);
                return { status: "fresh" as const, count: count.value };
              }),
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  if (!failedBackendIds.has(instance.id)) {
                    yield* logWarning("Failed to refresh tray thread count", {
                      backendId: instance.id,
                      cause: Cause.pretty(cause),
                    });
                  }
                  failedBackendIds.add(instance.id);
                  const count = lastCounts.get(instance.id);
                  return count === undefined
                    ? { status: "unavailable" as const }
                    : { status: "stale" as const, count };
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const { count, freshness } = summarizeRunningThreadCounts(results);
        const countLabel = formatRunningThreadCountStatus(count, freshness);
        yield* updateMenu(countLabel);
      });

      yield* Effect.forkScoped(refresh.pipe(Effect.repeat(Schedule.spaced(REFRESH_INTERVAL))));
    }).pipe(Effect.withSpan("desktop.tray.configure"));

    return DesktopTray.of({ configure });
  }),
);
