import { NonNegativeInt, ThreadId, type VcsError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export const CheckpointDiffOperation = Schema.Literals([
  "CheckpointDiffQuery.getTurnDiff",
  "CheckpointDiffQuery.getFullThreadDiff",
]);
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type;

export class CheckpointDiffResultInvalidError extends Schema.TaggedError<CheckpointDiffResultInvalidError>()(
  "CheckpointDiffResultInvalidError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const result =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`;
  }
}

export class CheckpointThreadNotFoundError extends Schema.TaggedError<CheckpointThreadNotFoundError>()(
  "CheckpointThreadNotFoundError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`;
  }
}

export class CheckpointWorkspacePathMissingError extends Schema.TaggedError<CheckpointWorkspacePathMissingError>()(
  "CheckpointWorkspacePathMissingError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const diff =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`;
  }
}

export class CheckpointTurnRangeUnavailableError extends Schema.TaggedError<CheckpointTurnRangeUnavailableError>()(
  "CheckpointTurnRangeUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`;
  }
}

export class CheckpointRefUnavailableError extends Schema.TaggedError<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`;
  }
}

export const CheckpointObjectsUnavailableReason = Schema.Literals([
  "network",
  "timeout",
  "repository-unavailable",
  "auth",
  "not-on-remote",
  "no-remote",
  "unknown",
]);
export type CheckpointObjectsUnavailableReason = typeof CheckpointObjectsUnavailableReason.Type;

/** File versions a checkpoint operation reads were evicted to the project's remote and could not be fetched back. */
export class CheckpointObjectsUnavailableError extends Schema.TaggedError<CheckpointObjectsUnavailableError>()(
  "CheckpointObjectsUnavailableError",
  {
    operation: Schema.Literals(["restore", "diff"]),
    reason: CheckpointObjectsUnavailableReason,
    /** Remote name and credential-free URL, e.g. `origin (github.com/acme/app)`. */
    remote: Schema.optional(Schema.String),
    objectCount: NonNegativeInt,
  },
) {
  override get message(): string {
    const subject =
      this.operation === "restore" ? "Restoring this checkpoint" : "Showing this diff";
    const versions = `${this.objectCount} file ${this.objectCount === 1 ? "version" : "versions"}`;
    const remote = this.remote ?? "the project's remote";
    const outcome =
      this.operation === "restore"
        ? "this checkpoint can't be restored"
        : "this diff can't be shown";
    switch (this.reason) {
      case "network":
        return `${subject} needs ${versions} stored on ${remote}, but downloading them failed: the remote could not be reached. Check your network connection, then try again.`;
      case "timeout":
        return `${subject} needs ${versions} stored on ${remote}, but the download timed out. Check your connection to the remote, then try again.`;
      case "repository-unavailable":
        return `${subject} needs ${versions} stored on ${remote}, but that repository could not be found or you don't have access to it. If it moved, update the remote's URL; if it's private, check that your Git credentials can read it. Then try again.`;
      case "auth":
        return `${subject} needs ${versions} stored on ${remote}, but downloading them failed: authentication failed. Fix your Git credentials for this remote, then try again.`;
      case "not-on-remote":
        return `${subject} needs ${versions} that ${remote} no longer serves. They may have been deleted by a force-push or branch deletion, or stored on a remote this project no longer uses, so ${outcome}.`;
      case "no-remote":
        return `${subject} needs ${versions} that are no longer stored locally, and no Git remote is known to download them from, so ${outcome}.`;
      case "unknown":
        return `${subject} needs ${versions} stored on ${remote}, but downloading them failed. Try again; if it keeps failing, check the server logs.`;
    }
  }
}

/** Storage cleanup removed the snapshot a restore or diff reads. */
export class CheckpointSnapshotUnavailableError extends Schema.TaggedError<CheckpointSnapshotUnavailableError>()(
  "CheckpointSnapshotUnavailableError",
  {},
) {
  override get message(): string {
    return "This turn's snapshot is no longer stored, so its diff and undo are unavailable. Storage cleanup removes snapshots of deleted and idle threads; change this in Settings → Maintenance → Snapshots.";
  }
}

export type CheckpointStoreError =
  | VcsError
  | CheckpointObjectsUnavailableError
  | CheckpointSnapshotUnavailableError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError;
