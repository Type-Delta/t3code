import { expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpToolScope from "./McpToolScope.ts";

it("defaults to project scope for repository projects and global scope without repository identity", () => {
  expect(McpToolScope.effectiveMcpToolScope(undefined, true)).toBe("project");
  expect(McpToolScope.effectiveMcpToolScope(null, false)).toBe("global");
});

it.effect(
  "uses explicit scope overrides and falls back to project scope for missing projects",
  () =>
    Effect.gen(function* () {
      const repositoryProjectId = ProjectId.make("scope-repository-project");
      const standaloneProjectId = ProjectId.make("scope-standalone-project");
      const overrideProjectId = ProjectId.make("scope-override-project");
      const project = (repositoryIdentity: string | null) =>
        ({ repositoryIdentity }) as OrchestrationProjectShell;
      const settingsLayer = ServerSettings.layerTest({
        projectSettingsOverrides: {
          [overrideProjectId]: { mcpToolScope: "global" },
        },
      });
      const projectsLayer = Layer.mock(ProjectService.ProjectService)({
        getShell: (projectId) =>
          Effect.succeed(
            projectId === repositoryProjectId
              ? Option.some(project("https://example.test/repo.git"))
              : projectId === standaloneProjectId
                ? Option.some(project(null))
                : Option.none(),
          ),
      });
      const dependencies = Layer.merge(settingsLayer, projectsLayer);
      const resolve = (projectId: ProjectId) =>
        McpToolScope.resolveProjectMcpToolScope(projectId).pipe(Effect.provide(dependencies));

      expect(yield* resolve(repositoryProjectId)).toBe("project");
      expect(yield* resolve(standaloneProjectId)).toBe("global");
      expect(yield* resolve(overrideProjectId)).toBe("global");
      expect(yield* resolve(ProjectId.make("scope-missing-project"))).toBe("project");
    }),
);
