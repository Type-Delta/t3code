import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ManagementApiKeyId, ManagementApiKeyScopes } from "@t3tools/contracts";

import * as ManagementApiKeyService from "./ManagementApiKeyService.ts";
import * as ManagementApiKeys from "../persistence/ManagementApiKeys.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const serviceLayer = ManagementApiKeyService.layer.pipe(
  Layer.provideMerge(ManagementApiKeys.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const decodeStoredScopes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagementApiKeyScopes),
);

const createInput = {
  name: "CI integration",
  scopes: ["models:read", "threads:list", "threads:read"] as const,
};

it.layer(NodeServices.layer)("ManagementApiKeyService", (it) => {
  it.effect("stores only a hash and resolves valid credentials", () =>
    Effect.gen(function* () {
      const service = yield* ManagementApiKeyService.ManagementApiKeyService;
      const sql = yield* SqlClient.SqlClient;

      const issued = yield* service.create(createInput);
      expect(issued.secret).toMatch(/^t3mgmt_[A-Za-z0-9-]+_[A-Za-z0-9_-]+$/);
      expect(issued.key.prefix).toMatch(/^t3mgmt_[A-Za-z0-9_-]+$/);
      expect(issued.secret.startsWith(issued.key.prefix)).toBe(true);
      expect(issued.key.lastUsedAt).toBeNull();

      const rows = yield* sql<{
        readonly secretHash: string;
        readonly secretPrefix: string;
        readonly scopes: string;
      }>`
        SELECT secret_hash AS "secretHash",
               secret_prefix AS "secretPrefix",
               scopes AS "scopes"
        FROM management_api_keys
        WHERE id = ${issued.key.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.secretHash).not.toBe(issued.secret);
      expect(rows[0]?.secretHash).toMatch(/^[a-f0-9]{64}$/);
      expect(rows[0]?.secretPrefix).toBe(issued.key.prefix);
      const storedScopes = yield* decodeStoredScopes(rows[0]?.scopes ?? "null");
      expect(storedScopes).toEqual(createInput.scopes);

      const resolved = yield* service.resolveToken(issued.secret);
      expect(Option.isSome(resolved)).toBe(true);
      if (Option.isSome(resolved)) {
        expect(resolved.value).toMatchObject({
          type: "management-key",
          keyId: issued.key.id,
          name: createInput.name,
        });
        expect([...resolved.value.scopes]).toEqual([...createInput.scopes]);
      }

      const usedRows = yield* sql<{ readonly lastUsedAt: string | null }>`
        SELECT last_used_at AS "lastUsedAt"
        FROM management_api_keys
        WHERE id = ${issued.key.id}
      `;
      expect(usedRows[0]?.lastUsedAt).not.toBeNull();

      // A second request inside the five-minute window must not turn every MCP
      // call into a SQLite write.
      const firstLastUsedAt = usedRows[0]?.lastUsedAt;
      yield* service.resolveToken(issued.secret);
      const throttledRows = yield* sql<{ readonly lastUsedAt: string | null }>`
        SELECT last_used_at AS "lastUsedAt"
        FROM management_api_keys
        WHERE id = ${issued.key.id}
      `;
      expect(throttledRows[0]?.lastUsedAt).toBe(firstLastUsedAt);

      const listed = yield* service.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: issued.key.id,
        name: issued.key.name,
        prefix: issued.key.prefix,
        scopes: issued.key.scopes,
        createdAt: issued.key.createdAt,
        expiresAt: issued.key.expiresAt,
      });
      expect("secret" in (listed[0] ?? {})).toBe(false);
      expect("secretHash" in (listed[0] ?? {})).toBe(false);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("rejects malformed, expired, and revoked credentials", () =>
    Effect.gen(function* () {
      const service = yield* ManagementApiKeyService.ManagementApiKeyService;
      const sql = yield* SqlClient.SqlClient;
      const issued = yield* service.create(createInput);

      expect(Option.isNone(yield* service.resolveToken("not-a-management-key"))).toBe(true);
      expect(Option.isNone(yield* service.resolveToken(`${issued.secret}x`))).toBe(true);

      yield* sql`
        UPDATE management_api_keys
        SET expires_at = '1960-01-01T00:00:00.000Z'
        WHERE id = ${issued.key.id}
      `;
      expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
      expect(Option.isNone(yield* service.rotate(issued.key.id))).toBe(true);

      const revoked = yield* service.revoke(issued.key.id);
      const revokedAgain = yield* service.revoke(issued.key.id);
      expect(revoked).toBe(true);
      expect(revokedAgain).toBe(false);
      expect(yield* service.list()).toHaveLength(0);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("rotates atomically from the old secret to a replacement", () =>
    Effect.gen(function* () {
      const service = yield* ManagementApiKeyService.ManagementApiKeyService;
      const issued = yield* service.create(createInput);
      const rotated = yield* service.rotate(issued.key.id);

      expect(Option.isSome(rotated)).toBe(true);
      if (Option.isNone(rotated)) return;
      expect(rotated.value.key.id).toBe(issued.key.id);
      expect(rotated.value.secret).not.toBe(issued.secret);
      expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
      expect(Option.isSome(yield* service.resolveToken(rotated.value.secret))).toBe(true);

      const missing = yield* service.rotate(ManagementApiKeyId.make("missing-management-key"));
      expect(Option.isNone(missing)).toBe(true);
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("validates scopes and expiration", () =>
    Effect.gen(function* () {
      const service = yield* ManagementApiKeyService.ManagementApiKeyService;

      const duplicateScopes = yield* service
        .create({ ...createInput, scopes: ["threads:list", "threads:list"] })
        .pipe(Effect.flip);
      expect(duplicateScopes._tag).toBe("ManagementApiKeyValidationError");
      if (duplicateScopes._tag === "ManagementApiKeyValidationError") {
        expect(duplicateScopes.reason).toBe("duplicate_scopes");
      }
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("serializes concurrent rotations and rejects stale authentication", () =>
    Effect.gen(function* () {
      const baseCrypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      let gateConsumed = false;
      let randomSeed = 0;
      const controlledCrypto = Crypto.Crypto.of({
        ...baseCrypto,
        randomBytes: (size) =>
          Effect.sync(() => {
            const bytes = new Uint8Array(size);
            bytes.fill(randomSeed);
            randomSeed += 1;
            return bytes;
          }),
        digest: (algorithm, data) => {
          if (!gateEnabled || gateConsumed) return baseCrypto.digest(algorithm, data);
          gateConsumed = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(baseCrypto.digest(algorithm, data)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provideMerge(ManagementApiKeys.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(Layer.succeed(Crypto.Crypto, controlledCrypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const firstFiber = yield* service
          .rotate(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);

        expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
        const second = yield* service.rotate(issued.key.id);
        expect(Option.isNone(second)).toBe(true);

        yield* Deferred.succeed(release, undefined);
        const first = yield* Fiber.join(firstFiber);
        expect(Option.isSome(first)).toBe(true);
        if (Option.isSome(first)) {
          expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
          expect(Option.isSome(yield* service.resolveToken(first.value.secret))).toBe(true);
        }
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("lets a concurrent revoke win without returning a replacement secret", () =>
    Effect.gen(function* () {
      const baseCrypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      let gateConsumed = false;
      let randomSeed = 0;
      const controlledCrypto = Crypto.Crypto.of({
        ...baseCrypto,
        randomBytes: (size) =>
          Effect.sync(() => {
            const bytes = new Uint8Array(size);
            bytes.fill(randomSeed);
            randomSeed += 1;
            return bytes;
          }),
        digest: (algorithm, data) => {
          if (!gateEnabled || gateConsumed) return baseCrypto.digest(algorithm, data);
          gateConsumed = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(baseCrypto.digest(algorithm, data)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provideMerge(ManagementApiKeys.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(Layer.succeed(Crypto.Crypto, controlledCrypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const rotateFiber = yield* service
          .rotate(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const revokeFiber = yield* service
          .revoke(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);

        yield* Deferred.succeed(release, undefined);
        const rotated = yield* Fiber.join(rotateFiber);
        const revoked = yield* Fiber.join(revokeFiber);
        expect(Option.isNone(rotated)).toBe(true);
        expect(revoked).toBe(true);
        expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("retries a revoke after a rotation fails", () =>
    Effect.gen(function* () {
      const baseCrypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      let gateConsumed = false;
      let randomSeed = 0;
      const controlledCrypto = Crypto.Crypto.of({
        ...baseCrypto,
        randomBytes: (size) =>
          Effect.sync(() => {
            const bytes = new Uint8Array(size);
            bytes.fill(randomSeed);
            randomSeed += 1;
            return bytes;
          }),
        digest: (algorithm, data) => {
          if (!gateEnabled || gateConsumed) return baseCrypto.digest(algorithm, data);
          gateConsumed = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(baseCrypto.digest(algorithm, data)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provideMerge(ManagementApiKeys.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(Layer.succeed(Crypto.Crypto, controlledCrypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const sql = yield* SqlClient.SqlClient;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const rotateFiber = yield* service
          .rotate(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);

        yield* sql`
          UPDATE management_api_keys
          SET expires_at = '1960-01-01T00:00:00.000Z'
          WHERE id = ${issued.key.id}
        `;
        const revokeFiber = yield* service
          .revoke(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* Deferred.succeed(release, undefined);
        expect(Option.isNone(yield* Fiber.join(rotateFiber))).toBe(true);
        expect(yield* Fiber.join(revokeFiber)).toBe(true);
        expect(yield* service.list()).toHaveLength(0);
        expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("releases an interrupted resolve reservation", () =>
    Effect.gen(function* () {
      const baseCrypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      let gateConsumed = false;
      let randomSeed = 0;
      const controlledCrypto = Crypto.Crypto.of({
        ...baseCrypto,
        randomBytes: (size) =>
          Effect.sync(() => {
            const bytes = new Uint8Array(size);
            bytes.fill(randomSeed);
            randomSeed += 1;
            return bytes;
          }),
        digest: (algorithm, data) => {
          if (!gateEnabled || gateConsumed) return baseCrypto.digest(algorithm, data);
          gateConsumed = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(baseCrypto.digest(algorithm, data)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provideMerge(ManagementApiKeys.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(Layer.succeed(Crypto.Crypto, controlledCrypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const resolveFiber = yield* service
          .resolveToken(issued.secret)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);

        yield* Fiber.interrupt(resolveFiber);
        const rotated = yield* service.rotate(issued.key.id);
        expect(Option.isSome(rotated)).toBe(true);
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("releases an interrupted revoke reservation", () =>
    Effect.gen(function* () {
      const repository = yield* ManagementApiKeys.ManagementApiKeyRepository;
      const crypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      const controlledRepository = ManagementApiKeys.ManagementApiKeyRepository.of({
        ...repository,
        revoke: (input) => {
          if (!gateEnabled) return repository.revoke(input);
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(repository.revoke(input)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provide(
          Layer.succeed(ManagementApiKeys.ManagementApiKeyRepository, controlledRepository),
        ),
        Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const revokeFiber = yield* service
          .revoke(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);

        yield* Fiber.interrupt(revokeFiber);
        gateEnabled = false;
        yield* Deferred.succeed(release, undefined);
        expect(yield* service.revoke(issued.key.id)).toBe(true);
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("reserves resolution across lookup and hashing", () =>
    Effect.gen(function* () {
      const baseCrypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      let gateConsumed = false;
      let randomSeed = 0;
      const controlledCrypto = Crypto.Crypto.of({
        ...baseCrypto,
        randomBytes: (size) =>
          Effect.sync(() => {
            const bytes = new Uint8Array(size);
            bytes.fill(randomSeed);
            randomSeed += 1;
            return bytes;
          }),
        digest: (algorithm, data) => {
          if (!gateEnabled || gateConsumed) return baseCrypto.digest(algorithm, data);
          gateConsumed = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(baseCrypto.digest(algorithm, data)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provideMerge(ManagementApiKeys.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(Layer.succeed(Crypto.Crypto, controlledCrypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const resolveFiber = yield* service
          .resolveToken(issued.secret)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);

        const rotated = yield* service.rotate(issued.key.id);
        expect(Option.isNone(rotated)).toBe(true);
        const revokeFiber = yield* service
          .revoke(issued.key.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);

        yield* Deferred.succeed(release, undefined);
        expect(Option.isSome(yield* Fiber.join(resolveFiber))).toBe(true);
        expect(yield* Fiber.join(revokeFiber)).toBe(true);
        expect(Option.isNone(yield* service.resolveToken(issued.secret))).toBe(true);
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("shares an active resolution reservation across valid requests", () =>
    Effect.gen(function* () {
      const baseCrypto = yield* Crypto.Crypto;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gateEnabled = false;
      let gateConsumed = false;
      let randomSeed = 0;
      const controlledCrypto = Crypto.Crypto.of({
        ...baseCrypto,
        randomBytes: (size) =>
          Effect.sync(() => {
            const bytes = new Uint8Array(size);
            bytes.fill(randomSeed);
            randomSeed += 1;
            return bytes;
          }),
        digest: (algorithm, data) => {
          if (!gateEnabled || gateConsumed) return baseCrypto.digest(algorithm, data);
          gateConsumed = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(baseCrypto.digest(algorithm, data)),
          );
        },
      });
      const controlledServiceLayer = Layer.fresh(ManagementApiKeyService.layer).pipe(
        Layer.provideMerge(ManagementApiKeys.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provide(Layer.succeed(Crypto.Crypto, controlledCrypto)),
      );

      yield* Effect.gen(function* () {
        const service = yield* ManagementApiKeyService.ManagementApiKeyService;
        const issued = yield* service.create(createInput);
        gateEnabled = true;
        const firstFiber = yield* service
          .resolveToken(issued.secret)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);

        const secondFiber = yield* service
          .resolveToken(issued.secret)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* service.rotate(issued.key.id))).toBe(true);

        yield* Deferred.succeed(release, undefined);
        expect(Option.isSome(yield* Fiber.join(firstFiber))).toBe(true);
        expect(Option.isSome(yield* Fiber.join(secondFiber))).toBe(true);
      }).pipe(Effect.provide(controlledServiceLayer));
    }).pipe(Effect.provide(serviceLayer)),
  );
});
