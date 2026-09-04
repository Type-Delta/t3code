import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ManagementApiKeyId, ManagementApiKeyScopes } from "@t3tools/contracts";

import {
  type ManagementApiKeyRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const ManagementApiKeyRecord = Schema.Struct({
  id: ManagementApiKeyId,
  name: Schema.String,
  secretHash: Schema.String,
  secretPrefix: Schema.String,
  scopes: ManagementApiKeyScopes,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type ManagementApiKeyRecord = typeof ManagementApiKeyRecord.Type;

export const CreateManagementApiKeyInput = Schema.Struct({
  id: ManagementApiKeyId,
  name: Schema.String,
  secretHash: Schema.String,
  secretPrefix: Schema.String,
  scopes: ManagementApiKeyScopes,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CreateManagementApiKeyInput = typeof CreateManagementApiKeyInput.Type;

export const GetManagementApiKeyInput = Schema.Struct({
  id: ManagementApiKeyId,
});
export type GetManagementApiKeyInput = typeof GetManagementApiKeyInput.Type;

export const ReplaceManagementApiKeySecretInput = Schema.Struct({
  id: ManagementApiKeyId,
  secretHash: Schema.String,
  secretPrefix: Schema.String,
  now: Schema.DateTimeUtcFromString,
});
export type ReplaceManagementApiKeySecretInput = typeof ReplaceManagementApiKeySecretInput.Type;

export const RevokeManagementApiKeyInput = Schema.Struct({
  id: ManagementApiKeyId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeManagementApiKeyInput = typeof RevokeManagementApiKeyInput.Type;

export const TouchManagementApiKeyInput = Schema.Struct({
  id: ManagementApiKeyId,
  lastUsedAt: Schema.DateTimeUtcFromString,
  notBefore: Schema.DateTimeUtcFromString,
});
export type TouchManagementApiKeyInput = typeof TouchManagementApiKeyInput.Type;

const ManagementApiKeyDbRow = Schema.Struct({
  id: ManagementApiKeyId,
  name: Schema.String,
  secretHash: Schema.String,
  secretPrefix: Schema.String,
  scopes: Schema.fromJsonString(ManagementApiKeyScopes),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const ManagementApiKeyRawDbRow = Schema.Struct({
  id: Schema.String,
  name: Schema.Unknown,
  secretHash: Schema.Unknown,
  secretPrefix: Schema.Unknown,
  scopes: Schema.Unknown,
  createdAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  lastUsedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
});

const decodeManagementApiKeyDbRow = Schema.decodeUnknownEffect(ManagementApiKeyDbRow);

export class ManagementApiKeyRepository extends Context.Service<
  ManagementApiKeyRepository,
  {
    readonly create: (
      input: CreateManagementApiKeyInput,
    ) => Effect.Effect<void, ManagementApiKeyRepositoryError>;
    readonly getById: (
      input: GetManagementApiKeyInput,
    ) => Effect.Effect<Option.Option<ManagementApiKeyRecord>, ManagementApiKeyRepositoryError>;
    /** Lists non-revoked keys, including expired keys for administrative visibility. */
    readonly list: () => Effect.Effect<
      ReadonlyArray<ManagementApiKeyRecord>,
      ManagementApiKeyRepositoryError
    >;
    readonly replaceSecret: (
      input: ReplaceManagementApiKeySecretInput,
    ) => Effect.Effect<Option.Option<ManagementApiKeyRecord>, ManagementApiKeyRepositoryError>;
    readonly revoke: (
      input: RevokeManagementApiKeyInput,
    ) => Effect.Effect<boolean, ManagementApiKeyRepositoryError>;
    /** Updates only when the prior value is outside the throttling window. */
    readonly touchLastUsed: (
      input: TouchManagementApiKeyInput,
    ) => Effect.Effect<boolean, ManagementApiKeyRepositoryError>;
  }
>()("t3/persistence/ManagementApiKeys/ManagementApiKeyRepository") {}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): ManagementApiKeyRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

const allColumns = `
  id AS "id",
  name AS "name",
  secret_hash AS "secretHash",
  secret_prefix AS "secretPrefix",
  scopes AS "scopes",
  created_at AS "createdAt",
  expires_at AS "expiresAt",
  last_used_at AS "lastUsedAt",
  revoked_at AS "revokedAt"
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createRow = SqlSchema.void({
    Request: CreateManagementApiKeyInput,
    execute: (input) =>
      sql`
        INSERT INTO management_api_keys (
          id,
          name,
          secret_hash,
          secret_prefix,
          scopes,
          created_at,
          expires_at,
          last_used_at,
          revoked_at
        )
        VALUES (
          ${input.id},
          ${input.name},
          ${input.secretHash},
          ${input.secretPrefix},
          ${JSON.stringify(input.scopes)},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL
        )
      `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: GetManagementApiKeyInput,
    Result: ManagementApiKeyRawDbRow,
    execute: ({ id }) =>
      sql`
        SELECT ${sql.unsafe(allColumns)}
        FROM management_api_keys
        WHERE id = ${id}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ManagementApiKeyRawDbRow,
    execute: () =>
      sql`
        SELECT ${sql.unsafe(allColumns)}
        FROM management_api_keys
        WHERE revoked_at IS NULL
        ORDER BY created_at DESC, id DESC
      `,
  });

  const replaceSecretRows = SqlSchema.findOneOption({
    Request: ReplaceManagementApiKeySecretInput,
    Result: ManagementApiKeyRawDbRow,
    execute: ({ id, secretHash, secretPrefix, now }) =>
      sql`
        UPDATE management_api_keys
        SET secret_hash = ${secretHash},
            secret_prefix = ${secretPrefix},
            last_used_at = NULL,
            revoked_at = NULL
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${now})
        RETURNING ${sql.unsafe(allColumns)}
      `,
  });

  const revokeRows = SqlSchema.findAll({
    Request: RevokeManagementApiKeyInput,
    Result: Schema.Struct({ id: ManagementApiKeyId }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE management_api_keys
        SET revoked_at = ${revokedAt}
        WHERE id = ${id}
          AND revoked_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const touchRows = SqlSchema.findAll({
    Request: TouchManagementApiKeyInput,
    Result: Schema.Struct({ id: ManagementApiKeyId }),
    execute: ({ id, lastUsedAt, notBefore }) =>
      sql`
        UPDATE management_api_keys
        SET last_used_at = ${lastUsedAt}
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND (last_used_at IS NULL OR last_used_at <= ${notBefore})
        RETURNING id AS "id"
      `,
  });

  const decode = (row: typeof ManagementApiKeyRawDbRow.Type, operation: string) =>
    decodeManagementApiKeyDbRow(row).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError(operation, cause, {
          managementApiKeyId: row.id,
        }),
      ),
      Effect.map((decoded) => ({
        ...decoded,
        scopes: decoded.scopes,
      })),
    );

  const getById: ManagementApiKeyRepository["Service"]["getById"] = (input) =>
    getByIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagementApiKeyRepository.getById:query",
          "ManagementApiKeyRepository.getById:decodeRow",
          { managementApiKeyId: input.id },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decode(row, "ManagementApiKeyRepository.getById:decodeRow").pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const list: ManagementApiKeyRepository["Service"]["list"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagementApiKeyRepository.list:query",
          "ManagementApiKeyRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decode(row, "ManagementApiKeyRepository.list:decodeRows")),
      ),
    );

  const replaceSecret: ManagementApiKeyRepository["Service"]["replaceSecret"] = (input) =>
    replaceSecretRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagementApiKeyRepository.replaceSecret:query",
          "ManagementApiKeyRepository.replaceSecret:decodeRow",
          { managementApiKeyId: input.id },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decode(row, "ManagementApiKeyRepository.replaceSecret:decodeRow").pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const revoke: ManagementApiKeyRepository["Service"]["revoke"] = (input) =>
    revokeRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagementApiKeyRepository.revoke:query",
          "ManagementApiKeyRepository.revoke:decodeRows",
          { managementApiKeyId: input.id },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const touchLastUsed: ManagementApiKeyRepository["Service"]["touchLastUsed"] = (input) =>
    touchRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagementApiKeyRepository.touchLastUsed:query",
          "ManagementApiKeyRepository.touchLastUsed:decodeRows",
          { managementApiKeyId: input.id },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const create: ManagementApiKeyRepository["Service"]["create"] = (input) =>
    createRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagementApiKeyRepository.create:query",
          "ManagementApiKeyRepository.create:encodeRequest",
          { managementApiKeyId: input.id },
        ),
      ),
    );

  return {
    create,
    getById,
    list,
    replaceSecret,
    revoke,
    touchLastUsed,
  } satisfies ManagementApiKeyRepository["Service"];
});

export const layer = Layer.effect(ManagementApiKeyRepository, make);
