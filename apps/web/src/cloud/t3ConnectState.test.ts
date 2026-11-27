import { EnvironmentId, type EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cloudChangeReplacesLink, resolveT3ConnectTurnOn } from "./t3ConnectState";

function linkState(input: {
  readonly linked: boolean;
  readonly tunnel: boolean;
  readonly revoked?: boolean;
}): EnvironmentCloudLinkStateResult {
  return {
    linked: input.linked,
    cloudUserId: input.linked ? "user" : null,
    relayUrl: input.linked ? "https://relay.example.test" : null,
    relayIssuer: null,
    managedTunnelActive: input.tunnel,
    publishAgentActivity: input.linked,
    linkRevoked: input.revoked ?? false,
  };
}

describe("cloudChangeReplacesLink", () => {
  it.each([
    {
      name: "linking a tunnel",
      state: { linked: false, tunnel: false },
      tunnel: true,
      publish: false,
      expected: true,
    },
    {
      name: "linking publish-only",
      state: { linked: false, tunnel: false },
      tunnel: false,
      publish: true,
      expected: true,
    },
    {
      name: "repairing a revoked link",
      state: { linked: true, tunnel: true, revoked: true },
      tunnel: true,
      publish: true,
      expected: true,
    },
    {
      name: "dropping the tunnel but keeping publish",
      state: { linked: true, tunnel: true },
      tunnel: false,
      publish: true,
      expected: true,
    },
    {
      name: "adding a tunnel to a publish-only link",
      state: { linked: true, tunnel: false },
      tunnel: true,
      publish: true,
      expected: true,
    },
    {
      name: "unlinking",
      state: { linked: true, tunnel: true },
      tunnel: false,
      publish: false,
      expected: false,
    },
    {
      name: "toggling publish on a tunnel link",
      state: { linked: true, tunnel: true },
      tunnel: true,
      publish: false,
      expected: false,
    },
  ])("$name → $expected", ({ state, tunnel, publish, expected }) => {
    expect(
      cloudChangeReplacesLink(linkState(state), undefined, { managedTunnel: tunnel, publish }),
    ).toBe(expected);
  });
});

const gatewayEnvironmentId = EnvironmentId.make("gateway-backend");
const remoteEnvironmentId = EnvironmentId.make("remote-backend");

const gatewaySession = {
  environmentId: gatewayEnvironmentId,
  attachedGatewayEnvironmentId: gatewayEnvironmentId,
  linkableHere: false,
  cloudConfigured: true,
  canReadRelay: true,
  canWriteRelay: true,
  connectDenial: undefined,
};

describe("resolveT3ConnectTurnOn", () => {
  it.each([
    ["the attached gateway backend when the server reports false", {}],
    [
      "a client the server reports linkable",
      { attachedGatewayEnvironmentId: null, linkableHere: true },
    ],
  ] as const)("offers Turn on for %s", (_name, overrides) => {
    expect(resolveT3ConnectTurnOn({ ...gatewaySession, ...overrides })).toEqual({ kind: "here" });
  });

  it.each([
    ["a different environment", { environmentId: remoteEnvironmentId }],
    ["a backend without a gateway attachment", { attachedGatewayEnvironmentId: null }],
    ["the attached gateway backend without relay write access", { canWriteRelay: false }],
  ] as const)("requires host-side linking for %s", (_name, overrides) => {
    expect(resolveT3ConnectTurnOn({ ...gatewaySession, ...overrides })).toEqual({
      kind: "on-host",
    });
  });

  it("reports a managed policy denial before gateway eligibility", () => {
    expect(resolveT3ConnectTurnOn({ ...gatewaySession, connectDenial: "Blocked" })).toEqual({
      kind: "policy",
      reason: "Blocked",
    });
  });
});
