import type {
  ApiGatewaySettings,
  CustomModelSetting,
  ModelMetadata,
  ModelMetadataOverride,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const CATALOG_FETCH_TIMEOUT_MS = 5_000;
const MAX_CATALOG_BODY_CHARS = 5 * 1024 * 1024;
const CACHE_VERSION = 2;
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownEffect(UnknownJsonString);
const encodeUnknownJson = Schema.encodeUnknownEffect(UnknownJsonString);

export interface GatewayCatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly metadata?: ModelMetadata | undefined;
  readonly reasoningEfforts?: ReadonlyArray<string> | undefined;
  readonly defaultReasoningEffort?: string | undefined;
}

export interface GatewayCatalogSnapshot {
  readonly models: ReadonlyArray<GatewayCatalogModel>;
  readonly source: "disabled" | "none" | "cache" | "network";
  readonly fetchedAt?: string | undefined;
  readonly codexCatalogPath?: string | undefined;
  readonly lastError?: string | undefined;
}

export interface GatewayModelCatalog {
  readonly current: Effect.Effect<GatewayCatalogSnapshot>;
  readonly refresh: Effect.Effect<GatewayCatalogSnapshot>;
}

interface ParsedGatewayCatalog {
  readonly format: Exclude<ApiGatewaySettings["catalogFormat"], "auto">;
  readonly models: ReadonlyArray<GatewayCatalogModel>;
  readonly rawCodexCatalog?: unknown;
}

