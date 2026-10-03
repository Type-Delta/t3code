import {
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationV2ThreadShell,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { newCommandId, readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = (toolName: string, writable = false, projectId?: ProjectId) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (McpInvocationContext.isManagementKeyPrincipal(scope.principal)) {
      if (!McpInvocationContext.managementKeyCanUseTool(scope, toolName))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `This management key cannot use ${toolName}.`,
        });
      return { scope, caller: null, projects: yield* Project.ProjectService };
    }
    const context = yield* writable ? readMutationCaller() : readCaller();
    if (
      projectId !== undefined &&
      context.scope.mcpToolScope !== "global" &&
      context.caller.projectId !== projectId
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The project was not found.",
      });
    if (
      writable &&
      context.scope.mcpToolScope !== "global" &&
      (toolName === "t3_project_create" || toolName === "t3_project_clone")
    )
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Project-scoped credentials cannot create projects outside their project.",
      });
    return { ...context, projects: yield* Project.ProjectService };
  });

const mutation = (toolName: string, projectId?: ProjectId) =>
  Effect.gen(function* () {
    const context = yield* access(toolName, true, projectId);
    if (context.caller === null) return context.projects;
    const { caller } = context;
    if (
      caller.archivedAt !== null ||
      caller.runtimeMode !== "full-access" ||
      caller.interactionMode !== "default"
    )
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Project changes require a live full-access/default calling thread.",
      });
    return context.projects;
  });
export const ProjectHandlersLive = ProjectToolkit.toLayer({
  t3_thread_launch: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const isManagementKey = McpInvocationContext.isManagementKeyPrincipal(invocation.principal);
      let caller: OrchestrationV2ThreadShell | null = null;
      let scope = invocation;
      if (isManagementKey) {
        if (!McpInvocationContext.managementKeyCanUseTool(invocation, "t3_thread_launch"))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This management key cannot launch threads.",
          });
      } else {
        const context = yield* readMutationCaller();
        caller = context.caller;
        scope = context.scope;
      }
      if (
        caller !== null &&
        (caller.runtimeMode !== "full-access" || caller.interactionMode !== "default")
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Project launches require a full-access/default calling thread.",
        });
      const commandId = yield* newCommandId();
      const threadId = ThreadId.make(commandId);
      const messageId = MessageId.make(commandId);
      const attachments = input.attachments ?? [];
      if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A new thread accepts only pending attachment uploads.",
        });
      if (
        input.scratch === true &&
        (input.projectId !== undefined || input.workspaceStrategy !== undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
        });
      const projectId =
        input.scratch === true
          ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
              Effect.flatMap((folders) => folders.ensureScratchProject),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            )).projectId
          : (input.projectId ?? caller?.projectId);
      if (projectId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A management key must provide projectId or set scratch=true.",
        });
      if (caller !== null && scope.mcpToolScope !== "global" && projectId !== caller.projectId)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      let modelSelection = input.modelSelection ?? caller?.modelSelection;
      if (modelSelection === undefined) {
        const projects = yield* Project.ProjectService;
        const selectedProject = yield* projects
          .getById(projectId)
          .pipe(Effect.mapError(unavailable));
        modelSelection = Option.isSome(selectedProject)
          ? (selectedProject.value.defaultModelSelection ?? undefined)
          : undefined;
      }
      if (modelSelection === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Provide modelSelection or set a default model selection on the target project.",
        });
      const result = yield* ThreadMessageIntake.launchThread({
        commandId,
        threadId,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: input.runtimeMode ?? caller?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: input.interactionMode ?? caller?.interactionMode ?? "default",
        workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
        ...(input.message === undefined && attachments.length === 0
          ? {}
          : {
              initialMessage: {
                messageId,
                ...(caller === null ? {} : { senderThreadId: caller.id }),
                text: input.message ?? "",
                attachments,
              },
            }),
        createdBy: "agent",
        creationSource: "mcp",
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "AttachmentClaimError"
            ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
            : unavailable(),
        ),
      );
      const thread = result.projection.thread;
      const run = result.projection.runs.find((run) => run.userMessageId === messageId);
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
  t3_project_list: (input) =>
    Effect.gen(function* () {
      const { projects, caller, scope } = yield* access("t3_project_list");
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter(
        (project) =>
          project.deletedAt === null &&
          (caller === null || scope.mcpToolScope === "global" || project.id === caller.projectId),
      );
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  t3_project_read: (input) =>
    Effect.gen(function* () {
      const { projects } = yield* access("t3_project_read", false, input.projectId);
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  t3_project_create: ({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* mutation("t3_project_create");
      if (workspaceRoot === undefined) {
        // Project creation records no model default (only an update does), so
        // reject what this mode would otherwise drop silently.
        if (
          input.scripts !== undefined ||
          input.createWorkspaceRootIfMissing !== undefined ||
          input.defaultModelSelection !== undefined
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({ name: input.title })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return {
          ...project,
          ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
        };
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_update: (input) =>
    Effect.gen(function* () {
      const projects = yield* mutation("t3_project_update", input.projectId);
      return yield* projects
        .update({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_delete: (input) =>
    Effect.gen(function* () {
      const projects = yield* mutation("t3_project_delete", input.projectId);
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  t3_project_clone: (input) =>
    Effect.gen(function* () {
      yield* mutation("t3_project_clone");
      const repositories = yield* Repositories.SourceControlRepositoryService;
      return yield* repositories.cloneRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.detail,
            }),
        ),
      );
    }),
});
