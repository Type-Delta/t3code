import { msg } from "gt-react";
import type {
  ModelMetadataOverride,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";

import { m, type MessageResolver } from "../../i18n/messages";
import { formatContextWindowTokens } from "../../lib/contextWindow";

export interface ProviderModelDetailRow {
  readonly label: string;
  readonly value: string;
}

const REASONING_DESCRIPTOR_IDS = new Set(["reasoningEffort", "effort", "reasoning"]);

function reasoningDescriptor(
  model: ServerProviderModel,
): Extract<ProviderOptionDescriptor, { type: "select" }> | undefined {
  return model.capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" && REASONING_DESCRIPTOR_IDS.has(descriptor.id),
  );
}

export function formatModelTokenCount(value: number, resolve: MessageResolver = m): string {
  return resolve(
    msg("{value} tokens ({formatted})", {
      value: value.toLocaleString("en-US"),
      formatted: formatContextWindowTokens(value),
    }),
  );
}

function formatMetadataSource(source: string, resolve: MessageResolver = m): string {
  switch (source.trim().toLowerCase()) {
    case "manual":
    case "override":
      return resolve(msg("Manual override"));
    case "gateway":
    case "api-gateway":
      return resolve(msg("Gateway catalog"));
    case "harness":
      return resolve(msg("Provider harness"));
    case "built-in":
    case "builtin":
      return resolve(msg("Built in"));
    default:
      return source;
  }
}

function formatMergedMetadataSource(
  override: ModelMetadataOverride | undefined,
  detectedSource: string | undefined,
  resolve: MessageResolver = m,
): string | undefined {
  if (!override) return detectedSource ? formatMetadataSource(detectedSource, resolve) : undefined;
  if (!detectedSource) return resolve(msg("Manual override"));
  const formattedSource = formatMetadataSource(detectedSource, resolve);
  return formattedSource === resolve(msg("Manual override"))
    ? resolve(msg("Manual override"))
    : resolve(msg("Manual override + {source}", { source: formattedSource }));
}

export function deriveProviderModelDetails(
  input: {
    readonly model: ServerProviderModel;
    readonly override?: ModelMetadataOverride | undefined;
    readonly capabilityLabels: ReadonlyArray<string>;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<ProviderModelDetailRow> {
  const { model, override } = input;
  const descriptor = reasoningDescriptor(model);
  const reasoningEfforts =
    override?.reasoningEfforts ?? descriptor?.options.map((option) => option.id) ?? [];
  const defaultReasoningEffort =
    override?.defaultReasoningEffort ??
    descriptor?.currentValue ??
    descriptor?.options.find((option) => option.isDefault)?.id;
  const contextWindowTokens = override?.contextWindowTokens ?? model.metadata?.contextWindowTokens;
  const maxContextWindowTokens =
    override?.maxContextWindowTokens ?? model.metadata?.maxContextWindowTokens;
  const maxOutputTokens = override?.maxOutputTokens ?? model.metadata?.maxOutputTokens;
  const source = formatMergedMetadataSource(override, model.metadata?.source, resolve);

  return [
    { label: resolve(msg("Model ID")), value: model.slug },
    ...(model.description
      ? [{ label: resolve(msg("Description")), value: model.description }]
      : []),
    ...(model.subProvider ? [{ label: resolve(msg("Provider")), value: model.subProvider }] : []),
    ...(source ? [{ label: resolve(msg("Source")), value: source }] : []),
    ...(contextWindowTokens !== undefined
      ? [
          {
            label: resolve(msg("Usable context")),
            value: formatModelTokenCount(contextWindowTokens, resolve),
          },
        ]
      : []),
    ...(maxContextWindowTokens !== undefined
      ? [
          {
            label: resolve(msg("Maximum context")),
            value: formatModelTokenCount(maxContextWindowTokens, resolve),
          },
        ]
      : []),
    ...(maxOutputTokens !== undefined
      ? [
          {
            label: resolve(msg("Maximum output")),
            value: formatModelTokenCount(maxOutputTokens, resolve),
          },
        ]
      : []),
    ...(reasoningEfforts.length > 0
      ? [{ label: resolve(msg("Reasoning levels")), value: reasoningEfforts.join(", ") }]
      : []),
    ...(defaultReasoningEffort
      ? [{ label: resolve(msg("Default reasoning")), value: defaultReasoningEffort }]
      : []),
    ...(input.capabilityLabels.length > 0
      ? [{ label: resolve(msg("Capabilities")), value: input.capabilityLabels.join(", ") }]
      : []),
  ];
}
