// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isGitRepository(cwd: string): boolean {
  let candidate = NodePath.resolve(cwd);
  while (true) {
    if (NodeFS.existsSync(NodePath.join(candidate, ".git"))) {
      return true;
    }

    const parent = NodePath.dirname(candidate);
    if (parent === candidate) {
      return false;
    }
    candidate = parent;
  }
}
