import {
  ManagementApiKey,
  ManagementApiKeyCreateRequest,
  ManagementApiKeyId,
  ManagementApiKeyScope,
  ManagementApiKeyScopes,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ManagementApiKeys from "../persistence/ManagementApiKeys.ts";

const TOKEN_PREFIX = "t3mgmt_";
const TOKEN_SECRET_BYTES = 32;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1_000;
const TOKEN_MAX_LENGTH = 512;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const decodeManagementApiKeyId = Schema.decodeUnknownOption(ManagementApiKeyId);

type KeyMutation =
  | {
      readonly operation: "rotate" | "revoke";
      readonly completion: Deferred.Deferred<boolean>;
      readonly revokeRequested: boolean;
    }
  | {
      readonly operation: "resolve";
      readonly completion: Deferred.Deferred<boolean>;
      readonly revokeRequested: boolean;
      readonly readers: number;
    };

type RotateReservation =
  | { readonly _tag: "acquired"; readonly completion: Deferred.Deferred<boolean> }
  | { readonly _tag: "busy" };

type RevokeReservation =
  | { readonly _tag: "run"; readonly completion: Deferred.Deferred<boolean> }
  | { readonly _tag: "wait"; readonly completion: Deferred.Deferred<boolean> };

type ResolveReservation =
  | { readonly _tag: "acquired"; readonly completion: Deferred.Deferred<boolean> }
  | { readonly _tag: "joined"; readonly completion: Deferred.Deferred<boolean> }
  | { readonly _tag: "busy" };

type RotateFinish = "return" | "revoke";
type RotateFinishResult = {
  readonly finish: RotateFinish;
  readonly released: boolean;
};

export class ManagementApiKeyValidationError extends Schema.TaggedErrorClass<ManagementApiKeyValidationError>()(
  "ManagementApiKeyValidationError",
  {
    reason: Schema.Literals(["empty_scopes", "duplicate_scopes", "expired_at_creation"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty_scopes":
        return "A management API key needs at least one scope.";
      case "duplicate_scopes":
        return "A management API key cannot contain duplicate scopes.";
      case "expired_at_creation":
        return "A management API key expiration must be in the future.";
    }
  }
}

export class ManagementApiKeyServiceInternalError extends Schema.TaggedErrorClass<ManagementApiKeyServiceInternalError>()(
  "ManagementApiKeyServiceInternalError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Management API key operation failed (${this.operation}).`;
  }
}

export type ManagementApiKeyServiceError =
  | ManagementApiKeyValidationError
  | ManagementApiKeyServiceInternalError;

export interface ManagementApiKeyPrincipal {
  readonly type: "management-key";
  readonly keyId: ManagementApiKeyId;
  readonly name: string;
  readonly scopes: ReadonlySet<ManagementApiKeyScope>;
}

export interface IssuedManagementApiKey {
  readonly key: ManagementApiKey;
  readonly secret: string;
}

export class ManagementApiKeyService extends Context.Service<
  ManagementApiKeyService,
  {
    readonly create: (
      input: ManagementApiKeyCreateRequest,
    ) => Effect.Effect<IssuedManagementApiKey, ManagementApiKeyServiceError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<ManagementApiKey>,
      ManagementApiKeyServiceError
    >;
    readonly revoke: (
      id: ManagementApiKeyId,
    ) => Effect.Effect<boolean, ManagementApiKeyServiceError>;
    readonly rotate: (
      id: ManagementApiKeyId,
    ) => Effect.Effect<Option.Option<IssuedManagementApiKey>, ManagementApiKeyServiceError>;
    /**
     * Resolves a bearer token without exposing why it was rejected. Invalid,
     * unknown, expired, and revoked tokens all become `Option.none`; only
     * storage/crypto failures use the error channel.
     */
    readonly resolveToken: (
      token: string,
    ) => Effect.Effect<Option.Option<ManagementApiKeyPrincipal>, ManagementApiKeyServiceError>;
    /** Alias used by auth adapters that call all credential lookups authenticate. */
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<Option.Option<ManagementApiKeyPrincipal>, ManagementApiKeyServiceError>;
  }
>()("t3/auth/ManagementApiKeyService") {}

function isValidScopeList(
  scopes: ManagementApiKeyScopes,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "empty_scopes" | "duplicate_scopes" } {
  if (scopes.length === 0) return { ok: false, reason: "empty_scopes" };
  const unique = new Set(scopes);
  return unique.size === scopes.length ? { ok: true } : { ok: false, reason: "duplicate_scopes" };
}

function constantTimeHexEquals(expectedHex: string, actual: Uint8Array): boolean {
  // SHA-256 always has 32 bytes. Decode the stored hex into a fixed-size
  // buffer, retaining the same comparison work for malformed stored values.
  const expected = new Uint8Array(32);
  let difference = expectedHex.length === 64 ? 0 : 1;
  for (let index = 0; index < expected.length; index += 1) {
    const high = expectedHex.charCodeAt(index * 2);
    const low = expectedHex.charCodeAt(index * 2 + 1);
    const highValue = hexValue(high);
    const lowValue = hexValue(low);
    difference |= highValue.invalid | lowValue.invalid;
    expected[index] = (highValue.value << 4) | lowValue.value;
  }
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ (actual[index] ?? 0);
  }
  difference |= actual.length === expected.length ? 0 : 1;
  return difference === 0;
}

