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
  it("puts the username in the Remote-SSH authority, not URL userinfo", () => {
    const url = buildRemoteOpenUrl({
      editor: "vscode",
      username: "aila",
      host: "blackamber.tailc5ef75.ts.net",
      absolutePath: "/home/aila/project",
    });

    expect(url).toBe(
      "vscode://vscode-remote/ssh-remote+aila@blackamber.tailc5ef75.ts.net/home/aila/project",
    );
    expect(new URL(url ?? "").username).toBe("");
  });
});
