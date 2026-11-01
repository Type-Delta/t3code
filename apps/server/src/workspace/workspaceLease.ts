// @effect-diagnostics nodeBuiltinImport:off - process-local leases resolve native paths without a service environment.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * - `exclusive` excludes holders of the same NodePath.
 * - `checkout` excludes holders of any path inside or above it (file restore).
 * - `shared` excludes only `checkout` holders (project-root turn start).
 */
export type WorkspaceLeaseMode = "exclusive" | "checkout" | "shared";

interface Holder {
  readonly cwds: ReadonlyArray<string>;
  readonly mode: WorkspaceLeaseMode;
  readonly released: Deferred.Deferred<void>;
}

const holders = new Set<Holder>();

const canonicalPath = (cwd: string): string => {
  const resolved = NodePath.resolve(cwd);
  let ancestor = resolved;
  for (;;) {
    try {
      return NodePath.join(
        NodeFS.realpathSync.native(ancestor),
        NodePath.relative(ancestor, resolved),
      );
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        (cause.code !== "ENOENT" && cause.code !== "ENOTDIR")
      )
        throw cause;
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) throw cause;
      ancestor = parent;
    }
  }
};
const inside = (parent: string, child: string) =>
  child === parent ||
  ["/", "\\"].some((sep) => child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`));
const overlaps = (left: string, right: string) => inside(left, right) || inside(right, left);

const conflicts = (left: Omit<Holder, "released">, right: Omit<Holder, "released">) =>
  left.cwds.some((leftCwd) =>
    right.cwds.some((rightCwd) =>
      left.mode === "checkout" || right.mode === "checkout"
        ? overlaps(leftCwd, rightCwd)
        : left.mode === "exclusive" && right.mode === "exclusive" && leftCwd === rightCwd,
    ),
  );

/** Several paths are taken together, so one holder never waits on itself. */
export const withWorkspaceLease = <A, E, R>(
  cwd: string | ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
  mode: WorkspaceLeaseMode = "exclusive",
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) => {
    const request = { cwds: (typeof cwd === "string" ? [cwd] : cwd).map(canonicalPath), mode };
    const acquire: Effect.Effect<Holder> = Effect.suspend(() => {
      for (const holder of holders) {
        if (conflicts(holder, request))
          return restore(Deferred.await(holder.released)).pipe(Effect.andThen(acquire));
      }
      const holder: Holder = { ...request, released: Deferred.makeUnsafe<void>() };
      holders.add(holder);
      return Effect.succeed(holder);
    });
    return Effect.flatMap(acquire, (holder) =>
      restore(effect).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            holders.delete(holder);
            return Deferred.succeed(holder.released, undefined);
          }),
        ),
      ),
    );
  });
