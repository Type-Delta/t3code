"use client";

import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import type { ModelMetadataOverride } from "@t3tools/contracts";

import { m, type MessageResolver } from "../../i18n/messages";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

interface CustomModelMetadataDraft {
  readonly displayName: string;
  readonly contextWindowTokens: string;
  readonly maxContextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly reasoningEfforts: string;
  readonly defaultReasoningEffort: string;
}

const EMPTY_DRAFT: CustomModelMetadataDraft = {
  displayName: "",
  contextWindowTokens: "",
  maxContextWindowTokens: "",
  maxOutputTokens: "",
  reasoningEfforts: "",
  defaultReasoningEffort: "",
};

function draftFromOverride(value: ModelMetadataOverride | undefined): CustomModelMetadataDraft {
  if (!value) return EMPTY_DRAFT;
  return {
    displayName: value.displayName ?? "",
    contextWindowTokens: value.contextWindowTokens?.toString() ?? "",
    maxContextWindowTokens: value.maxContextWindowTokens?.toString() ?? "",
    maxOutputTokens: value.maxOutputTokens?.toString() ?? "",
    reasoningEfforts: value.reasoningEfforts?.join(", ") ?? "",
    defaultReasoningEffort: value.defaultReasoningEffort ?? "",
  };
}

function parsePositiveInteger(
  value: string,
  label: string,
  resolve: MessageResolver,
): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(resolve(msg("{label} must be a positive whole number.", { label })));
  }
  return parsed;
}

function parseEfforts(value: string): ReadonlyArray<string> {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function buildModelMetadataOverride(
  draft: CustomModelMetadataDraft,
  resolve: MessageResolver = m,
): ModelMetadataOverride {
  const displayName = draft.displayName.trim();
  const contextWindowTokens = parsePositiveInteger(
    draft.contextWindowTokens,
    resolve(msg("Usable context window")),
    resolve,
  );
  const maxContextWindowTokens = parsePositiveInteger(
    draft.maxContextWindowTokens,
    resolve(msg("Maximum context window")),
    resolve,
  );
  const maxOutputTokens = parsePositiveInteger(
    draft.maxOutputTokens,
    resolve(msg("Maximum output")),
    resolve,
  );
  const reasoningEfforts = parseEfforts(draft.reasoningEfforts);
  const defaultReasoningEffort = draft.defaultReasoningEffort.trim();

  if (
    contextWindowTokens !== undefined &&
    maxContextWindowTokens !== undefined &&
    maxContextWindowTokens < contextWindowTokens
  ) {
    throw new Error(
      resolve(msg("Maximum context window cannot be smaller than usable context window.")),
    );
  }
  if (defaultReasoningEffort && !reasoningEfforts.includes(defaultReasoningEffort)) {
    throw new Error(
      resolve(msg("Default reasoning effort must appear in the supported effort list.")),
    );
  }

  return {
    ...(displayName ? { displayName } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(maxContextWindowTokens !== undefined ? { maxContextWindowTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

interface CustomModelMetadataDialogProps {
  readonly open: boolean;
  readonly slug: string;
  readonly initialValue: ModelMetadataOverride | undefined;
  readonly mode: "add" | "edit";
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (value: ModelMetadataOverride) => void;
}

function MetadataTextField(props: {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly type?: "text" | "number";
  readonly onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={props.id} className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{props.label}</span>
      <Input
        id={props.id}
        nativeInput
        type={props.type}
        min={props.type === "number" ? 1 : undefined}
        step={props.type === "number" ? 1 : undefined}
        inputMode={props.type === "number" ? "numeric" : undefined}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        spellCheck={false}
      />
      {props.description ? (
        <span className="text-2xs leading-snug text-muted-foreground">{props.description}</span>
      ) : null}
    </label>
  );
}

export function CustomModelMetadataDialog({
  open,
  slug,
  initialValue,
  mode,
  onOpenChange,
  onSave,
}: CustomModelMetadataDialogProps) {
  const gt = useGT();
  const resolve = useMessages();
  const [draft, setDraft] = useState<CustomModelMetadataDraft>(() =>
    draftFromOverride(initialValue),
  );
  const [error, setError] = useState<string | null>(null);

  // Each opening (or a different model or value while open) starts from the saved metadata.
  const [resetInputs, setResetInputs] = useState({ initialValue, open, slug });
  if (
    resetInputs.initialValue !== initialValue ||
    resetInputs.open !== open ||
    resetInputs.slug !== slug
  ) {
    setResetInputs({ initialValue, open, slug });
    if (open) {
      setDraft(draftFromOverride(initialValue));
      setError(null);
    }
  }

  const update = (patch: Partial<CustomModelMetadataDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const handleSave = () => {
    try {
      onSave(buildModelMetadataOverride(draft, resolve));
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Check the model metadata values."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? <T>Add custom model</T> : <T>Edit model metadata</T>}
          </DialogTitle>
          <DialogDescription>
            <T>
              <code className="text-foreground">
                <Var>{slug}</Var>
              </code>
              . Leave unknown values empty instead of estimating them.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <MetadataTextField
              id="custom-model-display-name"
              label={gt("Display name")}
              value={draft.displayName}
              placeholder={slug}
              onChange={(displayName) => update({ displayName })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <MetadataTextField
                id="custom-model-context-window"
                label={gt("Usable context window")}
                description={gt("Tokens this provider account can actually accept.")}
                type="number"
                value={draft.contextWindowTokens}
                placeholder="200000"
                onChange={(contextWindowTokens) => update({ contextWindowTokens })}
              />
              <MetadataTextField
                id="custom-model-max-context-window"
                label={gt("Maximum context window")}
                description={gt("Optional theoretical model maximum.")}
                type="number"
                value={draft.maxContextWindowTokens}
                placeholder="1000000"
                onChange={(maxContextWindowTokens) => update({ maxContextWindowTokens })}
              />
            </div>
            <MetadataTextField
              id="custom-model-max-output"
              label={gt("Maximum output")}
              description={gt("Maximum output tokens reported by the gateway or provider.")}
              type="number"
              value={draft.maxOutputTokens}
              placeholder="32768"
              onChange={(maxOutputTokens) => update({ maxOutputTokens })}
            />
            <MetadataTextField
              id="custom-model-reasoning-efforts"
              label={gt("Supported reasoning efforts")}
              description={gt("Comma-separated IDs passed to the provider, such as {efforts}.", {
                efforts: "low, medium, high",
              })}
              value={draft.reasoningEfforts}
              placeholder={gt("{efforts}", { efforts: "low, medium, high" })}
              onChange={(reasoningEfforts) => update({ reasoningEfforts })}
            />
            <MetadataTextField
              id="custom-model-default-reasoning-effort"
              label={gt("Default reasoning effort")}
              description={gt("Must match one of the supported effort IDs above.")}
              value={draft.defaultReasoningEffort}
              placeholder="medium"
              onChange={(defaultReasoningEffort) => update({ defaultReasoningEffort })}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            <T>Cancel</T>
          </Button>
          <Button type="button" onClick={handleSave}>
            {mode === "add" ? <T>Add model</T> : <T>Save changes</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
