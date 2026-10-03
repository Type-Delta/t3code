import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerSettings } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

type McpToolScope = "global" | "project";
type ScopeChoice = McpToolScope | "automatic";

function defaultScopeForProject(repositoryIdentity: unknown): McpToolScope {
  return repositoryIdentity == null ? "global" : "project";
}

function projectScopeOverride(
  settings: ServerSettings,
  projectId: SidebarProjectGroupMember["id"],
): ScopeChoice {
  return settings.projectSettingsOverrides[projectId]?.mcpToolScope ?? "automatic";
}

function scopeLabel(value: McpToolScope): string {
  return value === "project" ? "Project" : "Global";
}

/** This setting has a repository-dependent default, so it is written directly to each project override. */
export function ProjectMcpToolScopeSettings({
  members,
}: {
  members: readonly SidebarProjectGroupMember[];
}) {
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "MCP tool scope update");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const rows = useMemo(
    () =>
      members.flatMap((member) => {
        const environment = environmentById.get(member.environmentId);
        const settings = environment?.serverConfig?.settings;
        return settings === undefined ? [] : [{ member, environment, settings }];
      }),
    [environmentById, members],
  );
  const choices = rows.map(({ member, settings }) => projectScopeOverride(settings, member.id));
  const choice =
    choices.length > 0 && choices.every((value) => value === choices[0]) ? choices[0]! : null;
  const defaults = rows.map(({ member }) => defaultScopeForProject(member.repositoryIdentity));
  const effectiveScopes = rows.map(({ member, settings }) => {
    const override = projectScopeOverride(settings, member.id);
    return override === "automatic" ? defaultScopeForProject(member.repositoryIdentity) : override;
  });
  const effectiveScope =
    effectiveScopes.length > 0 && effectiveScopes.every((value) => value === effectiveScopes[0])
      ? effectiveScopes[0]!
      : null;
  const allAvailable =
    rows.length === members.length &&
    rows.every(
      ({ environment }) =>
        environment?.connection.phase === "connected" &&
        environment.serverConfig?.environment?.capabilities.projectSettingsOverrides === true,
    );
  const hasOverride = choices.some((value) => value !== "automatic");

  const persist = useCallback(
    async (next: ScopeChoice) => {
      if (savingRef.current || !allAvailable) return;
      savingRef.current = true;
      setSaving(true);
      try {
        for (const { member, environment, settings } of rows) {
          if (!environment) continue;
          const result = await updateSettings({
            environmentId: member.environmentId,
            input: {
              patch: {
                projectSettingsOverrides: {
                  [member.id]: {
                    ...settings.projectSettingsOverrides[member.id],
                    mcpToolScope: next === "automatic" ? null : next,
                  },
                },
              },
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "MCP tool scope was not saved",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
            return;
          }
          if (result._tag === "Failure") return;
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [allAvailable, rows, updateSettings],
  );

  const automaticDescription =
    defaults.length > 0 && defaults.every((value) => value === defaults[0])
      ? `Automatic · ${scopeLabel(defaults[0]!)} for this project`
      : "Automatic · based on whether this project is version-controlled";

  return (
    <SettingsRow
      id="project-mcp-tool-scope"
      title="Agent tool access"
      description="Choose whether MCP tools can access this project or the whole environment."
      status={
        choice === "automatic"
          ? automaticDescription
          : effectiveScope
            ? scopeLabel(effectiveScope)
            : "Mixed"
      }
      resetAction={
        hasOverride ? (
          <SettingResetButton
            label="agent tool access"
            disabled={saving || !allAvailable}
            onClick={() => void persist("automatic")}
          />
        ) : null
      }
      control={
        <Select
          value={choice}
          onValueChange={(value) => {
            if (value === "automatic" || value === "project" || value === "global")
              void persist(value);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="Agent tool access"
            disabled={saving || !allAvailable}
          >
            <SelectValue>
              {(value: string | null) => {
                if (value === "automatic") return "Automatic";
                if (value === "project" || value === "global") return scopeLabel(value);
                return rows.length === 0 ? "Unavailable" : "Mixed";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="automatic">Automatic</SelectItem>
            <SelectItem value="project">Project</SelectItem>
            <SelectItem value="global">Global</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
