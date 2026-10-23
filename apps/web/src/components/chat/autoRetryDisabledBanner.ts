/**
 * Reads the optional auto retry pause metadata from a server thread shell.
 *
 * The field is optional so older servers can continue to hydrate the client.
 * Keep this boundary tolerant while the shell contract rolls out across
 * server, client-runtime, and web packages.
 */
export interface AutoRetryDisabledMetadata {
  readonly until: string;
  readonly reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTimestamp(
  value: unknown,
): { readonly raw: string; readonly milliseconds: number } | null {
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? { raw: value, milliseconds } : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { raw: value.toISOString(), milliseconds: value.getTime() };
  }
  // Effect DateTime values expose their epoch through this stable field. This
  // also lets the reader bridge shells that have not yet flattened the source.
  if (isRecord(value)) {
    const epochMilliseconds =
      typeof value.epochMilliseconds === "number"
        ? value.epochMilliseconds
        : typeof value.epochMillis === "number"
          ? value.epochMillis
          : null;
    if (epochMilliseconds === null) return null;
    const date = new Date(epochMilliseconds);
    return Number.isFinite(date.getTime())
      ? { raw: date.toISOString(), milliseconds: date.getTime() }
      : null;
  }
  return null;
}

/** Returns a pause only while the server-provided expiry is in the future. */
export function readAutoRetryDisabledMetadata(
  shell: unknown,
  now = Date.now(),
): AutoRetryDisabledMetadata | null {
  if (!isRecord(shell)) return null;
  const source = isRecord(shell.source) ? shell.source : null;
  const disabledUntil = readTimestamp(
    shell.autoRetryDisabledUntil ?? source?.autoRetryDisabledUntil,
  );
  if (disabledUntil === null || disabledUntil.milliseconds <= now) return null;

  const reason = shell.autoRetryDisabledReason ?? source?.autoRetryDisabledReason;
  return {
    until: disabledUntil.raw,
    reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null,
  };
}
