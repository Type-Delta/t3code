// oxlint-disable t3code/no-test-in-loop -- These cases intentionally exercise independent provider/process variants.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import * as ParentProcessShutdown from "./ParentProcessShutdown.ts";

it.layer(NodeServices.layer)("parent process shutdown", (it) => {
  for (const mode of ["service", "desktop", "web", "linux-desktop"] as const) {
    it.effect(`handles parent shutdown for ${mode}`, () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const messages = new NodeEvents.EventEmitter();
        const stdin = new NodeStream.PassThrough();
        const host = {
          onMessage: (listener: (value: unknown) => void) => {
            messages.on("message", listener);
          },
          offMessage: (listener: (value: unknown) => void) => {
            messages.off("message", listener);
          },
          stdin,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(ParentProcessShutdown.layer);
            const shutdown = yield* ParentProcessShutdown.ParentProcessShutdown.pipe(
              Effect.provide(context),
            );
            const request = yield* shutdown.awaitRequest.pipe(Effect.forkChild);
            messages.emit("message", { type: "update-accepted", updateId: "update-1" });
            yield* Effect.yieldNow;
            assert.isUndefined(request.pollUnsafe());
            messages.emit("message", { type: "shutdown" });
            if (mode === "service") {
              yield* Fiber.join(request);
            } else if (mode === "desktop") {
              assert.isUndefined(request.pollUnsafe());
              stdin.end();
              yield* Fiber.join(request);
            } else {
              stdin.end();
              yield* Effect.yieldNow;
              assert.isUndefined(request.pollUnsafe());
            }
          }),
        ).pipe(
          Effect.provideService(ParentProcessShutdown.ParentProcessShutdownHost, host),
          Effect.provideService(HostProcessPlatform, mode === "linux-desktop" ? "linux" : "win32"),
          Effect.provideService(
            HostProcessEnvironment,
            mode === "service" ? { [SERVICE_LAUNCHER_CONTEXT_ENV]: "managed" } : {},
          ),
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            mode: mode === "desktop" || mode === "linux-desktop" ? "desktop" : "web",
            desktopBootstrapToken:
              mode === "desktop" || mode === "linux-desktop" ? "test-token" : undefined,
          }),
        );
        assert.equal(messages.listenerCount("message"), 0);
        assert.equal(stdin.listenerCount("end"), 0);
        stdin.destroy();
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-parent-shutdown-" })),
      ),
    );
  }
});
