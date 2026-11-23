import * as Schema from "effect/Schema";
import { useId, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  desktopSharedRuntimeAtom,
  sharedRuntimeErrorMessage,
} from "../../state/desktopSharedRuntime";
import { useEnvironmentQuery } from "../../state/query";
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
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Fork-only (gateway self-service): join or leave shared T3 Code; both relaunch the app.

const PROMPT_DISMISSED_KEY = "t3code:shared-runtime-prompt-dismissed:v1";

function useSharedRuntimeState() {
  return useEnvironmentQuery(window.desktopBridge ? desktopSharedRuntimeAtom : null).data;
}

function SharedRuntimeDialog({
  mode,
  open,
  needsPassword,
  cancelLabel,
  onCancel,
  onConfirm,
}: {
  readonly mode: "join" | "leave";
  readonly open: boolean;
  readonly needsPassword: boolean;
  readonly cancelLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm?: () => void;
}) {
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = mode === "join";
  const askPassword = join && needsPassword;

  const confirm = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    onConfirm?.();
    setPending(true);
    setError(null);
    // Success relaunches the app, so only a failure comes back here.
    await (
      join
        ? bridge.joinSharedRuntime(askPassword ? password : undefined)
        : bridge.leaveSharedRuntime()
    ).catch((cause: unknown) => {
      setError(sharedRuntimeErrorMessage(cause));
      setPending(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending || next) return;
        setPassword("");
        setError(null);
        onCancel();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{join ? "Use shared T3 Code?" : "Leave shared T3 Code?"}</DialogTitle>
          <DialogDescription>
            {join
              ? "This computer runs T3 Code for everyone who uses it. This app will use your own server there instead of starting one, and it keeps running when the app is closed. Your projects and history stay. T3 Code will restart."
              : "Your projects and history stay. T3 Code will restart with its own server."}
          </DialogDescription>
        </DialogHeader>
        {askPassword || error ? (
          <DialogPanel>
            {askPassword ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor={passwordId}>Your Windows password</Label>
                <Input
                  id={passwordId}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={pending}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Windows needs it once to set up your server. T3 Code doesn't store it.
                </p>
              </div>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            disabled={pending || (askPassword && password.length === 0)}
            onClick={() => void confirm()}
          >
            {pending ? (
              <>
                <Spinner size="sm" />
                Restarting…
              </>
            ) : join ? (
              "Restart and join"
            ) : (
              "Restart and leave"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SharedRuntimeSetting() {
  const state = useSharedRuntimeState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, setPromptDismissed] = useLocalStorage(PROMPT_DISMISSED_KEY, false, Schema.Boolean);
  if (!state) return null;
  const mode = state.enrolled ? "leave" : "join";
  const status = state.attached ? "In use" : state.enrolled ? "Joined" : "Not joined";

  return (
    <>
      <SettingsRow
        {...searchableSetting("shared-runtime")}
        description={
          state.selfService
            ? `${status} · version ${state.runtimeVersion}`
            : `${status} · version ${state.runtimeVersion}. Ask an administrator to change this.`
        }
        control={
          state.selfService ? (
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              {state.enrolled ? "Leave" : "Join"}
            </Button>
          ) : undefined
        }
      />
      <SharedRuntimeDialog
        mode={mode}
        open={dialogOpen}
        needsPassword={state.joinNeedsPassword}
        cancelLabel="Cancel"
        onCancel={() => setDialogOpen(false)}
        // Leaving is an answer: the relaunched app should not offer joining again.
        {...(mode === "leave" ? { onConfirm: () => setPromptDismissed(true) } : {})}
      />
    </>
  );
}

/** Offers joining once per device when this computer has shared T3 Code and the account is not in it. */
export function SharedRuntimeJoinPrompt() {
  const state = useSharedRuntimeState();
  const [dismissed, setDismissed] = useLocalStorage(PROMPT_DISMISSED_KEY, false, Schema.Boolean);
  const offered =
    state !== null &&
    state.selfService &&
    !state.enrolled &&
    !dismissed &&
    !isLocalEnvironmentDisabled();
  if (!offered) return null;
  return (
    <SharedRuntimeDialog
      mode="join"
      open
      needsPassword={state.joinNeedsPassword}
      cancelLabel="Not now"
      onCancel={() => setDismissed(true)}
    />
  );
}
