import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveT3ConnectTurnOn } from "./t3ConnectState";

const gatewayEnvironmentId = EnvironmentId.make("gateway-backend");
const remoteEnvironmentId = EnvironmentId.make("remote-backend");

const gatewaySession = {
  desktopApp: true,
  environmentId: gatewayEnvironmentId,
  attachedGatewayEnvironmentId: gatewayEnvironmentId,
  linkableHere: false,
  cloudConfigured: true,
  canReadRelay: true,
  canWriteRelay: true,
  connectDenial: undefined,
};

describe("resolveT3ConnectTurnOn", () => {
  it("offers Turn on for the attached gateway backend when the server reports false", () => {
    expect(resolveT3ConnectTurnOn(gatewaySession)).toEqual({ kind: "here" });
  });

  it.each([
    ["a different environment", { environmentId: remoteEnvironmentId }],
    ["a forwarded backend without a gateway attachment", { attachedGatewayEnvironmentId: null }],
    ["a browser", { desktopApp: false }],
  ] as const)("requires host-side linking for %s", (_name, overrides) => {
    expect(resolveT3ConnectTurnOn({ ...gatewaySession, ...overrides })).toEqual({
      kind: "on-host",
    });
  });
});
