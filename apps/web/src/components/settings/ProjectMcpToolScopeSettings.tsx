import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerSettings } from "@t3tools/contracts";
import { useRef, useState } from "react";

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
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const rows = members.flatMap((member) => {
    const environment = environmentById.get(member.environmentId);
    const settings = environment?.serverConfig?.settings;
    return settings === undefined ? [] : [{ member, environment, settings }];
  });
  const choices = rows.map(({ member, settings }) => projectScopeOverride(settings, member.id));
  const choice =
    choices.length > 0 && choices.every((value) => value === choices[0]) ? choices[0]! : null;
  const effectiveScopes = rows.map(({ member, settings }) => {
    const override = projectScopeOverride(settings, member.id);
    const defaultScope = settings.defaultMcpToolScope ?? "automatic";
    return override === "automatic"
      ? defaultScope === "automatic"
        ? defaultScopeForProject(member.repositoryIdentity)
        : defaultScope
      : override;
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

  const persist = async (next: ScopeChoice) => {
    if (savingRef.current || !allAvailable) return;
    savingRef.current = true;
    setSaving(true);
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
      }
      if (result._tag === "Failure") break;
    }
    savingRef.current = false;
    setSaving(false);
  };

  const globalDefaults = rows.map(({ settings }) => settings.defaultMcpToolScope ?? "automatic");
  const automaticDescription =
    globalDefaults.length > 0 && globalDefaults.every((value) => value === globalDefaults[0])
      ? `Default · ${
          globalDefaults[0] === "automatic"
            ? "Automatic"
            : scopeLabel(globalDefaults[0] as McpToolScope)
        }`
      : "Default · based on the global setting";

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
                if (value === "automatic") return "Default";
                if (value === "project" || value === "global") return scopeLabel(value);
                return rows.length === 0 ? "Unavailable" : "Mixed";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="automatic">Default</SelectItem>
            <SelectItem value="project">Project</SelectItem>
            <SelectItem value="global">Global</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
