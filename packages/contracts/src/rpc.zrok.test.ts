import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ZrokShareStatus } from "./remoteAccess.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeZrokShareStatus = Schema.decodeUnknownSync(ZrokShareStatus);

describe("zrok RPC contracts", () => {
  it("registers the three public methods", () => {
    expect(WS_METHODS.serverGetZrokShareStatus).toBe("server.getZrokShareStatus");
    expect(WS_METHODS.serverStartZrokShare).toBe("server.startZrokShare");
    expect(WS_METHODS.serverStopZrokShare).toBe("server.stopZrokShare");
    for (const method of [
      WS_METHODS.serverGetZrokShareStatus,
      WS_METHODS.serverStartZrokShare,
      WS_METHODS.serverStopZrokShare,
    ]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("decodes a running status with its advertised endpoint", () => {
    expect(
      decodeZrokShareStatus({
        state: "running",
        publicUrl: "https://share.example.test/",
        message: null,
        endpoint: {
          id: "zrok",
          label: "zrok",
          provider: { id: "zrok", label: "zrok", kind: "tunnel", isAddon: false },
          httpBaseUrl: "https://share.example.test/",
          wsBaseUrl: "wss://share.example.test/",
          reachability: "public",
          compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
          source: "server",
          status: "available",
        },
      }).state,
    ).toBe("running");
  });
});
