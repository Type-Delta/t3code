import { describe, expect, it } from "@effect/vitest";

import {
  decodeProcAddress,
  loopbackPeerUid,
  parseProcNetTcp,
  parseProcNetTcpSockets,
} from "./GatewayListeners.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
// 3801 listens for uid 1001; client port 40000 is connected to it (both ends listed).
const TCP = [
  HEADER,
  "   0: 0100007F:0ED9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 1 1 0 100 0 0 10 0",
  "   1: 0100007F:0ED9 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 2 1 0 100 0 0 10 0",
  "   2: 0100007F:9C40 0100007F:0ED9 01 00000000:00000000 00:00000000 00000000   999        0 3 1 0 100 0 0 10 0",
  "   3: 0100007F:0EDB 0100007F:9C44 03 00000000:00000000 00:00000000 00000000  1005        0 8 1 0 100 0 0 10 0",
  "   4: 0100007F:0EDA 0100007F:9C41 08 00000000:00000000 00:00000000 00000000  1002        0 4 1 0 100 0 0 10 0",
].join("\n");
// 3804 listens on [::] for uid 1003; client port 40002 reaches it through an IPv4-mapped socket.
const TCP6 = [
  HEADER,
  "   0: 00000000000000000000000000000000:0EDC 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 5 1 0 100 0 0 10 0",
  "   1: 0000000000000000FFFF00000100007F:0EDC 0000000000000000FFFF00000100007F:9C42 01 00000000:00000000 00:00000000 00000000  1003        0 6 1 0 100 0 0 10 0",
  "   2: 00000000000000000000000001000000:0EDD 00000000000000000000000001000000:9C43 01 00000000:00000000 00:00000000 00000000  1004        0 7 1 0 100 0 0 10 0",
].join("\n");

// Connections still in the backend's accept queue have no inode, and /proc reports uid 0 for them.
// 3806 has one listener (uid 1006). 3807 has listeners for two uids, so its owner is ambiguous.
const UNACCEPTED = [
  HEADER,
  "   0: 0100007F:0EDE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1006        0 9 1 0 100 0 0 10 0",
  "   1: 0100007F:0EDE 0100007F:9C45 01 00000000:00000000 00:00000000 00000000     0        0 0 1 0 100 0 0 10 0",
  "   2: 0100007F:0EDF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1007        0 10 1 0 100 0 0 10 0",
  "   3: 00000000:0EDF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1008        0 11 1 0 100 0 0 10 0",
  "   4: 0100007F:0EDF 0100007F:9C46 01 00000000:00000000 00:00000000 00000000     0        0 0 1 0 100 0 0 10 0",
].join("\n");

describe("parseProcNetTcp", () => {
  it("decodes both endpoints, state and uid, reading IPv4-mapped addresses as IPv4", () => {
    expect(parseProcNetTcpSockets(TCP)[1]).toEqual({
      local: { address: "127.0.0.1", port: 3801 },
      remote: { address: "127.0.0.1", port: 40000 },
      state: "01",
      uid: 1001,
      inode: 2,
    });
    expect(parseProcNetTcpSockets(TCP6).map((row) => row.local.address)).toEqual([
      "::",
      "127.0.0.1",
      "0:0:0:0:0:0:0:1",
    ]);
  });

  it("lists only LISTEN sockets", () => {
    expect(parseProcNetTcp(TCP)).toEqual([{ address: "127.0.0.1", port: 3801, uid: 1001 }]);
    expect(parseProcNetTcp(TCP6)).toEqual([{ address: "::", port: 3804, uid: 1003 }]);
  });

  it("decodes a global IPv6 address word by word", () => {
    // 2001:db8::1, as /proc prints it.
    expect(decodeProcAddress("B80D0120000000000000000001000000")).toBe("2001:db8:0:0:0:0:0:1");
  });
});

describe("loopbackPeerUid", () => {
  const rows = [TCP, TCP6, UNACCEPTED].flatMap(parseProcNetTcpSockets);

  it.each([
    ["backend end of an IPv4 connection, not our own end", 3801, 40000, 1001],
    ["IPv4-mapped backend end on a dual-stack listener", 3804, 40002, 1003],
    ["a backend end still in SYN_RECV", 3803, 40004, 1005],
    ["a closing connection does not count", 3802, 40001, undefined],
    ["::1 is not where 127.0.0.1 connects", 3805, 40003, undefined],
    ["no such connection", 3801, 40009, undefined],
    ["a backend end not yet accepted takes its listener's uid", 3806, 40005, 1006],
    ["a backend end not yet accepted with listeners of two uids", 3807, 40006, undefined],
  ] as const)("%s", (_name, backendPort, clientPort, expected) => {
    expect(loopbackPeerUid(rows, backendPort, clientPort)).toBe(expected);
  });
});
