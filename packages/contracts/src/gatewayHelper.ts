import * as Schema from "effect/Schema";

// Fork-only (FORK.md): the multi-user gateway's privileged helper. It listens on loopback, names
// the caller by the OS account that owns the connecting socket, and lets that account join, leave
// or update the machine's shared T3 Code. The desktop app uses it to find and join the gateway.

export const GATEWAY_HELPER_PORT = 3774;
/** Required on every request with value "1"; browsers cannot send it cross-origin without a preflight the helper never allows. */
export const GATEWAY_HELPER_HEADER = "x-t3-gateway-helper";
/** How long the helper may take to download and stage an update before it answers the request. */
export const GATEWAY_HELPER_STAGE_TIMEOUT_MS = 15 * 60 * 1000;

export const GatewayHelperUpdateState = Schema.Struct({
  state: Schema.Literals(["running", "failed"]),
  version: Schema.String,
  /** Failure reason, or progress text while running. */
  message: Schema.optional(Schema.String),
  /** Epoch milliseconds of the last change. */
  updatedAt: Schema.Int,
});
export type GatewayHelperUpdateState = typeof GatewayHelperUpdateState.Type;

/** `GET /v1/status`. */
export const GatewayHelperStatus = Schema.Struct({
  version: Schema.Literal(1),
  /** Version of the installed shared runtime. */
  runtimeVersion: Schema.String,
  /** Whether users may join, leave and update without an administrator. */
  selfService: Schema.Boolean,
  /** Windows: joining needs the caller's own account password once; it is never stored. */
  joinNeedsPassword: Schema.Boolean,
  /** The caller's gateway user name. */
  user: Schema.String,
  enrolled: Schema.Boolean,
  /** Loopback port of the caller's backend when enrolled. */
  backendPort: Schema.optional(Schema.Int),
  /** The last update anyone requested, until it succeeds. */
  update: Schema.optional(GatewayHelperUpdateState),
});
export type GatewayHelperStatus = typeof GatewayHelperStatus.Type;

/** `POST /v1/join`. Answers with the new status. */
export const GatewayHelperJoinRequest = Schema.Struct({
  /** Windows: the caller's password, RSA-OAEP (SHA-256) encrypted to the gateway's published key, base64. */
  encryptedPassword: Schema.optional(Schema.String),
});

/** `POST /v1/leave` takes an empty object and answers with the new status. */

/** `POST /v1/update`. Answers 202 with the status; poll status until `runtimeVersion` matches or `update.state` is "failed". */
export const GatewayHelperUpdateRequest = Schema.Struct({
  version: Schema.String,
});

/** Body of every non-2xx answer. */
export const GatewayHelperError = Schema.Struct({
  error: Schema.String,
});
