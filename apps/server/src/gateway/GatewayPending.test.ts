// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { readPendingUsers } from "./GatewayPending.ts";

const NOW = 1_800_000_000_000;
const uid = NodeOS.userInfo().uid;

// `files` maps "<user>/<name>" to contents; each user folder is created on demand.
const pairingDir = async (files: Record<string, string>) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3gw-pending-"));
  for (const [name, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(dir, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, name), text);
  }
  return {
    dir,
    [Symbol.asyncDispose]: () => NodeFSP.rm(dir, { recursive: true, force: true }),
  };
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.json`;
const hash = (n: number) => n.toString(16).padStart(64, "0");
const marker = (expiresAt: number, n = 0) =>
  JSON.stringify({ version: 1, expiresAt, tokenSha256: hash(n) });
const live = marker(NOW + 60_000);
const expired = marker(NOW);

describe("readPendingUsers", () => {
  it("names enrolled users with a live marker in their own folder, with its live token hashes", async () => {
    await using fixture = await pairingDir({
      [`alice/${id(1)}`]: marker(NOW, 1),
      [`alice/${id(2)}`]: marker(NOW + 60_000, 2),
      [`alice/${id(10)}`]: marker(NOW + 120_000, 10),
      [`bob/${id(3)}`]: expired,
      [`mallory/${id(4)}`]: live,
    });
    expect(
      await readPendingUsers(
        fixture.dir,
        { alice: { uid, port: 3801 }, bob: { uid, port: 3802 }, carol: { uid, port: 3803 } },
        NOW,
      ),
    ).toEqual(
      new Map([
        [
          "alice",
          {
            expiresAt: NOW + 120_000,
            tokens: new Map([
              [hash(2), NOW + 60_000],
              [hash(10), NOW + 120_000],
            ]),
          },
        ],
      ]),
    );
  });

  it("ignores expired, malformed, oversized, misnamed, foreign-owner, symlinked and non-file entries", async () => {
    await using fixture = await pairingDir({
      [`alice/${id(1)}`]: expired,
      [`alice/${id(2)}`]: marker(NOW + 2 * 60 * 60 * 1000),
      [`alice/${id(3)}`]: "{",
      [`alice/${id(4)}`]: JSON.stringify({
        version: 2,
        expiresAt: NOW + 60_000,
        tokenSha256: hash(0),
      }),
      [`alice/${id(5)}`]: JSON.stringify({
        version: 1,
        expiresAt: NOW + 60_000,
        tokenSha256: hash(0),
        pad: "x".repeat(5000),
      }),
      [`alice/${id(11)}`]: JSON.stringify({ version: 1, expiresAt: NOW + 60_000 }),
      "alice/live.json": live,
      "alice/.pending-abc": live,
      [id(9)]: live,
      [`bob/${id(6)}`]: live,
    });
    await NodeFSP.symlink(
      NodePath.join(fixture.dir, "bob", id(6)),
      NodePath.join(fixture.dir, "alice", id(7)),
    );
    await NodeFSP.mkdir(NodePath.join(fixture.dir, "alice", id(8)));
    expect(
      await readPendingUsers(
        fixture.dir,
        // bob's marker is ours, not owned by bob's registered uid.
        { alice: { uid, port: 3801 }, bob: { uid: uid + 1, port: 3802 } },
        NOW,
      ),
    ).toEqual(new Map());
  });

  it("treats a missing pairing dir or user folder as nobody pairing", async () => {
    expect(
      await readPendingUsers("/nonexistent/t3gw", { alice: { uid, port: 3801 } }, NOW),
    ).toEqual(new Map());
  });

  it("names nobody when a folder is too full or unreadable to scan to the end", async () => {
    const markers = Object.fromEntries(
      Array.from({ length: 65 }, (_, n) => [`alice/${id(n + 1)}`, expired]),
    );
    await using full = await pairingDir({ ...markers, [`bob/${id(100)}`]: live });
    const users = { alice: { uid, port: 3801 }, bob: { uid, port: 3802 } };
    expect(await readPendingUsers(full.dir, users, NOW)).toBe("unknown");

    await using unreadable = await pairingDir({ [`bob/${id(100)}`]: live });
    // A file where alice's folder belongs fails opendir with ENOTDIR, which is not "missing".
    await NodeFSP.writeFile(NodePath.join(unreadable.dir, "alice"), "");
    expect(await readPendingUsers(unreadable.dir, users, NOW)).toBe("unknown");

    // Root reads any marker, so only a regular user can see a marker it cannot open.
    if (process.getuid?.() === 0) return;
    await using lockedMarker = await pairingDir({
      [`alice/${id(1)}`]: live,
      [`bob/${id(100)}`]: live,
    });
    await NodeFSP.chmod(NodePath.join(lockedMarker.dir, "alice", id(1)), 0o000);
    expect(await readPendingUsers(lockedMarker.dir, users, NOW)).toBe("unknown");
  });
});
