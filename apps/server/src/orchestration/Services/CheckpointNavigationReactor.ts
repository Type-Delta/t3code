import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export class CheckpointNavigationReactor extends Context.Service<
  CheckpointNavigationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration/Services/CheckpointNavigationReactor") {}
