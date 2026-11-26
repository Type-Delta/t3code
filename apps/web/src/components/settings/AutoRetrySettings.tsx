import { PlusIcon, Trash2Icon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  conditionIsComplete,
  createAutoRetryTrigger,
  normalizeAutoRetrySettings,
  predicate,
  updateCondition,
  type AutoRetryCondition,
  type AutoRetryPredicateKind,
  type AutoRetrySettings as AutoRetryValue,
  type AutoRetryTrigger,
  type ConditionPath,
} from "./AutoRetrySettings.logic";
import { providerClients } from "./providerDriverMeta";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const NODE_LABELS = {
  error_message: msg("Error message contains"),
  backend: msg("Backend is"),
  model: msg("Model contains"),
  and: msg("All of"),
  or: msg("Any of"),
  not: msg("Not"),
} satisfies Record<AutoRetryCondition["kind"], string>;
type NodeKind = keyof typeof NODE_LABELS;

function convertNode(node: AutoRetryCondition, kind: NodeKind): AutoRetryCondition {
  if (kind === node.kind) return node;
  if (kind === "not") return { kind, child: node };
  if (kind === "and" || kind === "or") {
    return "children" in node ? { kind, children: node.children } : { kind, children: [node] };
  }
  return { kind, value: "value" in node ? node.value : "" };
}

