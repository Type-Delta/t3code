import * as Schema from "effect/Schema";

// Fork-only multi-user gateway (FORK.md). One root-owned install serves every enrolled Linux user
// on one port; each user keeps a stock `t3 serve` backend on a loopback port, run as that user.

export const GATEWAY_INSTALL_ROOT = "/opt/t3code";
export const GATEWAY_CONFIG_DIR = "/etc/t3code";
export const GATEWAY_CONFIG_PATH = `${GATEWAY_CONFIG_DIR}/gateway.json`;
export const GATEWAY_USER_ENV_DIR = `${GATEWAY_CONFIG_DIR}/users`;
// `t3 gateway add` creates `<dir>/<user>` owned by that user, mode 0755: only they can write their
// markers, and the gateway reads only enrolled users' folders.
export const GATEWAY_PAIRING_DIR = "/var/lib/t3code/pairing";
export const GATEWAY_USER_UNIT_TEMPLATE = "t3code@.service";
export const GATEWAY_UNIT = "t3code-gateway.service";
// A pending pairing claiming a longer life is ignored, so a forgotten marker cannot route for long.
export const GATEWAY_PENDING_MAX_MS = 60 * 60 * 1000;
export const GATEWAY_ROUTE_COOKIE = "t3gw_user";
export const GATEWAY_USER_QUERY_PARAM = "u";
const GATEWAY_DEFAULT_PORT = 3773;
export const GATEWAY_BACKEND_PORT_RANGE = { first: 3801, last: 3899 } as const;
export const GATEWAY_CONFIG_PATH_ENV = "T3CODE_GATEWAY_CONFIG";
export const GATEWAY_PAIRING_DIR_ENV = "T3CODE_GATEWAY_PAIRING_DIR";

// Cookies are renamed `<name>__<user>`, so a name with "__" or a leading "_" could match another
// user's suffix ("team__alice" or "_alice" against "alice").
export const GatewayUserName = Schema.String.check(
  Schema.isPattern(/^(?!.*__)[a-z][a-z0-9._-]{0,31}$/),
);

export const GatewayUser = Schema.Struct({
  uid: Schema.Int,
  port: Schema.Int,
});

export const GatewayConfig = Schema.Struct({
  version: Schema.Literal(1),
  listen: Schema.Struct({ host: Schema.String, port: Schema.Int }),
  // Origin printed in pairing links, e.g. http://192.168.1.20:3773. Derived from listen when absent.
  publicUrl: Schema.optional(Schema.String),
  users: Schema.Record(GatewayUserName, GatewayUser),
});
export type GatewayConfig = typeof GatewayConfig.Type;

// `<GATEWAY_PAIRING_DIR>/<user>/<uuid>.json`, written by `t3 gateway pair`. The folder names the user
// (the file owner must match); content bounds its lifetime and names its token.
// `tokenSha256` (hex SHA-256 of the pairing token) lets the gateway send `POST /oauth/token` to the user
// who minted the code even when a stale route cookie names someone else.
export const GatewayPendingPairing = Schema.Struct({
  version: Schema.Literal(1),
  expiresAt: Schema.Int,
  tokenSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export const emptyGatewayConfig: GatewayConfig = {
  version: 1,
  listen: { host: "0.0.0.0", port: GATEWAY_DEFAULT_PORT },
  users: {},
};
