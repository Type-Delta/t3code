// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

const stableCheckpointId = (kind: "snapshot" | "job", input: string) =>
  `${kind}-${NodeCrypto.createHash("sha256").update(input).digest("hex")}`;

export const checkpointSnapshotIdFor = (
  threadId: string,
  timelineGeneration: number,
  turnOrdinal: number,
) => stableCheckpointId("snapshot", `${threadId}\0${timelineGeneration}\0${turnOrdinal}`);

export const checkpointCaptureJobIdFor = (
  threadId: string,
  timelineGeneration: number,
  turnId: string,
  requestedBoundary: string,
) =>
  stableCheckpointId("job", `${threadId}\0${timelineGeneration}\0${turnId}\0${requestedBoundary}`);
