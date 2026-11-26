import {
  AlertTriangleIcon,
  CheckIcon,
  ClipboardIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Trash2Icon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  createEnvironmentManagementApiKey,
  listEnvironmentManagementApiKeys,
  ManagementApiKeyRequestError,
  revokeEnvironmentManagementApiKey,
  rotateEnvironmentManagementApiKey,
  type ManagementApiKeyCreateInput,
  type ManagementApiKeyCreateResult,
  type ManagementApiKeyRecord,
} from "~/environments/managementApiKeys";
import { m, type MessageResolver } from "~/i18n/messages";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { cn } from "~/lib/utils";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { EnvironmentSettingsTabs } from "./EnvironmentSettingsTabs";
import {
  buildManagementApiKeyCodexExample,
  buildManagementApiKeyEnvironmentOptions,
  buildManagementApiKeyJsonExample,
  canRotateManagementApiKey,
  clearManagementApiKeyReveal,
  MANAGEMENT_API_KEY_PRESETS,
  MANAGEMENT_API_KEY_SCOPE_DETAILS,
  managementApiKeyScopeSummary,
  resolveManagementApiKeyExpiration,
  resolveSelectedManagementApiKeyEnvironmentId,
  revealManagementApiKey,
  scopesForManagementApiKeyPreset,
  type ManagementApiKeyExpiration,
  type ManagementApiKeyPreset,
  type ManagementApiKeyRevealState,
  type ManagementApiKeyScope,
} from "./ManagementApiKeysSettings.logic";

function useRelativeTimeTick(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep expiration labels in step with the clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const DEFAULT_EXPIRATION: ManagementApiKeyExpiration = "90-days";
const DEFAULT_PRESET: ManagementApiKeyPreset = "read-only";

type SecretRevealState = NonNullable<ManagementApiKeyRevealState<ManagementApiKeyCreateResult>> & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
};

const EXPIRATION_OPTIONS: ReadonlyArray<{
  readonly value: ManagementApiKeyExpiration;
  readonly label: string;
}> = [
  { value: "30-days", label: msg("30 days") },
  { value: "90-days", label: msg("90 days") },
  { value: "1-year", label: msg("1 year") },
  { value: "never", label: msg("Never", { $context: "API key expiration choice" }) },
];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function formatLastUsed(value: string | null, nowMs: number, resolve: MessageResolver = m): string {
  if (value === null) return resolve(msg("Not used yet"));
  const elapsed = formatElapsedDurationLabel(value, nowMs, resolve);
  return elapsed === resolve(msg("just now"))
    ? resolve(msg("Used {elapsed}", { elapsed }))
    : resolve(msg("Used {elapsed} ago", { elapsed }));
}

const isManagementApiKeyRequestError = Schema.is(ManagementApiKeyRequestError);

function readErrorMessage(error: unknown): string {
  if (isManagementApiKeyRequestError(error)) {
    if (error.status === 401 || error.status === 403) {
      return m(msg("You need access-management permission to manage API keys."));
    }
    return error.message;
  }
  return error instanceof Error ? error.message : m(msg("Could not update management API keys."));
}

function keyExpiryState(
  key: ManagementApiKeyRecord,
  nowMs: number,
  resolve: MessageResolver = m,
): {
  readonly label: string;
  readonly tone: "default" | "warning" | "error";
} {
  if (key.expiresAt === null) {
    return { label: resolve(msg("Never expires")), tone: "default" };
  }
  const label = formatExpiresInLabel(key.expiresAt, nowMs, resolve);
  const expiresAt = new Date(key.expiresAt).getTime();
  if (expiresAt <= nowMs) return { label, tone: "error" };
  return {
    label,
    tone: expiresAt - nowMs <= 7 * 24 * 60 * 60 * 1_000 ? "warning" : "default",
  };
}

