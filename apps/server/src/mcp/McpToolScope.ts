import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

export type McpToolScope = "global" | "project";

export function effectiveMcpToolScope(
  override: McpToolScope | null | undefined,
  hasRepositoryIdentity: boolean,
): McpToolScope {
  return override ?? (hasRepositoryIdentity ? "project" : "global");
}

export const resolveProjectMcpToolScope = Effect.fn("McpToolScope.resolveProject")(function* (
  projectId: ProjectId,
) {
  // The HTTP middleware is also used by focused route layers that do not
  // construct the complete server runtime. Treat these services as optional
  // and fail closed when the scope cannot be resolved; the production layer
  // still supplies both services and therefore gets the repository/settings
  // based default.
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  const settings = yield* Option.match(settingsService, {
    onNone: () => Effect.succeed(undefined),
    onSome: (service) => service.getSettings.pipe(Effect.catch(() => Effect.succeed(undefined))),
  });
  const override = settings?.projectSettingsOverrides[projectId]?.mcpToolScope;
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
    : effectiveMcpToolScope(undefined, shell.repositoryIdentity !== null);
});
