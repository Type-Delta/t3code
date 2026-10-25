import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

export type McpToolScope = "global" | "project";

export function effectiveMcpToolScope(
  override: McpToolScope | null | undefined,
  hasRepositoryIdentity: boolean,
  defaultScope: "automatic" | McpToolScope = "automatic",
): McpToolScope {
  if (override !== undefined && override !== null) return override;
  return defaultScope === "automatic"
    ? hasRepositoryIdentity
      ? "project"
      : "global"
    : defaultScope;
}

export const resolveProjectMcpToolScope = Effect.fn("McpToolScope.resolveProject")(function* (
  projectId: ProjectId,
) {
  // Focused HTTP layers may omit these services; unresolved scope fails closed.
  // Production supplies both for the repository/settings default.
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  const settings = yield* Option.match(settingsService, {
    onNone: () => Effect.succeed(undefined),
    onSome: (service) => service.getSettings.pipe(Effect.catch(() => Effect.succeed(undefined))),
  });
  const override = settings?.projectSettingsOverrides[projectId]?.mcpToolScope;
  const defaultScope = settings?.defaultMcpToolScope ?? "automatic";
  if (override !== undefined && override !== null) return override;

  const shell = yield* Option.match(projects, {
    onNone: () => Effect.succeed(undefined),
    onSome: (service) =>
      service.getShell(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
  });
  // A missing project must not grant environment-wide access.
  return shell === undefined
    ? "project"
    : effectiveMcpToolScope(override, shell.repositoryIdentity !== null, defaultScope);
});
