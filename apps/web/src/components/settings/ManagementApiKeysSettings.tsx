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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  createManagementApiKey,
  listManagementApiKeys,
  ManagementApiKeyRequestError,
  revokeManagementApiKey,
  rotateManagementApiKey,
  type ManagementApiKeyCreateResult,
  type ManagementApiKeyRecord,
  type ManagementApiKeySafeRuntimeMode,
} from "~/environments/primary";
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
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import {
  buildManagementApiKeyCodexExample,
  buildManagementApiKeyJsonExample,
  canRotateManagementApiKey,
  clampManagementApiKeyDefaultRuntimeMode,
  clearManagementApiKeyReveal,
  MANAGEMENT_API_KEY_PRESETS,
  MANAGEMENT_API_KEY_RUNTIME_MODES,
  MANAGEMENT_API_KEY_SCOPE_DETAILS,
  managementApiKeyRuntimeModeLabel,
  managementApiKeyScopeSummary,
  resolveManagementApiKeyExpiration,
  revealManagementApiKey,
  scopesForManagementApiKeyPreset,
  type ManagementApiKeyExpiration,
  type ManagementApiKeyPreset,
  type ManagementApiKeyRevealState,
  type ManagementApiKeyScope,
} from "./ManagementApiKeysSettings.logic";

const DEFAULT_EXPIRATION: ManagementApiKeyExpiration = "90-days";
const DEFAULT_PRESET: ManagementApiKeyPreset = "read-only";
const DEFAULT_RUNTIME_MODE: ManagementApiKeySafeRuntimeMode = "approval-required";
const DEFAULT_MAXIMUM_RUNTIME_MODE: ManagementApiKeySafeRuntimeMode = "auto-accept-edits";

type SecretRevealState = NonNullable<ManagementApiKeyRevealState<ManagementApiKeyCreateResult>>;

