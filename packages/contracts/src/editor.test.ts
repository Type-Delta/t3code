import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildRemoteOpenUrl, RemoteOpenTarget } from "./editor.ts";

const decodeRemoteOpenTarget = Schema.decodeUnknownSync(RemoteOpenTarget);

describe("RemoteOpenTarget", () => {
  it("accepts targets from servers that predate the username field", () => {
    expect(decodeRemoteOpenTarget({ kind: "mdns", host: "blackamber.local" })).toEqual({
      kind: "mdns",
      host: "blackamber.local",
    });
  });
});

describe("buildRemoteOpenUrl", () => {
  it.each([
    {
      username: "dev",
      host: "host.example",
      authority: "dev@host.example",
    },
    {
      username: "dev+work",
      host: "host.example",
      authority:
        "7b22686f73744e616d65223a22686f73742e6578616d706c65222c2275736572223a226465762b776f726b227d",
    },
    {
      username: undefined,
      host: "host+alias",
      authority: "7b22686f73744e616d65223a22686f73742b616c696173227d",
    },
  ])(
    "preserves the Remote-SSH destination $host for $username",
    ({ username, host, authority }) => {
      const url = buildRemoteOpenUrl({
        editor: "vscode",
        ...(username === undefined ? {} : { username }),
        host,
        absolutePath: "/home/dev/project",
      });

      expect(url).toBe(`vscode://vscode-remote/ssh-remote+${authority}/home/dev/project`);
      expect(new URL(url ?? "").username).toBe("");
    },
  );
});