export function AutoRetrySettings() {
  const saved = normalizeAutoRetrySettings(
    useScopedSettings((settings) => (settings as { readonly autoRetry?: unknown }).autoRetry),
  );
  const gt = useGT();
  const updateSettings = useUpdateScopedSettings();
  const save = (next: AutoRetryValue) => updateSettings({ autoRetry: next });
  const saveTrigger = (id: string, update: (trigger: AutoRetryTrigger) => AutoRetryTrigger) =>
    save({
      ...saved,
      triggers: saved.triggers.map((trigger) => (trigger.id === id ? update(trigger) : trigger)),
    });

  return (
    <SettingsSection id="auto-retry" title={gt("Auto retry")}>
      <SettingsRow
        serverScoped
        settingKeys={["autoRetry"]}
        id="auto-retry-setting"
        title={gt("Auto retry")}
        description={gt("Send a follow-up message when a failed turn matches a trigger.")}
        control={
          <ScopedSwitch
            settingKeys={["autoRetry"]}
            checked={saved.enabled}
            onCheckedChange={(enabled) => save({ ...saved, enabled })}
            aria-label={gt("Auto retry")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["autoRetry"]}
        title={gt("Triggers")}
        description={gt("Triggers run in order. The first enabled match sends its message.")}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              save({
                ...saved,
                triggers: [...saved.triggers, createAutoRetryTrigger(saved.triggers.length + 1)],
              })
            }
          >
            <PlusIcon />
            <T>Add trigger</T>
          </Button>
        }
      >
        {saved.triggers.length > 0 ? (
          <div className="space-y-3 pb-3.5">
            {saved.triggers.map((trigger) => (
              <TriggerEditor
                key={trigger.id}
                trigger={trigger}
                onChange={(update) => saveTrigger(trigger.id, update)}
                onRemove={() =>
                  save({
                    ...saved,
                    triggers: saved.triggers.filter((candidate) => candidate.id !== trigger.id),
                  })
                }
              />
            ))}
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function TriggerEditor({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: AutoRetryTrigger;
  onChange: (update: (trigger: AutoRetryTrigger) => AutoRetryTrigger) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const label = trigger.name.trim() || gt("Untitled trigger");
  return (
    <fieldset
      aria-label={gt("Trigger {name}", { name: label })}
      className="space-y-3 rounded-lg border border-border/60 p-3"
    >
      <div className="flex items-center gap-2">
        <Switch
          checked={trigger.enabled}
          onCheckedChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
          aria-label={gt("Enable {name}", { name: label })}
        />
        <CommitInput
          value={trigger.name}
          aria-label={gt("Trigger name")}
          placeholder={gt("Trigger name")}
          onCommit={(name) => onChange((current) => ({ ...current, name }))}
        />
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          aria-label={gt("Remove {name}", { name: label })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <ConditionEditor
        node={trigger.condition}
        path={[]}
        onChange={(path, update) =>
          onChange((current) => ({
            ...current,
            condition: updateCondition(current.condition, path, update),
          }))
        }
      />
      {!conditionIsComplete(trigger.condition) ? (
        <p className="text-xs text-warning">
          <T>Fill every condition value before this trigger can match.</T>
        </p>
      ) : null}
      <CommitTextarea
        value={trigger.message}
        aria-label={gt("Retry message for {name}", { name: label })}
        placeholder={gt("Message to send when this trigger matches")}
        onCommit={(message) => onChange((current) => ({ ...current, message }))}
      />
    </fieldset>
  );
}

function ConditionEditor({
  node,
  path,
  onChange,
}: {
  node: AutoRetryCondition;
  path: ConditionPath;
  onChange: (
    path: ConditionPath,
    update: (node: AutoRetryCondition) => AutoRetryCondition | null,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const depth = path.length;
  return (
    <div className="space-y-2" data-condition-depth={depth}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={node.kind}
          onValueChange={(kind) => {
            if (kind && kind in NODE_LABELS)
              onChange(path, (current) => convertNode(current, kind as NodeKind));
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-44"
            aria-label={gt("Condition type at level {level}", { level: depth + 1 })}
          >
            <SelectValue>{(kind: NodeKind) => m(NODE_LABELS[kind])}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(NODE_LABELS).map(([kind, label]) => (
              <SelectItem key={kind} value={kind}>
                {m(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {"value" in node ? (
          <PredicateValue
            kind={node.kind}
            value={node.value}
            onCommit={(value) => onChange(path, () => ({ kind: node.kind, value }))}
          />
        ) : null}
        {depth > 0 ? (
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={gt("Remove condition")}
            onClick={() => onChange(path, () => null)}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>
      {node.kind === "not" ? (
        <div className="border-l border-border pl-3">
          <ConditionEditor node={node.child} path={[...path, 0]} onChange={onChange} />
        </div>
      ) : null}
      {"children" in node ? (
        <div className="space-y-2 border-l border-border pl-3">
          {node.children.map((child, index) => (
            <ConditionEditor
              key={[...path, index].join(".")}
              node={child}
              path={[...path, index]}
              onChange={onChange}
            />
          ))}
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onChange(path, (current) =>
                "children" in current
                  ? { ...current, children: [...current.children, predicate()] }
                  : current,
              )
            }
          >
            <PlusIcon />
            <T>Add condition</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PredicateValue({
  kind,
  value,
  onCommit,
}: {
  kind: AutoRetryPredicateKind;
  value: string;
  onCommit: (value: string) => void;
}) {
  const gt = useGT();
  if (kind === "backend") {
    const known = providerClients.definitions.some((definition) => definition.driverKind === value);
    return (
      <Select value={value || null} onValueChange={(next) => next && onCommit(String(next))}>
        <SelectTrigger size="sm" className="w-44" aria-label={gt("Backend type")}>
          <SelectValue placeholder={gt("Choose backend")} />
        </SelectTrigger>
        <SelectPopup>
          {!known && value ? <SelectItem value={value}>{value}</SelectItem> : null}
          {providerClients.definitions.map((definition) => (
            <SelectItem key={definition.driverKind} value={definition.driverKind}>
              {definition.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  return (
    <CommitInput
      value={value}
      aria-label={kind === "model" ? gt("Model substring") : gt("Error message substring")}
      placeholder={kind === "model" ? "gpt-5" : "overloaded"}
      onCommit={onCommit}
    />
  );
}

function CommitInput({
  value,
  onCommit,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "defaultValue" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  if (base !== value) {
    setBase(value);
    setDraft(value);
  }
  return (
    <Input
      {...props}
      size="sm"
      className="min-w-40 flex-1"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
    />
  );
}

function CommitTextarea({
  value,
  onCommit,
  ...props
}: Omit<React.ComponentProps<typeof Textarea>, "value" | "defaultValue" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  if (base !== value) {
    setBase(value);
    setDraft(value);
  }
  return (
    <Textarea
      {...props}
      size="sm"
      rows={2}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}