const EXPIRATION_OPTIONS: ReadonlyArray<{
  readonly value: ManagementApiKeyExpiration;
  readonly label: string;
}> = [
  { value: "30-days", label: "30 days" },
  { value: "90-days", label: "90 days" },
  { value: "1-year", label: "1 year" },
  { value: "never", label: "Never" },
];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function formatLastUsed(value: string | null, nowMs: number): string {
  if (value === null) return "Not used yet";
  const elapsed = formatElapsedDurationLabel(value, nowMs);
  return `Used ${elapsed}${elapsed === "just now" ? "" : " ago"}`;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ManagementApiKeyRequestError) {
    if (error.status === 401 || error.status === 403) {
      return "You need access-management permission to manage API keys.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Could not update management API keys.";
}

function keyExpiryState(
  key: ManagementApiKeyRecord,
  nowMs: number,
): {
  readonly label: string;
  readonly tone: "default" | "warning" | "error";
} {
  if (key.expiresAt === null) return { label: "Never expires", tone: "default" };
  const label = formatExpiresInLabel(key.expiresAt, nowMs);
  if (label === "Expired") return { label, tone: "error" };
  const expiresAt = new Date(key.expiresAt).getTime();
  return {
    label,
    tone: expiresAt - nowMs <= 7 * 24 * 60 * 60 * 1_000 ? "warning" : "default",
  };
}

function KeyRow({
  keyRecord,
  nowMs,
  busyAction,
  onRotate,
  onRevoke,
}: {
  readonly keyRecord: ManagementApiKeyRecord;
  readonly nowMs: number;
  readonly busyAction: "rotate" | "revoke" | null;
  readonly onRotate: () => void;
  readonly onRevoke: () => void;
}) {
  const expiry = keyExpiryState(keyRecord, nowMs);
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
              disabled={isBusy}
              onClick={onRotate}
              aria-label={`Rotate ${keyRecord.name}`}
            >
              <RotateCwIcon aria-hidden />
              {busyAction === "rotate" ? "Rotating…" : "Rotate"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={isBusy}
            onClick={onRevoke}
            aria-label={`Revoke ${keyRecord.name}`}
          >
            <Trash2Icon aria-hidden />
            {busyAction === "revoke" ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
      <div className="mt-3 grid min-w-0 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div className="min-w-0">
          <span className="block text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Access
          </span>
          <span className="break-words text-foreground/85">
            {managementApiKeyScopeSummary(keyRecord.scopes)}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Permission ceiling
          </span>
          <span className="break-words text-foreground/85">
            {managementApiKeyRuntimeModeLabel(keyRecord.maximumRuntimeMode)}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Activity
          </span>
          <span className="break-words text-foreground/85">
            Created {formatDate(keyRecord.createdAt)}
            {` · ${formatLastUsed(keyRecord.lastUsedAt, nowMs)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

function CreateManagementApiKeyDialog({
  open,
  isSubmitting,
  error,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly isSubmitting: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly scopes: ReadonlyArray<ManagementApiKeyScope>;
    readonly defaultRuntimeMode: ManagementApiKeySafeRuntimeMode;
    readonly maximumRuntimeMode: ManagementApiKeySafeRuntimeMode;
    readonly expiresAt: string | null;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState<ManagementApiKeyExpiration>(DEFAULT_EXPIRATION);
  const [preset, setPreset] = useState<ManagementApiKeyPreset>(DEFAULT_PRESET);
  const [customScopes, setCustomScopes] = useState<ReadonlyArray<ManagementApiKeyScope>>(
    scopesForManagementApiKeyPreset(DEFAULT_PRESET),
  );
  const [defaultRuntimeMode, setDefaultRuntimeMode] =
    useState<ManagementApiKeySafeRuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [maximumRuntimeMode, setMaximumRuntimeMode] = useState<ManagementApiKeySafeRuntimeMode>(
    DEFAULT_MAXIMUM_RUNTIME_MODE,
  );

  useEffect(() => {
    if (!open) return;
    setName("");
    setExpiration(DEFAULT_EXPIRATION);
    setPreset(DEFAULT_PRESET);
    setCustomScopes(scopesForManagementApiKeyPreset(DEFAULT_PRESET));
    setDefaultRuntimeMode(DEFAULT_RUNTIME_MODE);
    setMaximumRuntimeMode(DEFAULT_MAXIMUM_RUNTIME_MODE);
  }, [open]);

  const selectedScopes = scopesForManagementApiKeyPreset(preset, customScopes);
  const allowedDefaultModes = MANAGEMENT_API_KEY_RUNTIME_MODES.filter(
    (mode) =>
      mode.rank <=
      MANAGEMENT_API_KEY_RUNTIME_MODES.find((candidate) => candidate.value === maximumRuntimeMode)!
        .rank,
  );

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
      defaultRuntimeMode,
      maximumRuntimeMode,
      expiresAt: resolveManagementApiKeyExpiration(expiration),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create management API key</DialogTitle>
          <DialogDescription>
            Create a durable credential for an external MCP client. The full secret is shown once.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogPanel className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="management-api-key-name">Name</Label>
              <Input
                id="management-api-key-name"
                value={name}
                onValueChange={setName}
                placeholder="My MCP client"
                autoFocus
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="management-api-key-expiration">Expiration</Label>
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
                      {EXPIRATION_OPTIONS.find((option) => option.value === expiration)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {EXPIRATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="management-api-key-preset">Access preset</Label>
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
                    <SelectValue>
                      {MANAGEMENT_API_KEY_PRESETS.find((option) => option.value === preset)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {MANAGEMENT_API_KEY_PRESETS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex flex-col gap-0.5">
                          <span>{option.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {option.description}
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
                <legend className="text-sm font-medium text-foreground">Custom scopes</legend>
                <div className="grid gap-1 rounded-lg border border-border/60 p-2 sm:grid-cols-2">
                  {MANAGEMENT_API_KEY_SCOPE_DETAILS.map((detail) => (
                    <label
                      key={detail.scope}
                      className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={customScopes.includes(detail.scope)}
                        onCheckedChange={(checked) => toggleScope(detail.scope, Boolean(checked))}
                        aria-label={detail.label}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{detail.label}</span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          {detail.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {selectedScopes.length === 0 ? (
                  <p className="text-xs text-destructive">Choose at least one scope.</p>
                ) : null}
              </fieldset>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="management-api-key-default-mode">Default permission mode</Label>
                <Select
                  value={defaultRuntimeMode}
                  onValueChange={(value) => {
                    if (!value) return;
                    const next = value as ManagementApiKeySafeRuntimeMode;
                    setDefaultRuntimeMode(next);
                    if (!isRuntimeModeWithinOptions(next, maximumRuntimeMode)) {
                      setMaximumRuntimeMode(next);
                    }
                  }}
                >
                  <SelectTrigger id="management-api-key-default-mode" className="w-full">
                    <SelectValue>
                      {managementApiKeyRuntimeModeLabel(defaultRuntimeMode)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {allowedDefaultModes.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        <span className="flex flex-col gap-0.5">
                          <span>{mode.label}</span>
                          <span className="text-xs text-muted-foreground">{mode.description}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="management-api-key-maximum-mode">Maximum permission mode</Label>
                <Select
                  value={maximumRuntimeMode}
                  onValueChange={(value) => {
                    if (!value) return;
                    const next = value as ManagementApiKeySafeRuntimeMode;
                    setMaximumRuntimeMode(next);
                    setDefaultRuntimeMode(
                      clampManagementApiKeyDefaultRuntimeMode(defaultRuntimeMode, next),
                    );
                  }}
                >
                  <SelectTrigger id="management-api-key-maximum-mode" className="w-full">
                    <SelectValue>
                      {managementApiKeyRuntimeModeLabel(maximumRuntimeMode)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {MANAGEMENT_API_KEY_RUNTIME_MODES.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        <span className="flex flex-col gap-0.5">
                          <span>{mode.label}</span>
                          <span className="text-xs text-muted-foreground">{mode.description}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Permission modes apply when this key creates a thread and cap messages sent to
              existing threads. Full access is intentionally unavailable for management keys.
            </p>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !name.trim() || selectedScopes.length === 0}
            >
              {isSubmitting ? <Spinner /> : <PlusIcon aria-hidden />}
              {isSubmitting ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function isRuntimeModeWithinOptions(
  defaultRuntimeMode: ManagementApiKeySafeRuntimeMode,
  maximumRuntimeMode: ManagementApiKeySafeRuntimeMode,
): boolean {
  const defaultMode = MANAGEMENT_API_KEY_RUNTIME_MODES.find(
    (mode) => mode.value === defaultRuntimeMode,
  );
  const maximumMode = MANAGEMENT_API_KEY_RUNTIME_MODES.find(
    (mode) => mode.value === maximumRuntimeMode,
  );
  return (
    defaultMode !== undefined && maximumMode !== undefined && defaultMode.rank <= maximumMode.rank
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
    target: "management API key",
  });
  const jsonExample = useMemo(
    () => buildManagementApiKeyJsonExample(result.mcpEndpoint),
    [result.mcpEndpoint],
  );
  const codexExample = useMemo(
    () => buildManagementApiKeyCodexExample(result.mcpEndpoint),
    [result.mcpEndpoint],
  );

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
            {result.operation === "created"
              ? "Management API key created"
              : "Management API key rotated"}
          </DialogTitle>
          <DialogDescription>
            Copy this secret now. It will not be shown again, and closing this dialog clears it from
            the page.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm text-warning-foreground">
            <div className="flex items-start gap-2">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>
                Anyone with this secret can use the scopes granted to “{result.key.name}”. Store it
                in a password manager or environment variable.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="management-api-key-secret">One-time secret</Label>
            <Textarea
              id="management-api-key-secret"
              readOnly
              value={result.secret}
              rows={3}
              className="break-all font-mono text-xs leading-relaxed"
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyToClipboard(result.secret, { value: result.secret })}
            >
              {isCopied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
              {isCopied ? "Copied" : "Copy secret"}
            </Button>
          </div>
          <div className="space-y-2">
            <Label>MCP endpoint</Label>
            <code className="block max-w-full break-all rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-foreground">
              {result.mcpEndpoint}
            </code>
          </div>
          <div className="space-y-2">
            <Label>Generic JSON HTTP MCP</Label>
            <Textarea
              readOnly
              value={jsonExample}
              rows={10}
              className="font-mono text-xs leading-relaxed"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
          <div className="space-y-2">
            <Label>Codex</Label>
            <Textarea
              readOnly
              value={codexExample}
              rows={4}
              className="font-mono text-xs leading-relaxed"
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Set <code>T3_MANAGEMENT_API_KEY</code> in the environment where Codex runs before
              starting it.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Done — clear secret
          </Button>
          <Button onClick={() => copyToClipboard(result.secret, { value: result.secret })}>
            {isCopied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
            {isCopied ? "Copied" : "Copy secret"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type PendingAction =
  | { readonly kind: "rotate"; readonly key: ManagementApiKeyRecord }
  | { readonly kind: "revoke"; readonly key: ManagementApiKeyRecord }
  | null;

export function ManagementApiKeysSettings() {
  const [keys, setKeys] = useState<ReadonlyArray<ManagementApiKeyRecord>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [busyKey, setBusyKey] = useState<{
    readonly id: string;
    readonly kind: "rotate" | "revoke";
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [secretResult, setSecretResult] = useState<SecretRevealState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowMs = useRelativeTimeTick(60_000);

  const refreshKeys = useCallback(async () => {
    setIsLoading(true);
    try {
      setKeys(await listManagementApiKeys());
      setError(null);
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  const handleCreate = async (input: Parameters<typeof createManagementApiKey>[0]) => {
    setIsMutating(true);
    setError(null);
    try {
      const result = await createManagementApiKey(input);
      setIsCreateDialogOpen(false);
      setSecretResult(revealManagementApiKey(result, "created"));
      await refreshKeys();
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setIsMutating(false);
    }
  };

  const handlePendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    setBusyKey({ id: action.key.id, kind: action.kind });
    setError(null);
    try {
      if (action.kind === "revoke") {
        await revokeManagementApiKey(action.key.id);
      } else {
        const result = await rotateManagementApiKey(action.key.id);
        setSecretResult(revealManagementApiKey(result, "rotated"));
      }
      await refreshKeys();
    } catch (cause) {
      setError(readErrorMessage(cause));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <SettingsSection
        id="management-api-keys"
        title="Management API keys"
        icon={<KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden />}
        headerAction={
          <Button size="sm" onClick={() => setIsCreateDialogOpen(true)}>
            <PlusIcon aria-hidden />
            Create key
          </Button>
        }
      >
        <SettingsRow
          title="External MCP access"
          description="Durable environment-wide credentials for MCP clients. Keys only expose the thread tools selected below; they never grant project administration, terminal, filesystem, preview, or settings access."
        />
        {error && !isCreateDialogOpen ? (
          <div
            className="mx-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive sm:mx-4"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <div className="space-y-2 px-3 sm:px-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Spinner /> Loading management API keys…
            </div>
          ) : keys.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
              No management API keys yet. Create one when an external MCP client needs access to
              this environment.
            </div>
          ) : (
            keys.map((keyRecord) => (
              <KeyRow
                key={keyRecord.id}
                keyRecord={keyRecord}
                nowMs={nowMs}
                busyAction={busyKey?.id === keyRecord.id ? busyKey.kind : null}
                onRotate={() => setPendingAction({ kind: "rotate", key: keyRecord })}
                onRevoke={() => setPendingAction({ kind: "revoke", key: keyRecord })}
              />
            ))
          )}
        </div>
        <div className="flex justify-end px-3 pt-1 sm:px-4">
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void refreshKeys()}
            disabled={isLoading}
          >
            <RefreshCwIcon className={cn(isLoading && "animate-spin")} aria-hidden />
            Refresh
          </Button>
        </div>
      </SettingsSection>

      <CreateManagementApiKeyDialog
        open={isCreateDialogOpen}
        isSubmitting={isMutating}
        error={isCreateDialogOpen ? error : null}
        onOpenChange={(open) => {
          setIsCreateDialogOpen(open);
          if (open) setError(null);
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
              {pendingAction?.kind === "rotate"
                ? "Rotate this management API key?"
                : "Revoke this management API key?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "rotate"
                ? `The current secret for “${pendingAction.key.name}” will stop working immediately. You will need to copy the replacement secret once.`
                : `All clients using “${pendingAction?.key.name ?? "this key"}” will lose access immediately. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={pendingAction?.kind === "rotate" ? "default" : "destructive"}
              disabled={busyKey !== null}
              onClick={() => void handlePendingAction()}
            >
              {pendingAction?.kind === "rotate" ? "Rotate key" : "Revoke key"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
