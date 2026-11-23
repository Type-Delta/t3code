import * as Schema from "effect/Schema";

// Fork-only multi-user gateway (FORK.md). One admin-owned install serves every enrolled user on one
// port; each user keeps a stock `t3 serve` backend on a loopback port, run as that user. OS-specific
// paths and services live in `platform/`.

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
  Schema.isPattern(/^(?!.*__)[a-z][a-z0-9._-]{0,31}$/, {
    expected:
      "a lowercase user name: a letter, then up to 31 letters, digits, '.', '_' or '-', without '__'",
  }),
);

export const GatewayAccountId = Schema.Union([
  Schema.Int,
  Schema.String.check(Schema.isPattern(/^S-1-\d+(-\d+)+$/)),
]);
export type GatewayAccountId = typeof GatewayAccountId.Type;

export const GatewayUser = Schema.Struct({
  uid: GatewayAccountId,
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

// `<pairingDir>/<user>/<uuid>.json`, written by `t3 gateway pair`. The folder names the user
// (where the platform attributes markers by file owner, it must match); content bounds its lifetime and names its token.
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
