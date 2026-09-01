# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## Compatible API gateway catalogs

Codex and Claude instances can carry an optional `apiGateway` config. This is provider-instance
state, not driver-global state, because two endpoints or API keys can expose different models and
limits. `ApiGatewaySettings` records the inference base URL, an optional catalog URL, catalog
format, authentication mode, and the generated provider environment variable that holds the key.
The UI accepts the opaque key in a password field, then stores it through the sensitive provider
environment path. The config never copies the key value.

[`GatewayModelCatalog.ts`][gateway-catalog] owns server-side discovery and caching. It derives
`/v1/models` from the inference URL unless the instance has an explicit catalog URL. Auto detection
tries Codex, Anthropic, then OpenAI formats and prefers the first result that carries metadata or
reasoning levels. Requests have a five-second timeout and accept at most 5 MiB of JSON text.

The parsers normalize these fields:

| Format    | Container | Context fields                                           | Reasoning fields                                                |
| --------- | --------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Codex     | `models`  | `context_window`, `max_context_window`, `max_tokens`     | `supported_reasoning_levels`, `default_reasoning_level`         |
| Anthropic | `data`    | `max_input_tokens`, `max_tokens`                         | `capabilities.effort.*.supported`, plus a supported default     |
| OpenAI    | `data`    | `context_length`, `max_context_length`, completion limit | `thinking.levels` or `supported_reasoning_levels`, plus default |

Each successful response is cached below the provider status cache directory using the instance ID
and a SHA-256 fingerprint of the gateway settings and resolved credential. The raw credential is
never cached. A Codex-format response also retains the original JSON in a separate file for
`model_catalog_json`. Startup loads the cached normalized models before the first network refresh.
A failed refresh keeps the current snapshot and records a nonfatal catalog error. If no cache
exists, provider status uses harness or built-in models plus explicit custom models.

`mergeGatewayModelCatalog` produces the provider snapshot. A successfully fetched or cached gateway
catalog defines the available catalog list, including an empty list. Matching harness entries
contribute capabilities that the gateway omitted, and explicit custom models are appended. Metadata
precedence is manual model override, gateway catalog, harness or built-in value, then unknown.
`contextWindowTokens` means the usable limit for this provider account.
`maxContextWindowTokens` is the theoretical model maximum. The client shows both rather than
treating a model's maximum as an account entitlement.

The Models settings tooltip renders the normalized ID, description, provider, source, context and
output limits, reasoning levels and default, and capability labels. Every visible model also
exposes a metadata editor. A model override and its custom-model list are saved in one settings
update so concurrent UI state cannot drop either value.

### Harness relay

The Codex driver adds a managed `t3_api_gateway` model provider with the Responses wire API. It
normalizes the configured path to end in `/v1`, then passes that provider-specific base URL and the
environment-variable reference through Codex `-c` arguments. A Codex-format response is passed as
`model_catalog_json`, and each new session gets
`model_context_window` for the selected model. T3 sends the selected reasoning effort through the
normal turn request. OpenAI and Anthropic catalog shapes enrich T3's picker but cannot become a
Codex `model_catalog_json` file. Descriptions and maximum-output metadata have no per-turn Codex
setting and remain informational.

The Claude driver sets `ANTHROPIC_BASE_URL` and
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. Bearer credentials map to
`ANTHROPIC_AUTH_TOKEN`; `x-api-key` credentials map to `ANTHROPIC_API_KEY`. T3 clears the opposite
variable so Claude Code sends only the selected authentication header. T3 resolves the selected
model from the normalized instance catalog before a turn or structured text-generation request, so
manual reasoning choices reach Claude Code. Claude Code does not accept an arbitrary numeric
context-window setting. Usable values above 200,000 select the `[1m]` model form, while smaller
values use the plain model ID. Maximum-output and theoretical maximum-context values remain
informational, and the gateway can still reject `[1m]` based on account entitlement.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[gateway-catalog]: ../../apps/server/src/provider/GatewayModelCatalog.ts
