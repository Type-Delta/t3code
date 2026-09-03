import * as Schema from "effect/Schema";

import { MessageId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Post-turn composer suggestion: the server reads the tail of the thread the
 * user is looking at and proposes the next prompt they would plausibly send.
 */
export const ComposerSuggestionInput = Schema.Struct({
  threadId: ThreadId,
  lastMessageId: MessageId,
  modelSelection: ModelSelection,
});
export type ComposerSuggestionInput = typeof ComposerSuggestionInput.Type;

export const ComposerSuggestionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("suggestion"),
    text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
export type ComposerSuggestionResult = typeof ComposerSuggestionResult.Type;
