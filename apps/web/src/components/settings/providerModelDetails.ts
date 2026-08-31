import type {
  ModelMetadataOverride,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";

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

export function formatModelTokenCount(value: number): string {
  return `${value.toLocaleString("en-US")} tokens (${formatContextWindowTokens(value)})`;
}

function formatMetadataSource(source: string): string {
  switch (source.trim().toLowerCase()) {
    case "manual":
    case "override":
      return "Manual override";
    case "gateway":
    case "api-gateway":
      return "Gateway catalog";
    case "harness":
      return "Provider harness";
    case "built-in":
    case "builtin":
      return "Built in";
    default:
      return source;
  }
}

function formatMergedMetadataSource(
  override: ModelMetadataOverride | undefined,
  detectedSource: string | undefined,
): string | undefined {
  if (!override) return detectedSource ? formatMetadataSource(detectedSource) : undefined;
  if (!detectedSource) return "Manual override";
  const formattedSource = formatMetadataSource(detectedSource);
  return formattedSource === "Manual override"
    ? "Manual override"
    : `Manual override + ${formattedSource}`;
}

export function deriveProviderModelDetails(input: {
  readonly model: ServerProviderModel;
  readonly override?: ModelMetadataOverride | undefined;
  readonly capabilityLabels: ReadonlyArray<string>;
}): ReadonlyArray<ProviderModelDetailRow> {
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
  const source = formatMergedMetadataSource(override, model.metadata?.source);

  return [
    { label: "Model ID", value: model.slug },
    ...(model.description ? [{ label: "Description", value: model.description }] : []),
    ...(model.subProvider ? [{ label: "Provider", value: model.subProvider }] : []),
    ...(source ? [{ label: "Source", value: source }] : []),
    ...(contextWindowTokens !== undefined
      ? [{ label: "Usable context", value: formatModelTokenCount(contextWindowTokens) }]
      : []),
    ...(maxContextWindowTokens !== undefined
      ? [{ label: "Maximum context", value: formatModelTokenCount(maxContextWindowTokens) }]
      : []),
    ...(maxOutputTokens !== undefined
      ? [{ label: "Maximum output", value: formatModelTokenCount(maxOutputTokens) }]
      : []),
    ...(reasoningEfforts.length > 0
      ? [{ label: "Reasoning levels", value: reasoningEfforts.join(", ") }]
      : []),
    ...(defaultReasoningEffort
      ? [{ label: "Default reasoning", value: defaultReasoningEffort }]
      : []),
    ...(input.capabilityLabels.length > 0
      ? [{ label: "Capabilities", value: input.capabilityLabels.join(", ") }]
      : []),
  ];
}
