import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LinkedDeviceHostConfig, PeerLinkSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { peerLinkListsAtom } from "../../state/peerLinks";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

interface Holder {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly hosts: ReadonlyArray<LinkedDeviceHostConfig>;
}

interface Choice {
  readonly key: string;
  readonly holder: Holder;
  readonly link: PeerLinkSummary;
  /** Why the link cannot lend its devices here, when it cannot. */
  readonly unavailable: string | undefined;
}

/** Picks a link one of `holders` has made, whose machine then lends its devices there. */
export function LinkedDeviceHostEditor(props: {
  readonly holders: ReadonlyArray<Holder>;
  readonly busy: boolean;
  readonly onSave: (environmentId: EnvironmentId, host: LinkedDeviceHostConfig) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const lists = useAtomValue(
    peerLinkListsAtom(environmentIdsKey(props.holders.map((holder) => holder.environmentId))),
  );
  const loading = lists.some((result) => AsyncResult.isInitial(result));
  const failed = lists.some((result) => AsyncResult.isFailure(result));
  const several = props.holders.length > 1;
  const choices: ReadonlyArray<Choice> = props.holders.flatMap((holder, index) => {
    const result = lists[index];
    const links = result ? Option.getOrUndefined(AsyncResult.value(result))?.links : undefined;
    return (links ?? []).map((link) => ({
      key: `${holder.environmentId}\n${link.environmentId}`,
      holder,
      link,
      unavailable: holder.hosts.some((host) => host.environmentId === link.environmentId)
        ? gt("Already added")
        : link.access !== "full-access"
          ? gt("Needs a full-access link")
          : link.status === "expired"
            ? gt("Link expired")
            : undefined,
    }));
  });
  const [selected, setSelected] = useState<string | null>(
    () => choices.find((choice) => choice.unavailable === undefined)?.key ?? null,
  );
  const choice =
    choices.find((candidate) => candidate.key === selected) ??
    choices.find((candidate) => candidate.unavailable === undefined);
  const nameOf = (entry: Choice) =>
    several ? `${entry.link.label} · ${entry.holder.label}` : entry.link.label;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!props.busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!choice || choice.unavailable !== undefined || props.busy) return;
            props.onSave(choice.holder.environmentId, {
              kind: "linked",
              id: randomUUID(),
              label: choice.link.label,
              environmentId: choice.link.environmentId,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{gt("Add linked environment")}</DialogTitle>
            <DialogDescription>
              <T>
                Use the simulators and emulators of a machine this environment links to, over that
                link. Agents and the Device panel drive them as if they were here. Only a
                full-access link can lend its devices, since apps installed there run as its user.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size="xs" />
                <T>Loading linked environments…</T>
              </p>
            ) : choices.length === 0 && failed ? (
              <p className="text-sm text-destructive-foreground">
                {gt("Could not load linked environments")}
              </p>
            ) : choices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <T>
                  No linked environments yet. Link one in Settings → Linked environments, with full
                  access.
                </T>
              </p>
            ) : (
              <label className="block space-y-1.5 text-sm">
                <span>
                  <T>Linked environment</T>
                </span>
                <Select
                  value={choice?.key ?? null}
                  onValueChange={(key) => setSelected(key)}
                  disabled={props.busy}
                >
                  <SelectTrigger aria-label={gt("Linked environment")}>
                    <SelectValue>
                      {(key: string | null) => {
                        const entry = choices.find((candidate) => candidate.key === key);
                        return entry ? nameOf(entry) : gt("Choose a linked environment");
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {choices.map((entry) => (
                      <SelectItem
                        key={entry.key}
                        value={entry.key}
                        disabled={entry.unavailable !== undefined}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{nameOf(entry)}</span>
                          {entry.unavailable ? (
                            <span className="text-xs text-muted-foreground">
                              {entry.unavailable}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button
              type="submit"
              disabled={props.busy || !choice || choice.unavailable !== undefined}
            >
              {props.busy ? <Spinner size="xs" /> : null}
              <T>Add</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