interface GatewayCatalogCacheFile {
  readonly version: 2;
  readonly settingsFingerprint: string;
  readonly fetchedAt: string;
  readonly models: ReadonlyArray<GatewayCatalogModel>;
  readonly rawCodexCatalog?: unknown;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.round(value) : undefined;

const firstPositiveInt = (
  source: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined => {
  for (const key of keys) {
    const value = positiveInt(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const dedupeStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const reasoningEffortsFrom = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const entryRecord = record(entry);
    const effort = nonEmptyString(entryRecord?.["effort"]);
    return effort ? [effort] : [];
  });
  return dedupeStrings(efforts);
};

const anthropicReasoningFrom = (
  capabilitiesValue: unknown,
  modelDefault: string | undefined,
): {
  readonly reasoningEfforts?: ReadonlyArray<string> | undefined;
  readonly defaultReasoningEffort?: string | undefined;
} => {
  const capabilities = record(capabilitiesValue);
  if (!capabilities) return {};
  const effort = record(capabilities["effort"]);
  if (!effort) return {};

  const reasoningEfforts = dedupeStrings(
    Object.entries(effort).flatMap(([level, details]) => {
      const support = record(details);
      return support?.["supported"] === true ? [level] : [];
    }),
  );
  if (reasoningEfforts.length === 0) return {};

  const declaredDefault =
    modelDefault ??
    nonEmptyString(effort["default"]) ??
    nonEmptyString(capabilities["default_effort"]) ??
    Object.entries(effort).find(([, details]) => {
      const support = record(details);
      return support?.["default"] === true || support?.["is_default"] === true;
    })?.[0];
  const defaultReasoningEffort = reasoningEfforts.includes(declaredDefault ?? "")
    ? declaredDefault
    : undefined;

  return {
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
};

const metadataFrom = (input: {
  readonly contextWindowTokens?: number | undefined;
  readonly maxContextWindowTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}): ModelMetadata | undefined => {
  const metadata = {
    ...(input.contextWindowTokens !== undefined
      ? { contextWindowTokens: input.contextWindowTokens }
      : {}),
    ...(input.maxContextWindowTokens !== undefined
      ? { maxContextWindowTokens: input.maxContextWindowTokens }
      : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    source: "gateway",
  } satisfies ModelMetadata;
  return Object.keys(metadata).length > 1 ? metadata : undefined;
};

const parseCodexModel = (value: unknown): GatewayCatalogModel | undefined => {
  const model = record(value);
  if (!model || model["hidden"] === true || model["visibility"] === "hide") return undefined;
  const slug =
    nonEmptyString(model["slug"]) ?? nonEmptyString(model["model"]) ?? nonEmptyString(model["id"]);
  if (!slug) return undefined;
  const efforts = reasoningEffortsFrom(
    model["supported_reasoning_levels"] ?? model["supportedReasoningEfforts"],
  );
  const contextWindowTokens = firstPositiveInt(model, ["context_window", "contextWindow"]);
  const maxContextWindowTokens = firstPositiveInt(model, [
    "max_context_window",
    "maxContextWindow",
  ]);
  const maxOutputTokens = firstPositiveInt(model, ["max_tokens", "maxOutputTokens"]);
  return {
    slug,
    name: nonEmptyString(model["display_name"]) ?? nonEmptyString(model["displayName"]) ?? slug,
    ...(nonEmptyString(model["description"])
      ? { description: nonEmptyString(model["description"]) }
      : {}),
    ...(metadataFrom({ contextWindowTokens, maxContextWindowTokens, maxOutputTokens })
      ? { metadata: metadataFrom({ contextWindowTokens, maxContextWindowTokens, maxOutputTokens }) }
      : {}),
    ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
    ...(nonEmptyString(model["default_reasoning_level"])
      ? { defaultReasoningEffort: nonEmptyString(model["default_reasoning_level"]) }
      : {}),
  };
};

const parseAnthropicModel = (value: unknown): GatewayCatalogModel | undefined => {
  const model = record(value);
  if (!model) return undefined;
  const slug = nonEmptyString(model["id"]);
  if (!slug) return undefined;
  const contextWindowTokens = firstPositiveInt(model, ["max_input_tokens"]);
  const maxOutputTokens = firstPositiveInt(model, ["max_tokens"]);
  const reasoning = anthropicReasoningFrom(
    model["capabilities"],
    nonEmptyString(model["default_effort"]) ?? nonEmptyString(model["default_reasoning_level"]),
  );
  return {
    slug,
    name: nonEmptyString(model["display_name"]) ?? slug,
    ...(nonEmptyString(model["description"])
      ? { description: nonEmptyString(model["description"]) }
      : {}),
    ...(metadataFrom({ contextWindowTokens, maxOutputTokens })
      ? { metadata: metadataFrom({ contextWindowTokens, maxOutputTokens }) }
      : {}),
    ...reasoning,
  };
};

const parseOpenAiModel = (value: unknown): GatewayCatalogModel | undefined => {
  const model = record(value);
  if (!model) return undefined;
  const slug = nonEmptyString(model["id"]);
  if (!slug) return undefined;
  const thinking = record(model["thinking"]);
  const efforts = reasoningEffortsFrom(thinking?.["levels"] ?? model["supported_reasoning_levels"]);
  const contextWindowTokens = firstPositiveInt(model, [
    "context_length",
    "contextWindow",
    "inputTokenLimit",
  ]);
  const maxContextWindowTokens = firstPositiveInt(model, ["max_context_length"]);
  const maxOutputTokens = firstPositiveInt(model, [
    "max_completion_tokens",
    "max_tokens",
    "outputTokenLimit",
  ]);
  return {
    slug,
    name: nonEmptyString(model["display_name"]) ?? nonEmptyString(model["displayName"]) ?? slug,
    ...(nonEmptyString(model["description"])
      ? { description: nonEmptyString(model["description"]) }
      : {}),
    ...(metadataFrom({ contextWindowTokens, maxContextWindowTokens, maxOutputTokens })
      ? { metadata: metadataFrom({ contextWindowTokens, maxContextWindowTokens, maxOutputTokens }) }
      : {}),
    ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
    ...(nonEmptyString(model["default_reasoning_level"])
      ? { defaultReasoningEffort: nonEmptyString(model["default_reasoning_level"]) }
      : {}),
  };
};

const parseModelArray = (
  values: unknown,
  parse: (value: unknown) => GatewayCatalogModel | undefined,
): ReadonlyArray<GatewayCatalogModel> | undefined => {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set<string>();
  const models: GatewayCatalogModel[] = [];
  for (const value of values) {
    const model = parse(value);
    if (!model || seen.has(model.slug)) continue;
    seen.add(model.slug);
    models.push(model);
  }
  return models;
};

export function parseGatewayModelCatalog(
  value: unknown,
  format: ApiGatewaySettings["catalogFormat"] = "auto",
): ParsedGatewayCatalog | undefined {
  const payload = record(value);
  if (!payload) return undefined;

  if (format === "auto" || format === "codex") {
    const models = parseModelArray(payload["models"], parseCodexModel);
    if (models !== undefined) {
      return { format: "codex", models, rawCodexCatalog: value };
    }
    if (format === "codex") return undefined;
  }

  if (format === "anthropic") {
    const models = parseModelArray(payload["data"], parseAnthropicModel);
    return models === undefined ? undefined : { format: "anthropic", models };
  }

  if (format === "openai") {
    const models = parseModelArray(payload["data"], parseOpenAiModel);
    return models === undefined ? undefined : { format: "openai", models };
  }

  const data = Array.isArray(payload["data"]) ? payload["data"] : undefined;
  const isAnthropic =
    data?.some((entry) => {
      const model = record(entry);
      return model?.["max_input_tokens"] !== undefined;
    }) === true;
  const models = parseModelArray(data, isAnthropic ? parseAnthropicModel : parseOpenAiModel);
  return models === undefined
    ? undefined
    : { format: isAnthropic ? "anthropic" : "openai", models };
}

const reasoningLabel = (value: string): string => {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  return labels[value] ?? value;
};

const withReasoning = (
  capabilities: ServerProviderModel["capabilities"],
  optionId: string,
  reasoningEfforts: ReadonlyArray<string> | undefined,
  defaultReasoningEffort: string | undefined,
  overridePresent: boolean,
): ServerProviderModel["capabilities"] => {
  if (!overridePresent && reasoningEfforts === undefined && defaultReasoningEffort === undefined) {
    return capabilities;
  }
  const descriptors = [...(capabilities?.optionDescriptors ?? [])].filter(
    (descriptor) => descriptor.id !== optionId,
  );
  const previous = capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.id === optionId && descriptor.type === "select",
  );
  const efforts = dedupeStrings(
    reasoningEfforts ?? previous?.options.map((option) => option.id) ?? [],
  );
  if (efforts.length > 0) {
    const resolvedDefault = efforts.includes(defaultReasoningEffort ?? "")
      ? defaultReasoningEffort
      : efforts.includes(previous?.currentValue ?? "")
        ? previous?.currentValue
        : previous?.options.find((option) => option.isDefault && efforts.includes(option.id))?.id;
    descriptors.push({
      id: optionId,
      label: previous?.label ?? "Reasoning",
      type: "select",
      options: efforts.map((effort) => ({
        id: effort,
        label:
          previous?.options.find((option) => option.id === effort)?.label ?? reasoningLabel(effort),
        ...(resolvedDefault === effort ? { isDefault: true } : {}),
      })),
      ...(resolvedDefault ? { currentValue: resolvedDefault } : {}),
    });
  }
  return { ...capabilities, optionDescriptors: descriptors };
};

const applyOverride = (
  model: ServerProviderModel,
  override: ModelMetadataOverride | undefined,
  reasoningOptionId: string,
): ServerProviderModel => {
  if (!override) return model;
  const hasNumericOverride =
    override.contextWindowTokens !== undefined ||
    override.maxContextWindowTokens !== undefined ||
    override.maxOutputTokens !== undefined;
  const metadata =
    model.metadata || hasNumericOverride
      ? ({
          ...model.metadata,
          ...(override.contextWindowTokens !== undefined
            ? { contextWindowTokens: override.contextWindowTokens }
            : {}),
          ...(override.maxContextWindowTokens !== undefined
            ? { maxContextWindowTokens: override.maxContextWindowTokens }
            : {}),
          ...(override.maxOutputTokens !== undefined
            ? { maxOutputTokens: override.maxOutputTokens }
            : {}),
        } satisfies ModelMetadata)
      : undefined;
  return {
    ...model,
    ...(override.displayName ? { name: override.displayName } : {}),
    ...(metadata ? { metadata } : {}),
    capabilities: withReasoning(
      model.capabilities,
      reasoningOptionId,
      override.reasoningEfforts,
      override.defaultReasoningEffort,
      override.reasoningEfforts !== undefined,
    ),
  };
};

export function mergeGatewayModelCatalog(input: {
  readonly baseModels: ReadonlyArray<ServerProviderModel>;
  readonly catalog: GatewayCatalogSnapshot;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
  readonly modelOverrides: Readonly<Record<string, ModelMetadataOverride>>;
  readonly reasoningOptionId: string;
  readonly emptyCustomCapabilities?: ServerProviderModel["capabilities"];
}): ReadonlyArray<ServerProviderModel> {
  const baseBySlug = new Map(input.baseModels.map((model) => [model.slug, model] as const));
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();

  const catalogIsAuthoritative =
    input.catalog.source === "network" || input.catalog.source === "cache";

  if (catalogIsAuthoritative) {
    for (const catalogModel of input.catalog.models) {
      const base = baseBySlug.get(catalogModel.slug);
      const capabilities = withReasoning(
        base?.capabilities ?? input.emptyCustomCapabilities ?? null,
        input.reasoningOptionId,
        catalogModel.reasoningEfforts,
        catalogModel.defaultReasoningEffort,
        false,
      );
      models.push({
        ...(base ?? {
          slug: catalogModel.slug,
          isCustom: true,
          capabilities,
        }),
        name: catalogModel.name || base?.name || catalogModel.slug,
        ...(catalogModel.description
          ? { description: catalogModel.description }
          : base?.description
            ? { description: base.description }
            : {}),
        capabilities,
        metadata: { ...base?.metadata, ...catalogModel.metadata, source: "gateway" },
      });
      seen.add(catalogModel.slug);
    }
  } else {
    models.push(...input.baseModels);
    for (const model of input.baseModels) seen.add(model.slug);
  }

  for (const entry of readCustomModelEntries(input.customModels)) {
    if (seen.has(entry.slug)) continue;
    const base = baseBySlug.get(entry.slug);
    models.push(
      base ?? {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: entry.capabilities ?? input.emptyCustomCapabilities ?? null,
      },
    );
    seen.add(entry.slug);
  }

  return models.map((model) =>
    applyOverride(model, input.modelOverrides[model.slug], input.reasoningOptionId),
  );
}

export function usableModelContextWindows(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelOverrides: Readonly<Record<string, ModelMetadataOverride>>;
}): Readonly<Record<string, number>> {
  const entries = input.models.flatMap((model) => {
    const tokens = model.metadata?.contextWindowTokens;
    return tokens === undefined ? [] : [[model.slug, tokens] as const];
  });
  for (const [slug, override] of Object.entries(input.modelOverrides)) {
    if (override.contextWindowTokens !== undefined) {
      entries.push([slug, override.contextWindowTokens]);
    }
  }
  return Object.fromEntries(entries);
}

interface GatewayCatalogRequestIdentity {
  readonly url: string;
  readonly settingsFingerprint: string;
}

const parseHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
};

const resolveCatalogRequestIdentity = (
  settings: ApiGatewaySettings,
  environment: NodeJS.ProcessEnv,
): GatewayCatalogRequestIdentity | undefined => {
  const base = parseHttpUrl(settings.baseUrl);
  if (!base) return undefined;
  const explicit = settings.catalogUrl?.trim();
  const catalog = explicit ? parseHttpUrl(explicit) : new URL(base);
  if (!catalog) return undefined;
  if (!explicit) {
    const path = base.pathname.replace(/\/+$/, "");
    catalog.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
    catalog.search = "";
    catalog.hash = "";
  }
  const credential = settings.apiKeyEnvironmentVariable
    ? environment[settings.apiKeyEnvironmentVariable]?.trim()
    : undefined;
  const credentialFingerprint = credential
    ? NodeCrypto.createHash("sha256").update(credential).digest("hex")
    : null;
  const fingerprintInput = JSON.stringify({
    baseUrl: base.toString(),
    catalogUrl: catalog.toString(),
    catalogFormat: settings.catalogFormat,
    authMode: settings.authMode,
    apiKeyEnvironmentVariable: settings.apiKeyEnvironmentVariable ?? null,
    credentialFingerprint,
  });
  return {
    url: catalog.toString(),
    settingsFingerprint: NodeCrypto.createHash("sha256").update(fingerprintInput).digest("hex"),
  };
};

const cacheFileFromUnknown = (
  value: unknown,
  settingsFingerprint: string,
): GatewayCatalogCacheFile | undefined => {
  const input = record(value);
  if (
    input?.["version"] !== CACHE_VERSION ||
    input["settingsFingerprint"] !== settingsFingerprint ||
    !Array.isArray(input["models"])
  ) {
    return undefined;
  }
  const fetchedAt = nonEmptyString(input["fetchedAt"]);
  if (!fetchedAt) return undefined;
  const models = input["models"].flatMap((entry) => {
    const model = record(entry);
    const slug = nonEmptyString(model?.["slug"]);
    const name = nonEmptyString(model?.["name"]);
    if (!slug || !name) return [];
    return [entry as unknown as GatewayCatalogModel];
  });
  return {
    version: 2,
    settingsFingerprint,
    fetchedAt,
    models,
    ...(input["rawCodexCatalog"] !== undefined
      ? { rawCodexCatalog: input["rawCodexCatalog"] }
      : {}),
  };
};

const readCache = (filePath: string, settingsFingerprint: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(filePath);
    return cacheFileFromUnknown(yield* decodeUnknownJson(raw), settingsFingerprint);
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

const writeJsonFile = (filePath: string, value: unknown) =>
  encodeUnknownJson(value).pipe(
    Effect.flatMap((contents) =>
      writeFileStringAtomically({
        filePath,
        contents: `${contents}\n`,
      }),
    ),
    Effect.catchCause(() => Effect.void),
  );

const writeCodexCatalog = (filePath: string, rawCodexCatalog: unknown) =>
  writeJsonFile(filePath, rawCodexCatalog);

const requestCatalog = Effect.fn("GatewayModelCatalog.request")(function* (input: {
  readonly url: string;
  readonly format: Exclude<ApiGatewaySettings["catalogFormat"], "auto">;
  readonly settings: ApiGatewaySettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const client = yield* HttpClient.HttpClient;
  const url = new URL(input.url);
  if (input.format === "codex") {
    url.searchParams.set("client_version", "");
  }
  if (input.format === "anthropic") {
    url.searchParams.set("limit", "1000");
  }
  let request = HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.acceptJson);
  if (input.format === "anthropic") {
    request = request.pipe(HttpClientRequest.setHeader("anthropic-version", "2023-06-01"));
  }
  const apiKeyVariable = input.settings.apiKeyEnvironmentVariable;
  if (apiKeyVariable) {
    const apiKey = input.environment[apiKeyVariable]?.trim();
    if (!apiKey) return undefined;
    request =
      input.settings.authMode === "x-api-key"
        ? request.pipe(HttpClientRequest.setHeader("x-api-key", apiKey))
        : request.pipe(HttpClientRequest.bearerToken(apiKey));
  }
  const body = yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
  );
  if (body.length > MAX_CATALOG_BODY_CHARS) return undefined;
  const parsed = yield* decodeUnknownJson(body);
  return parseGatewayModelCatalog(parsed, input.format);
});

const fetchCatalog = Effect.fn("GatewayModelCatalog.fetch")(function* (input: {
  readonly settings: ApiGatewaySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly url: string;
}) {
  const formats: ReadonlyArray<Exclude<ApiGatewaySettings["catalogFormat"], "auto">> =
    input.settings.catalogFormat === "auto"
      ? ["codex", "anthropic", "openai"]
      : [input.settings.catalogFormat];
  let fallback: ParsedGatewayCatalog | undefined;
  for (const format of formats) {
    const parsed = yield* requestCatalog({ ...input, format }).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    if (!parsed) continue;
    if (parsed.models.some((model) => model.metadata || model.reasoningEfforts?.length)) {
      return parsed;
    }
    fallback ??= parsed;
  }
  return fallback;
});

export const makeGatewayModelCatalog = Effect.fn("makeGatewayModelCatalog")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ApiGatewaySettings | undefined;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  GatewayModelCatalog,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | ServerConfig
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const cachePath = path.join(
    config.providerStatusCacheDir,
    `${input.instanceId}.gateway-models.json`,
  );
  const codexCatalogPath = path.join(
    config.providerStatusCacheDir,
    `${input.instanceId}.codex-models.json`,
  );
  const requestIdentity = input.settings?.enabled
    ? resolveCatalogRequestIdentity(input.settings, input.environment)
    : undefined;
  const cached = requestIdentity
    ? yield* readCache(cachePath, requestIdentity.settingsFingerprint).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      )
    : undefined;
  const cachedHasCodexCatalog = cached?.rawCodexCatalog !== undefined && cached.models.length > 0;
  if (cachedHasCodexCatalog) {
    yield* writeCodexCatalog(codexCatalogPath, cached.rawCodexCatalog).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  }
  const initial: GatewayCatalogSnapshot = !input.settings?.enabled
    ? { models: [], source: "disabled" }
    : cached
      ? {
          models: cached.models,
          source: "cache",
          fetchedAt: cached.fetchedAt,
          ...(cachedHasCodexCatalog ? { codexCatalogPath } : {}),
        }
      : { models: [], source: "none" };
  const snapshotRef = yield* Ref.make(initial);
  const semaphore = yield* Semaphore.make(1);

  const refresh = semaphore.withPermits(1)(
    Effect.gen(function* () {
      if (!input.settings?.enabled) return yield* Ref.get(snapshotRef);
      if (!requestIdentity) {
        const next = {
          models: [],
          source: "none",
          lastError: "Model catalog URL must use HTTP or HTTPS without embedded credentials.",
        } satisfies GatewayCatalogSnapshot;
        yield* Ref.set(snapshotRef, next);
        return next;
      }
      const parsed = yield* fetchCatalog({
        settings: input.settings,
        environment: input.environment,
        url: requestIdentity.url,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.timeoutOption(CATALOG_FETCH_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(Option.none<ParsedGatewayCatalog | undefined>())),
      );
      const catalog = Option.isSome(parsed) ? parsed.value : undefined;
      if (!catalog) {
        const previous = yield* Ref.get(snapshotRef);
        const next = {
          ...previous,
          lastError: "Model catalog request failed.",
        } satisfies GatewayCatalogSnapshot;
        yield* Ref.set(snapshotRef, next);
        return next;
      }
      const fetchedAt = DateTime.formatIso(yield* DateTime.now);
      const cache = {
        version: 2,
        settingsFingerprint: requestIdentity.settingsFingerprint,
        fetchedAt,
        models: catalog.models,
        ...(catalog.rawCodexCatalog !== undefined
          ? { rawCodexCatalog: catalog.rawCodexCatalog }
          : {}),
      } satisfies GatewayCatalogCacheFile;
      yield* writeJsonFile(cachePath, cache).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const hasCodexCatalog = catalog.rawCodexCatalog !== undefined && catalog.models.length > 0;
      if (hasCodexCatalog) {
        yield* writeCodexCatalog(codexCatalogPath, catalog.rawCodexCatalog).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      }
      const next = {
        models: catalog.models,
        source: "network",
        fetchedAt,
        ...(hasCodexCatalog ? { codexCatalogPath } : {}),
      } satisfies GatewayCatalogSnapshot;
      yield* Ref.set(snapshotRef, next);
      return next;
    }),
  );

  return {
    current: Ref.get(snapshotRef),
    refresh,
  } satisfies GatewayModelCatalog;
});
