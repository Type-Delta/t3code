// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

const TCP_LISTEN_STATE = "0A";
// The backend end can still be SYN_RECV when our connect callback runs.
const TCP_CONNECTED_STATES = new Set(["01", "03"]);

interface TcpEndpoint {
  readonly address: string;
  readonly port: number;
}

export interface TcpSocketRow {
  readonly local: TcpEndpoint;
  readonly remote: TcpEndpoint;
  readonly state: string;
  readonly uid: number;
  readonly inode: number;
}

// /proc prints each 32-bit word of the address in host (little-endian) byte order.
const decodeWord = (hex: string): Array<number> => [
  Number.parseInt(hex.slice(6, 8), 16),
  Number.parseInt(hex.slice(4, 6), 16),
  Number.parseInt(hex.slice(2, 4), 16),
  Number.parseInt(hex.slice(0, 2), 16),
];

export const decodeProcAddress = (hex: string): string | undefined => {
  if (hex.length === 8) return decodeWord(hex).join(".");
  if (hex.length !== 32) return undefined;
  const bytes = [0, 8, 16, 24].flatMap((offset) => decodeWord(hex.slice(offset, offset + 8)));
  const isV4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) return `::ffff:${bytes.slice(12).join(".")}`;
  if (bytes.every((byte) => byte === 0)) return "::";
  const groups = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  }
  return groups.join(":");
};

const decodeEndpoint = (field: string | undefined): TcpEndpoint | undefined => {
  const [addressHex, portHex] = field?.split(":") ?? [];
  const address = addressHex === undefined ? undefined : decodeProcAddress(addressHex);
  return address === undefined || portHex === undefined
    ? undefined
    : { address: address.replace(/^::ffff:/, ""), port: Number.parseInt(portHex, 16) };
};

const procFields = (text: string) =>
  text
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/));

/** Socket rows from the text of /proc/net/tcp or /proc/net/tcp6. IPv4-mapped addresses read as IPv4. */
export const parseProcNetTcpSockets = (text: string): Array<TcpSocketRow> =>
  procFields(text).flatMap((fields) => {
    const [local, remote] = [decodeEndpoint(fields[1]), decodeEndpoint(fields[2])];
    const [state, uid, inode] = [fields[3], fields[7], fields[9]];
    if (
      local === undefined ||
      remote === undefined ||
      state === undefined ||
      uid === undefined ||
      inode === undefined
    )
      return [];
    return [
      { local, remote, state, uid: Number.parseInt(uid, 10), inode: Number.parseInt(inode, 10) },
    ];
  });

/** LISTEN sockets from the text of /proc/net/tcp or /proc/net/tcp6. */
export const parseProcNetTcp = (text: string) =>
  procFields(text).flatMap((fields) => {
    const local = decodeEndpoint(fields[1]);
    const uid = fields[7];
    if (local === undefined || fields[3] !== TCP_LISTEN_STATE || uid === undefined) return [];
    return [{ ...local, uid: Number.parseInt(uid, 10) }];
  });

const LOOPBACK_LISTEN_ADDRESSES = new Set(["127.0.0.1", "0.0.0.0", "::"]);

/**
 * The uid owning the backend end of our loopback connection from `clientPort` to `backendPort`, or
 * undefined when that end is missing or ambiguous. An accepted socket inherits its listener's uid.
 * One not yet accepted has no inode and reads as uid 0, so it takes the uid of the port's
 * listeners; the kernel allows only one uid to listen there, and disagreement fails closed.
 */
export const loopbackPeerUid = (
  rows: ReadonlyArray<TcpSocketRow>,
  backendPort: number,
  clientPort: number,
): number | undefined => {
  const peers = rows.filter(
    (row) =>
      TCP_CONNECTED_STATES.has(row.state) &&
      row.local.address === "127.0.0.1" &&
      row.local.port === backendPort &&
      row.remote.address === "127.0.0.1" &&
      row.remote.port === clientPort,
  );
  if (peers.length !== 1) return undefined;
  if (peers[0]!.inode !== 0) return peers[0]!.uid;
  const listenerUids = new Set(
    rows
      .filter(
        (row) =>
          row.state === TCP_LISTEN_STATE &&
          row.local.port === backendPort &&
          LOOPBACK_LISTEN_ADDRESSES.has(row.local.address),
      )
      .map((row) => row.uid),
  );
  return listenerUids.size === 1 ? [...listenerUids][0] : undefined;
};

export const readTcpSockets = async (): Promise<Array<TcpSocketRow>> => {
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) =>
      NodeFSP.readFile(file, "utf8").catch(() => ""),
    ),
  );
  return tables.flatMap(parseProcNetTcpSockets);
};
