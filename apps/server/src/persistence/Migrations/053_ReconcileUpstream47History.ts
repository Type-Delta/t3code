import reconcileUpstream41History from "./046_ReconcileUpstream41History.ts";

/** Repairs fork schema skipped when an upstream database already recorded migrations 36-47. */
export default reconcileUpstream41History;
