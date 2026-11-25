// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import type { GatewayConfig } from "./GatewayConfig.ts";
import { makeGatewayConfigSource } from "./GatewayConfigLoader.ts";

vi.mock("node:fs/promises", { spy: true });

const configText = (users: GatewayConfig["users"]) =>
  JSON.stringify({ version: 1, listen: { host: "127.0.0.1", port: 0 }, users });

describe("makeGatewayConfigSource", () => {
  it("sees an edit made while an earlier reload is in flight", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3gw-config-"));
    await using _cleanup = {
      [Symbol.asyncDispose]: () => NodeFSP.rm(dir, { recursive: true, force: true }),
    };
    const path = NodePath.join(dir, "gateway.json");
    await NodeFSP.writeFile(path, configText({ alice: { uid: 1001, port: 3801 } }));
    const source = await makeGatewayConfigSource(path, () => undefined);
    const inFlight = source.get();
    NodeFS.writeFileSync(path, configText({}));
    const afterEdit = source.get();
    await inFlight;
    expect((await afterEdit).users).toEqual({});
  });

  it("retries a config read after only its permissions change", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3gw-config-"));
    await using _cleanup = {
      [Symbol.asyncDispose]: () => NodeFSP.rm(dir, { recursive: true, force: true }),
    };
    const path = NodePath.join(dir, "gateway.json");
    await NodeFSP.writeFile(path, configText({}), { mode: 0o600 });
    const onError = vi.fn();
    const source = await makeGatewayConfigSource(path, onError);
    const users = { alice: { uid: 1001, port: 3801 } };
    await NodeFSP.writeFile(path, configText(users));
    await NodeFSP.chmod(path, 0o000);
    // Root can read mode 000, so inject the denial independently of the test runner's uid.
    using _read = vi
      .spyOn(NodeFSP, "readFile")
      .mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
    expect((await source.get()).users).toEqual({});
    expect(onError).toHaveBeenCalledOnce();
    await NodeFSP.chmod(path, 0o600);
    expect((await source.get()).users).toEqual(users);
  });
});