function KeyRow({
  keyRecord,
  nowMs,
  busyAction,
  canMutate,
  onRotate,
  onRevoke,
}: {
  readonly keyRecord: ManagementApiKeyRecord;
  readonly nowMs: number;
  readonly busyAction: "rotate" | "revoke" | null;
  readonly canMutate: boolean;
  readonly onRotate: () => void;
  readonly onRevoke: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const expiry = keyExpiryState(keyRecord, nowMs, m);
  const isBusy = busyAction !== null;
  const canRotate = canRotateManagementApiKey(keyRecord.expiresAt, nowMs);
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-muted/15 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <h3 className="min-w-0 break-words text-sm font-medium text-foreground">
              {keyRecord.name}
            </h3>
            <Badge variant={expiry.tone} size="sm">
              {expiry.label}
            </Badge>
          </div>
          <code className="block max-w-full break-all text-xs text-muted-foreground">
            {keyRecord.prefix || "t3mgmt_…"}
          </code>
        </div>
        <div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto sm:justify-end">
          {canRotate ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isBusy || !canMutate}
              onClick={onRotate}
              aria-label={gt("Rotate {name}", { name: keyRecord.name })}
            >
              <RotateCwIcon aria-hidden />
              {busyAction === "rotate" ? <T>Rotating…</T> : <T>Rotate</T>}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={isBusy || !canMutate}
            onClick={onRevoke}
            aria-label={gt("Revoke {name}", { name: keyRecord.name })}
          >
            <Trash2Icon aria-hidden />
            {busyAction === "revoke" ? <T>Revoking…</T> : <T>Revoke</T>}
          </Button>
        </div>
      </div>
      <div className="mt-3 grid min-w-0 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="min-w-0">
          <span className="block text-2xs uppercase tracking-wide text-muted-foreground/70">
            <T>Access</T>
          </span>
          <span className="break-words text-foreground/85">
            {managementApiKeyScopeSummary(keyRecord.scopes, m)}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-2xs uppercase tracking-wide text-muted-foreground/70">
            <T>Activity</T>
          </span>
          <span className="break-words text-foreground/85">
            <T>
              Created <Var>{formatDate(keyRecord.createdAt)}</Var>
            </T>
            {` · ${formatLastUsed(keyRecord.lastUsedAt, nowMs, m)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

function CreateManagementApiKeyDialog({
  open,
  environmentLabel,
  isSubmitting,
  error,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly environmentLabel: string;
  readonly isSubmitting: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly scopes: ReadonlyArray<ManagementApiKeyScope>;
    readonly expiresAt: string | null;
  }) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState<ManagementApiKeyExpiration>(DEFAULT_EXPIRATION);
  const [preset, setPreset] = useState<ManagementApiKeyPreset>(DEFAULT_PRESET);
  const [customScopes, setCustomScopes] = useState<ReadonlyArray<ManagementApiKeyScope>>(
    scopesForManagementApiKeyPreset(DEFAULT_PRESET),
  );
  const formId = useId();

  // Each opening starts a fresh form.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName("");
      setExpiration(DEFAULT_EXPIRATION);
      setPreset(DEFAULT_PRESET);
      setCustomScopes(scopesForManagementApiKeyPreset(DEFAULT_PRESET));
    }
  }

  const selectedScopes = scopesForManagementApiKeyPreset(preset, customScopes);
  const selectedExpiration = EXPIRATION_OPTIONS.find((option) => option.value === expiration);
  const selectedPreset = MANAGEMENT_API_KEY_PRESETS.find((option) => option.value === preset);
  const toggleScope = (scope: ManagementApiKeyScope, checked: boolean) => {
    setCustomScopes((current) => {
      const next = checked
        ? [...current, scope]
        : current.filter((candidate) => candidate !== scope);
      return MANAGEMENT_API_KEY_SCOPE_DETAILS.map((detail) => detail.scope).filter((candidate) =>
        next.includes(candidate),
      );
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || selectedScopes.length === 0) return;
    onSubmit({
      name: trimmedName,
      scopes: selectedScopes,
      expiresAt: resolveManagementApiKeyExpiration(expiration),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>
              Create management API key for <Var>{environmentLabel}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Create a durable credential for <Var>{environmentLabel}</Var>. The full secret is
              shown once.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} onSubmit={handleSubmit}>
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="management-api-key-name">
                  <T>Name</T>
                </Label>
                <Input
                  id="management-api-key-name"
                  value={name}
                  onValueChange={setName}
                  placeholder={gt("My {protocol} client", {
                    protocol: "MCP",
                    $context: "API key name example",
                  })}
                  autoFocus
                  required
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="management-api-key-expiration">
                    <T>Expiration</T>
                  </Label>
                  <Select
                    value={expiration}
                    onValueChange={(value) => {
                      if (value && EXPIRATION_OPTIONS.some((option) => option.value === value)) {
                        setExpiration(value as ManagementApiKeyExpiration);
                      }
                    }}
                  >
                    <SelectTrigger id="management-api-key-expiration" className="w-full">
                      <SelectValue>
                        {selectedExpiration ? m(selectedExpiration.label) : null}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {EXPIRATION_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {m(option.label)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="management-api-key-preset">
                    <T>Access preset</T>
                  </Label>
                  <Select
                    value={preset}
                    onValueChange={(value) => {
                      if (
                        !value ||
                        !MANAGEMENT_API_KEY_PRESETS.some((option) => option.value === value)
                      )
                        return;
                      const nextPreset = value as ManagementApiKeyPreset;
                      setPreset(nextPreset);
                      if (nextPreset !== "custom") {
                        setCustomScopes(scopesForManagementApiKeyPreset(nextPreset));
                      }
                    }}
                  >
                    <SelectTrigger id="management-api-key-preset" className="w-full">
                      <SelectValue>{selectedPreset ? m(selectedPreset.label) : null}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {MANAGEMENT_API_KEY_PRESETS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <span className="flex flex-col gap-0.5">
                            <span>{m(option.label)}</span>
                            <span className="text-xs text-muted-foreground">
                              {m(option.description)}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>

              {preset === "custom" ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-foreground">
                    <T>Custom scopes</T>
                  </legend>
                  <div className="grid gap-1 rounded-lg border border-border/60 p-2 sm:grid-cols-2">
                    {MANAGEMENT_API_KEY_SCOPE_DETAILS.map((detail) => (
                      <label
                        key={detail.scope}
                        className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={customScopes.includes(detail.scope)}
                          onCheckedChange={(checked) => toggleScope(detail.scope, Boolean(checked))}
                          aria-label={m(detail.label)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-foreground">{m(detail.label)}</span>
                          <span className="block text-xs leading-relaxed text-muted-foreground">
                            {m(detail.description)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {selectedScopes.length === 0 ? (
                    <p className="text-xs text-destructive">
                      <T>Choose at least one scope.</T>
                    </p>
                  ) : null}
                </fieldset>
              ) : null}

              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            <T>Cancel</T>
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={isSubmitting || !name.trim() || selectedScopes.length === 0}
          >
            {isSubmitting ? <Spinner /> : <PlusIcon aria-hidden />}
            {isSubmitting ? <T>Creating…</T> : <T>Create key</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SecretRevealDialog({
  result,
  onClose,
}: {
  readonly result: SecretRevealState;
  readonly onClose: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<{ readonly value: string }>({
    target: {
      target: "management API key",
      unavailableMessage: msg("Clipboard API is unavailable while copying the management API key."),
      failureMessage: msg("Failed to copy the management API key to the clipboard."),
    },
  });
  const jsonExample = buildManagementApiKeyJsonExample(result.mcpEndpoint);
  const codexExample = buildManagementApiKeyCodexExample(result.mcpEndpoint);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape and backdrop dismissal are intentionally ignored. The only
        // close path is the explicit acknowledgement button below, which
        // clears the secret from the parent state.
        if (open) return;
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {result.operation === "created" ? (
              <T>Management API key created</T>
            ) : (
              <T>Management API key rotated</T>
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Copy this secret now. It will not be shown again, and closing this dialog clears it
              from the page.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm">
              <T>
                Environment:{" "}
                <span className="font-medium text-foreground">
                  <Var>{result.environmentLabel}</Var>
                </span>
              </T>
            </div>
            <div className="rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm text-warning-foreground">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  <T>
                    Anyone with this secret can use the scopes granted to “
                    <Var>{result.key.name}</Var>”. Store it in a password manager or environment
                    variable.
                  </T>
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="management-api-key-secret">
                <T>One-time secret</T>
              </Label>
              <Textarea
                id="management-api-key-secret"
                readOnly
                value={result.secret}
                rows={3}
                variant="code"
                className="break-all"
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(result.secret, { value: result.secret })}
              >
                {isCopied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
                {isCopied ? <T>Copied</T> : <T>Copy secret</T>}
              </Button>
            </div>
            <div className="space-y-2">
              <Label>
                <T>
                  <Var>MCP</Var> endpoint
                </T>
              </Label>
              <code className="block max-w-full break-all rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-foreground">
                {result.mcpEndpoint}
              </code>
            </div>
            <div className="space-y-2">
              <Label>
                <T>
                  Generic <Var>JSON HTTP MCP</Var>
                </T>
              </Label>
              <Textarea
                readOnly
                value={jsonExample}
                rows={10}
                variant="code"
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
            <div className="space-y-2">
              <Label>
                <T>
                  <Var>Codex</Var>
                </T>
              </Label>
              <Textarea
                readOnly
                value={codexExample}
                rows={4}
                variant="code"
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                <T>
                  Set{" "}
                  <code>
                    <Var>T3_MANAGEMENT_API_KEY</Var>
                  </code>{" "}
                  in the environment where <Var>Codex</Var> runs before starting it.
                </T>
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Done and clear secret</T>
          </Button>
          <Button onClick={() => copyToClipboard(result.secret, { value: result.secret })}>
            {isCopied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
            {isCopied ? <T>Copied</T> : <T>Copy secret</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type PendingAction =
  | {
      readonly kind: "rotate";
      readonly key: ManagementApiKeyRecord;
      readonly target: ManagementApiKeyTarget;
    }
  | {
      readonly kind: "revoke";
      readonly key: ManagementApiKeyRecord;
      readonly target: ManagementApiKeyTarget;
    }
  | null;

interface ManagementApiKeyTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly prepared: PreparedConnection;
}

interface ManagementApiKeyEnvironmentState {
  readonly keys: ReadonlyArray<ManagementApiKeyRecord>;
  readonly isLoading: boolean;
  readonly error: string | null;
}

const EMPTY_ENVIRONMENT_STATE: ManagementApiKeyEnvironmentState = {
  keys: [],
  isLoading: false,
  error: null,
};

export function ManagementApiKeysSettings() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentOptions = buildManagementApiKeyEnvironmentOptions(
    environments,
    primaryEnvironmentId,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedManagementApiKeyEnvironmentId(
    environmentOptions,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    environmentOptions.find(({ environmentId }) => environmentId === effectiveEnvironmentId) ??
    null;
  const prepared = usePreparedConnection(effectiveEnvironmentId);
  const [stateByEnvironment, setStateByEnvironment] = useState<
    Readonly<Record<string, ManagementApiKeyEnvironmentState>>
  >({});
  const requestGeneration = useRef(new Map<string, number>());
  const selectedState =
    (effectiveEnvironmentId && stateByEnvironment[effectiveEnvironmentId]) ??
    EMPTY_ENVIRONMENT_STATE;
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [busyKey, setBusyKey] = useState<{
    readonly id: string;
    readonly kind: "rotate" | "revoke";
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [secretResult, setSecretResult] = useState<SecretRevealState | null>(null);
  const [createTarget, setCreateTarget] = useState<ManagementApiKeyTarget | null>(null);
  const mutationInFlightRef = useRef(false);
  const connectionGeneration = useRef(
    new Map<
      string,
      { readonly prepared: PreparedConnection | null; readonly generation: number }
    >(),
  );
  const activeEnvironmentId = useRef<EnvironmentId | null>(null);
  const nowMs = useRelativeTimeTick(60_000);

  const refreshKeys = useStableCallback(
    async (environmentId: EnvironmentId, environmentPrepared: PreparedConnection) => {
      const expectedConnection = connectionGeneration.current.get(environmentId);
      if (expectedConnection?.prepared !== environmentPrepared) return;
      const generation = (requestGeneration.current.get(environmentId) ?? 0) + 1;
      requestGeneration.current.set(environmentId, generation);
      const expectedConnectionGeneration = expectedConnection.generation;
      setStateByEnvironment((current) => ({
        ...current,
        [environmentId]: { ...EMPTY_ENVIRONMENT_STATE, isLoading: true },
      }));
      const isCurrentRequest = () => {
        const currentConnection = connectionGeneration.current.get(environmentId);
        return (
          requestGeneration.current.get(environmentId) === generation &&
          currentConnection?.prepared === environmentPrepared &&
          currentConnection.generation === expectedConnectionGeneration
        );
      };
      try {
        const keys = await listEnvironmentManagementApiKeys({ prepared: environmentPrepared });
        if (!isCurrentRequest()) return;
        setStateByEnvironment((current) => ({
          ...current,
          [environmentId]: { keys, isLoading: false, error: null },
        }));
      } catch (cause) {
        if (!isCurrentRequest()) return;
        setStateByEnvironment((current) => ({
          ...current,
          [environmentId]: { keys: [], isLoading: false, error: readErrorMessage(cause) },
        }));
      }
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh keys when the selected environment connection changes.
  useEffect(() => {
    const previousEnvironmentId = activeEnvironmentId.current;
    if (previousEnvironmentId !== null && previousEnvironmentId !== effectiveEnvironmentId) {
      requestGeneration.current.set(
        previousEnvironmentId,
        (requestGeneration.current.get(previousEnvironmentId) ?? 0) + 1,
      );
      const previousConnection = connectionGeneration.current.get(previousEnvironmentId);
      if (previousConnection !== undefined) {
        connectionGeneration.current.set(previousEnvironmentId, {
          prepared: null,
          generation: previousConnection.generation + 1,
        });
      }
    }
    activeEnvironmentId.current = effectiveEnvironmentId;
    if (effectiveEnvironmentId === null) return;
    const environmentPrepared = Option.isSome(prepared) ? prepared.value : null;
    const previousConnection = connectionGeneration.current.get(effectiveEnvironmentId);
    if (previousConnection?.prepared !== environmentPrepared) {
      connectionGeneration.current.set(effectiveEnvironmentId, {
        prepared: environmentPrepared,
        generation: (previousConnection?.generation ?? 0) + 1,
      });
    }
    // oxlint-disable-next-line react/set-state-in-effect -- Switching environment or connection resets its list before the fetch that the connection generation guards.
    setStateByEnvironment((current) => ({
      ...current,
      [effectiveEnvironmentId]: EMPTY_ENVIRONMENT_STATE,
    }));
    if (Option.isSome(prepared)) {
      void refreshKeys(effectiveEnvironmentId, prepared.value);
    } else {
      requestGeneration.current.set(
        effectiveEnvironmentId,
        (requestGeneration.current.get(effectiveEnvironmentId) ?? 0) + 1,
      );
    }
  }, [effectiveEnvironmentId, prepared, refreshKeys]);

  const selectedTarget: ManagementApiKeyTarget | null =
    selectedEnvironment !== null && Option.isSome(prepared)
      ? {
          environmentId: selectedEnvironment.environmentId,
          environmentLabel: selectedEnvironment.label,
          prepared: prepared.value,
        }
      : null;
  const canListSelectedEnvironment = selectedTarget !== null;
  const canMutateSelectedEnvironment = selectedTarget !== null;
  const mutationInFlight = isMutating || busyKey !== null;
  const selectEnvironment = (environmentId: EnvironmentId) => {
    setSelectedEnvironmentId(environmentId);
    requestGeneration.current.set(
      environmentId,
      (requestGeneration.current.get(environmentId) ?? 0) + 1,
    );
    setStateByEnvironment((current) => ({
      ...current,
      [environmentId]: EMPTY_ENVIRONMENT_STATE,
    }));
    setPendingAction(null);
    setBusyKey(null);
  };
  const openCreateDialog = () => {
    if (!canMutateSelectedEnvironment || selectedTarget === null || mutationInFlight) return;
    setCreateTarget(selectedTarget);
    setIsCreateDialogOpen(true);
  };
  const handleCreate = async (input: ManagementApiKeyCreateInput) => {
    const target = createTarget;
    if (target === null || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const environmentId = target.environmentId;
    setIsMutating(true);
    setStateByEnvironment((current) => ({
      ...current,
      [environmentId]: { ...(current[environmentId] ?? EMPTY_ENVIRONMENT_STATE), error: null },
    }));
    try {
      const result = await createEnvironmentManagementApiKey({
        prepared: target.prepared,
        payload: input,
      });
      setIsCreateDialogOpen(false);
      setCreateTarget(null);
      setSecretResult({
        ...revealManagementApiKey(result, "created"),
        environmentId: target.environmentId,
        environmentLabel: target.environmentLabel,
      });
      await refreshKeys(environmentId, target.prepared);
    } catch (cause) {
      setStateByEnvironment((current) => ({
        ...current,
        [environmentId]: {
          ...(current[environmentId] ?? EMPTY_ENVIRONMENT_STATE),
          isLoading: false,
          error: readErrorMessage(cause),
        },
      }));
    }
    mutationInFlightRef.current = false;
    setIsMutating(false);
  };

  const handlePendingAction = async () => {
    if (!pendingAction || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const action = pendingAction;
    const target = action.target;
    const environmentId = target.environmentId;
    setPendingAction(null);
    setBusyKey({ id: action.key.id, kind: action.kind });
    setStateByEnvironment((current) => ({
      ...current,
      [environmentId]: { ...(current[environmentId] ?? EMPTY_ENVIRONMENT_STATE), error: null },
    }));
    try {
      if (action.kind === "revoke") {
        await revokeEnvironmentManagementApiKey({
          prepared: target.prepared,
          id: action.key.id,
        });
      } else {
        const result = await rotateEnvironmentManagementApiKey({
          prepared: target.prepared,
          id: action.key.id,
        });
        setSecretResult({
          ...revealManagementApiKey(result, "rotated"),
          environmentId: target.environmentId,
          environmentLabel: target.environmentLabel,
        });
      }
      await refreshKeys(environmentId, target.prepared);
    } catch (cause) {
      setStateByEnvironment((current) => ({
        ...current,
        [environmentId]: {
          ...(current[environmentId] ?? EMPTY_ENVIRONMENT_STATE),
          isLoading: false,
          error: readErrorMessage(cause),
        },
      }));
    }
    mutationInFlightRef.current = false;
    setBusyKey(null);
  };

  return (
    <>
      <SettingsSection
        id="management-api-keys"
        title={gt("Management API keys")}
        icon={<KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />}
        headerAction={
          <Button
            size="sm"
            onClick={openCreateDialog}
            disabled={!canMutateSelectedEnvironment || mutationInFlight}
          >
            <PlusIcon aria-hidden />
            <T>Create key</T>
          </Button>
        }
      >
        <EnvironmentSettingsTabs
          environments={environmentOptions}
          selectedEnvironmentId={effectiveEnvironmentId}
          onSelect={selectEnvironment}
          disabled={mutationInFlight}
        />
        <SettingsRow
          title={gt("External {protocol} access", { protocol: "MCP" })}
          description={gt(
            "Create a separate credential for a third-party {protocol} client that cannot use a normal {product} connection. Each key belongs to this machine and only exposes the thread tools selected below.",
            { protocol: "MCP", product: "T3" },
          )}
        />
        {selectedState.error && !isCreateDialogOpen ? (
          <div
            className="mx-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive sm:mx-4"
            role="alert"
          >
            {selectedState.error}
          </div>
        ) : null}
        <div className="space-y-2 px-3 sm:px-4">
          {selectedEnvironment === null ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
              <T>No environments are available. Connect a machine before managing its API keys.</T>
            </div>
          ) : Option.isNone(prepared) ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
              <T>
                <Var>{selectedEnvironment.label}</Var> is currently unavailable. Reconnect to this
                machine to manage its API keys.
              </T>
            </div>
          ) : selectedState.isLoading ? (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Spinner />
              <T>
                Loading management API keys for <Var>{selectedEnvironment.label}</Var>…
              </T>
            </div>
          ) : selectedState.keys.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
              <T>
                No management API keys yet. Create one when an external <Var>MCP</Var> client needs
                access to this environment.
              </T>
            </div>
          ) : (
            selectedState.keys.map((keyRecord) => (
              <KeyRow
                key={keyRecord.id}
                keyRecord={keyRecord}
                nowMs={nowMs}
                canMutate={canMutateSelectedEnvironment && !mutationInFlight}
                busyAction={busyKey?.id === keyRecord.id ? busyKey.kind : null}
                onRotate={() => {
                  if (selectedTarget) {
                    setPendingAction({ kind: "rotate", key: keyRecord, target: selectedTarget });
                  }
                }}
                onRevoke={() => {
                  if (selectedTarget) {
                    setPendingAction({ kind: "revoke", key: keyRecord, target: selectedTarget });
                  }
                }}
              />
            ))
          )}
        </div>
        <div className="flex justify-end px-3 pt-1 sm:px-4">
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              if (selectedTarget !== null && canListSelectedEnvironment) {
                void refreshKeys(selectedTarget.environmentId, selectedTarget.prepared);
              }
            }}
            disabled={!canListSelectedEnvironment || selectedState.isLoading || mutationInFlight}
          >
            <RefreshCwIcon className={cn(selectedState.isLoading && "animate-spin")} aria-hidden />
            <T>Refresh</T>
          </Button>
        </div>
      </SettingsSection>

      <CreateManagementApiKeyDialog
        open={isCreateDialogOpen}
        environmentLabel={
          createTarget?.environmentLabel ??
          selectedEnvironment?.label ??
          gt("the selected environment")
        }
        isSubmitting={mutationInFlight}
        error={
          isCreateDialogOpen && createTarget !== null
            ? (stateByEnvironment[createTarget.environmentId]?.error ?? null)
            : null
        }
        onOpenChange={(open) => {
          if (!open && isMutating) return;
          setIsCreateDialogOpen(open);
          if (!open && !isMutating) setCreateTarget(null);
          if (open && selectedTarget !== null) {
            setCreateTarget(selectedTarget);
            setStateByEnvironment((current) => ({
              ...current,
              [selectedTarget.environmentId]: {
                ...(current[selectedTarget.environmentId] ?? EMPTY_ENVIRONMENT_STATE),
                error: null,
              },
            }));
          }
        }}
        onSubmit={(input) => void handleCreate(input)}
      />

      {secretResult ? (
        <SecretRevealDialog
          result={secretResult}
          onClose={() => setSecretResult(clearManagementApiKeyReveal())}
        />
      ) : null}

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !busyKey) setPendingAction(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === "rotate" ? (
                <T>
                  Rotate this management API key on{" "}
                  <Var>{pendingAction.target.environmentLabel}</Var>?
                </T>
              ) : (
                <T>
                  Revoke this management API key on{" "}
                  <Var>{pendingAction?.target.environmentLabel ?? gt("this environment")}</Var>?
                </T>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "rotate" ? (
                <T>
                  The current secret for “<Var>{pendingAction.key.name}</Var>” will stop working
                  immediately. You will need to copy the replacement secret once.
                </T>
              ) : (
                <T>
                  All clients using “<Var>{pendingAction?.key.name ?? gt("this key")}</Var>” will
                  lose access immediately. This cannot be undone.
                </T>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant={pendingAction?.kind === "rotate" ? "default" : "destructive"}
              disabled={mutationInFlight}
              onClick={() => void handlePendingAction()}
            >
              {pendingAction?.kind === "rotate" ? <T>Rotate key</T> : <T>Revoke key</T>}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
