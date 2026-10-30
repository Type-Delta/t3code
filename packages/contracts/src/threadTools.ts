import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const ThreadToolOperation = Schema.Literals([
  "create",
  "list",
  "list_models",
  "read",
  "send",
  "wait",
]);

export class ThreadToolOperationFailureError extends Schema.TaggedError<ThreadToolOperationFailureError>()(
  "ThreadToolOperationFailureError",
  {
    operation: ThreadToolOperation,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `The ${this.operation} operation failed: ${this.reason}`;
  }
}