function hexValue(code: number): { readonly value: number; readonly invalid: number } {
  if (code >= 48 && code <= 57) return { value: code - 48, invalid: 0 };
  if (code >= 65 && code <= 70) return { value: code - 65 + 10, invalid: 0 };
  if (code >= 97 && code <= 102) return { value: code - 97 + 10, invalid: 0 };
  return { value: 0, invalid: 1 };
}

function parseToken(token: string): Option.Option<{ readonly id: ManagementApiKeyId }> {
  if (token.length === 0 || token.length > TOKEN_MAX_LENGTH || !token.startsWith(TOKEN_PREFIX)) {
    return Option.none();
  }
  const separator = token.indexOf("_", TOKEN_PREFIX.length);
  if (separator <= TOKEN_PREFIX.length || separator === token.length - 1) return Option.none();
  const id = token.slice(TOKEN_PREFIX.length, separator);
  const secret = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    return Option.none();
  }
  const decodedId = decodeManagementApiKeyId(id);
  return Option.isSome(decodedId) ? Option.some({ id: decodedId.value }) : Option.none();
}

function toPublic(record: ManagementApiKeys.ManagementApiKeyRecord): ManagementApiKey {
  return {
    id: record.id,
    name: record.name,
    prefix: record.secretPrefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function internal(operation: string, cause: unknown) {
  return new ManagementApiKeyServiceInternalError({ operation, cause });
}

export const make = Effect.gen(function* () {
  const repository = yield* ManagementApiKeys.ManagementApiKeyRepository;
  const crypto = yield* Crypto.Crypto;
  const mutations = yield* SynchronizedRef.make<ReadonlyMap<ManagementApiKeyId, KeyMutation>>(
    new Map(),
  );

  const hashToken = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map(bytesToHex),
      Effect.mapError((cause) => internal("hashToken", cause)),
    );

  const generateToken = (id: ManagementApiKeyId) =>
    crypto.randomBytes(TOKEN_SECRET_BYTES).pipe(
      Effect.map(tokenFromBytes),
      Effect.map((secret) => {
        const token = `${TOKEN_PREFIX}${id}_${secret}`;
        return {
          token,
          // Keep the public prefix as an actual prefix of the issued token so
          // it can identify a credential without exposing any secret bytes.
          prefix: token.slice(0, TOKEN_PREFIX.length + 8),
        };
      }),
      Effect.mapError((cause) => internal("generateToken", cause)),
    );

  const completeMutation = Effect.fn("ManagementApiKeyService.completeMutation")(function* (
    id: ManagementApiKeyId,
    completion: Deferred.Deferred<boolean>,
    result: boolean,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const removed = yield* SynchronizedRef.modify(mutations, (current) => {
          const mutation = current.get(id);
          if (mutation?.completion !== completion) return [false, current] as const;
          const next = new Map(current);
          next.delete(id);
          return [true, next] as const;
        });
        if (removed) yield* Deferred.succeed(completion, result);
      }),
    );
  });

  const reserveRotate = Effect.fn("ManagementApiKeyService.reserveRotate")(function* (
    id: ManagementApiKeyId,
  ): Effect.fn.Return<RotateReservation> {
    const completion = yield* Deferred.make<boolean>();
    return yield* SynchronizedRef.modify<
      ReadonlyMap<ManagementApiKeyId, KeyMutation>,
      RotateReservation
    >(mutations, (current) => {
      if (current.has(id)) return [{ _tag: "busy" } as const, current] as const;
      const next = new Map(current);
      next.set(id, { operation: "rotate", completion, revokeRequested: false });
      return [{ _tag: "acquired", completion } as const, next] as const;
    });
  });

  const reserveRevoke = Effect.fn("ManagementApiKeyService.reserveRevoke")(function* (
    id: ManagementApiKeyId,
  ): Effect.fn.Return<RevokeReservation> {
    const completion = yield* Deferred.make<boolean>();
    return yield* SynchronizedRef.modify<
      ReadonlyMap<ManagementApiKeyId, KeyMutation>,
      RevokeReservation
    >(mutations, (current) => {
      const active = current.get(id);
      if (active === undefined) {
        const next = new Map(current);
        next.set(id, { operation: "revoke", completion, revokeRequested: false });
        return [{ _tag: "run", completion } as const, next] as const;
      }
      if (
        (active.operation === "rotate" || active.operation === "resolve") &&
        !active.revokeRequested
      ) {
        const next = new Map(current);
        next.set(id, { ...active, revokeRequested: true });
        return [{ _tag: "wait", completion: active.completion } as const, next] as const;
      }
      return [{ _tag: "wait", completion: active.completion } as const, current] as const;
    });
  });

  const reserveResolve = Effect.fn("ManagementApiKeyService.reserveResolve")(function* (
    id: ManagementApiKeyId,
  ): Effect.fn.Return<ResolveReservation> {
    const completion = yield* Deferred.make<boolean>();
    return yield* SynchronizedRef.modify<
      ReadonlyMap<ManagementApiKeyId, KeyMutation>,
      ResolveReservation
    >(mutations, (current) => {
      const active = current.get(id);
      if (active?.operation === "resolve" && !active.revokeRequested) {
        const next = new Map(current);
        next.set(id, { ...active, readers: active.readers + 1 });
        return [{ _tag: "joined", completion: active.completion } as const, next] as const;
      }
      if (active !== undefined) return [{ _tag: "busy" } as const, current] as const;
      const next = new Map(current);
      next.set(id, { operation: "resolve", completion, revokeRequested: false, readers: 1 });
      return [{ _tag: "acquired", completion } as const, next] as const;
    });
  });

  const releaseResolve = Effect.fn("ManagementApiKeyService.releaseResolve")(function* (
    id: ManagementApiKeyId,
    completion: Deferred.Deferred<boolean>,
  ) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const finished = yield* SynchronizedRef.modify(mutations, (current) => {
          const active = current.get(id);
          if (active?.operation !== "resolve" || active.completion !== completion) {
            return [false, current] as const;
          }
          if (active.readers > 1) {
            const next = new Map(current);
            next.set(id, { ...active, readers: active.readers - 1 });
            return [false, next] as const;
          }
          const next = new Map(current);
          next.delete(id);
          return [true, next] as const;
        });
        if (finished) yield* Deferred.succeed(completion, false);
      }),
    );
  });

  /**
   * Atomically decides whether a rotation may reveal its replacement. If a
   * concurrent revoke requested the key, keep the reservation until the
   * caller has marked the row revoked, so no replacement is returned.
   */
  const takeRotateFinish = Effect.fn("ManagementApiKeyService.takeRotateFinish")(function* (
    id: ManagementApiKeyId,
    completion: Deferred.Deferred<boolean>,
  ): Effect.fn.Return<RotateFinishResult> {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* SynchronizedRef.modify<
          ReadonlyMap<ManagementApiKeyId, KeyMutation>,
          RotateFinishResult
        >(mutations, (current) => {
          const active = current.get(id);
          if (active?.completion !== completion || active.operation !== "rotate") {
            return [{ finish: "return", released: false } as const, current] as const;
          }
          if (active.revokeRequested) {
            return [{ finish: "revoke", released: false } as const, current] as const;
          }
          const next = new Map(current);
          next.delete(id);
          return [{ finish: "return", released: true } as const, next] as const;
        });
        if (result.released) yield* Deferred.succeed(completion, false);
        return result;
      }),
    );
  });

  const validateInput = Effect.fn("ManagementApiKeyService.validateInput")(function* (
    input: ManagementApiKeyCreateRequest,
    now: DateTime.Utc,
  ) {
    const scopes = isValidScopeList(input.scopes);
    if (!scopes.ok) return yield* new ManagementApiKeyValidationError({ reason: scopes.reason });
    if (
      input.expiresAt !== undefined &&
      input.expiresAt !== null &&
      input.expiresAt.epochMilliseconds <= now.epochMilliseconds
    ) {
      return yield* new ManagementApiKeyValidationError({ reason: "expired_at_creation" });
    }
  });

  const logRevoked = (id: ManagementApiKeyId, name: string) =>
    Effect.logInfo("Management API key revoked", {
      managementApiKeyId: id,
      managementApiKeyName: name,
    });

  const create: ManagementApiKeyService["Service"]["create"] = Effect.fn(
    "ManagementApiKeyService.create",
  )(function* (input) {
    const now = yield* DateTime.now;
    yield* validateInput(input, now);
    const id = ManagementApiKeyId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => internal("create.id", cause))),
    );
    const generated = yield* generateToken(id);
    const secretHash = yield* hashToken(generated.token);
    yield* repository
      .create({
        id,
        name: input.name,
        secretHash,
        secretPrefix: generated.prefix,
        scopes: input.scopes,
        createdAt: now,
        expiresAt: input.expiresAt ?? null,
      })
      .pipe(Effect.mapError((cause) => internal("create.persist", cause)));
    const key: ManagementApiKey = {
      id,
      name: input.name,
      prefix: generated.prefix,
      scopes: input.scopes,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
    };
    yield* Effect.logInfo("Management API key created", {
      managementApiKeyId: id,
      managementApiKeyName: input.name,
    });
    return { key, secret: generated.token } satisfies IssuedManagementApiKey;
  });

  const list: ManagementApiKeyService["Service"]["list"] = Effect.fn(
    "ManagementApiKeyService.list",
  )(function* () {
    return yield* repository.list().pipe(
      Effect.map((records) => records.map(toPublic)),
      Effect.mapError((cause) => internal("list", cause)),
    );
  });

  const revoke: ManagementApiKeyService["Service"]["revoke"] = Effect.fn(
    "ManagementApiKeyService.revoke",
  )(function* (id) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const recordOption = yield* restore(
          repository
            .getById({ id })
            .pipe(Effect.mapError((cause) => internal("revoke.lookup", cause))),
        );
        const name = Option.isSome(recordOption) ? recordOption.value.name : undefined;
        while (true) {
          const reservation = yield* reserveRevoke(id);
          if (reservation._tag === "wait") {
            const completed = yield* restore(Deferred.await(reservation.completion));
            // A failed rotation/resolution (or failed revoke) did not revoke
            // the key. Retry the reservation so this caller still owns it.
            if (completed) return true;
            continue;
          }
          return yield* restore(
            Effect.gen(function* () {
              const revokedAt = yield* DateTime.now;
              const revoked = yield* repository
                .revoke({ id, revokedAt })
                .pipe(Effect.mapError((cause) => internal("revoke", cause)));
              if (revoked && name !== undefined) yield* logRevoked(id, name);
              yield* completeMutation(id, reservation.completion, revoked);
              return revoked;
            }).pipe(
              Effect.ensuring(
                Effect.uninterruptible(completeMutation(id, reservation.completion, false)),
              ),
            ),
          );
        }
      }),
    );
  });

  const rotate: ManagementApiKeyService["Service"]["rotate"] = Effect.fn(
    "ManagementApiKeyService.rotate",
  )(function* (id) {
    const recordOption = yield* repository
      .getById({ id })
      .pipe(Effect.mapError((cause) => internal("rotate.lookup", cause)));
    if (Option.isNone(recordOption)) return Option.none();
    const record = recordOption.value;
    const now = yield* DateTime.now;
    if (
      record.revokedAt !== null ||
      (record.expiresAt !== null && record.expiresAt.epochMilliseconds <= now.epochMilliseconds)
    ) {
      return Option.none();
    }
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const reservation = yield* reserveRotate(id);
        if (reservation._tag === "busy") return Option.none();

        return yield* restore(
          Effect.gen(function* () {
            const generated = yield* generateToken(id);
            const secretHash = yield* hashToken(generated.token);
            const replaced = yield* repository
              .replaceSecret({ id, secretHash, secretPrefix: generated.prefix, now })
              .pipe(Effect.mapError((cause) => internal("rotate", cause)));
            if (Option.isNone(replaced)) {
              yield* completeMutation(id, reservation.completion, false);
              return Option.none();
            }
            const key = toPublic(replaced.value);
            yield* Effect.logInfo("Management API key rotated", {
              managementApiKeyId: id,
              managementApiKeyName: key.name,
            });
            const finish = yield* takeRotateFinish(id, reservation.completion);
            if (finish.finish === "revoke") {
              const revokedAt = yield* DateTime.now;
              const revoked = yield* repository
                .revoke({ id, revokedAt })
                .pipe(Effect.mapError((cause) => internal("rotate.revoke", cause)));
              if (revoked) yield* logRevoked(id, key.name);
              yield* completeMutation(id, reservation.completion, revoked);
              return Option.none();
            }
            return Option.some({ key, secret: generated.token });
          }).pipe(
            Effect.ensuring(
              Effect.uninterruptible(completeMutation(id, reservation.completion, false)),
            ),
          ),
        );
      }),
    );
  });

  const resolveToken: ManagementApiKeyService["Service"]["resolveToken"] = Effect.fn(
    "ManagementApiKeyService.resolveToken",
  )(function* (token) {
    const parsed = parseToken(token);
    if (Option.isNone(parsed)) return Option.none();
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const reservation = yield* reserveResolve(parsed.value.id);
        if (reservation._tag === "busy") return Option.none();

        return yield* restore(
          Effect.gen(function* () {
            const recordOption = yield* repository
              .getById({ id: parsed.value.id })
              .pipe(Effect.mapError((cause) => internal("resolveToken.lookup", cause)));
            if (Option.isNone(recordOption)) return Option.none();
            const record = recordOption.value;
            const now = yield* DateTime.now;
            const digest = yield* hashToken(token);
            if (
              record.revokedAt !== null ||
              (record.expiresAt !== null &&
                record.expiresAt.epochMilliseconds <= now.epochMilliseconds) ||
              !constantTimeHexEquals(record.secretHash, Uint8Array.from(Buffer.from(digest, "hex")))
            ) {
              yield* Effect.logWarning("Management API key authentication rejected", {
                managementApiKeyId: record.id,
                reason:
                  record.revokedAt !== null
                    ? "revoked"
                    : record.expiresAt !== null &&
                        record.expiresAt.epochMilliseconds <= now.epochMilliseconds
                      ? "expired"
                      : "invalid_secret",
              });
              return Option.none();
            }
            if (
              record.lastUsedAt === null ||
              now.epochMilliseconds - record.lastUsedAt.epochMilliseconds >= LAST_USED_THROTTLE_MS
            ) {
              const notBefore = DateTime.makeUnsafe(now.epochMilliseconds - LAST_USED_THROTTLE_MS);
              yield* repository
                .touchLastUsed({ id: record.id, lastUsedAt: now, notBefore })
                .pipe(Effect.mapError((cause) => internal("resolveToken.touchLastUsed", cause)));
            }
            return Option.some({
              type: "management-key",
              keyId: record.id,
              name: record.name,
              scopes: new Set(record.scopes),
            } satisfies ManagementApiKeyPrincipal);
          }).pipe(
            Effect.ensuring(
              Effect.uninterruptible(releaseResolve(parsed.value.id, reservation.completion)),
            ),
          ),
        );
      }),
    );
  });

  return {
    create,
    list,
    revoke,
    rotate,
    resolveToken,
    authenticate: resolveToken,
  } satisfies ManagementApiKeyService["Service"];
});

export const layer = Layer.effect(ManagementApiKeyService, make);
