# Sidecar Checkpoints and Undo/Redo Migration Handoff

## Status

Proposed fork migration. This document is an implementation handoff, not a record of completed
behavior.

## Summary

Move T3 Code workspace checkpoints out of the user's Git repository and into private, bare Git
repositories under the server state directory. Keep SQLite as the source of truth for checkpoint
metadata, capture jobs, navigation state, retention, and crash recovery. Preserve the existing Git
tree/commit representation because it gives efficient content deduplication and correct handling of
binary files, symlinks, executable bits, deletions, and untracked non-ignored files.

Add first-class, crash-recoverable undo and redo. `/undo`, `/redo`, and the existing message rewind
button must all use the same server-side navigation service. A navigation operation moves three
pieces of state together:

1. the workspace filesystem;
2. the visible T3 conversation timeline; and
3. the provider's native conversation cursor/session binding.

Checkpoint capture remains asynchronous. Turn completion, chat rendering, and ordinary agent work
must not wait for a full snapshot. Capture jobs run through a durable background queue with bounded
concurrency and per-worktree serialization. Contended captures are rejected rather than publishing
a snapshot assembled from multiple workspace states.

## Why this migration is needed

The current Git checkpoint implementation creates parentless commits in the user's object database
and anchors them at `refs/t3/checkpoints/<thread>/turn/<n>`. This has several undesirable effects:

- checkpoint refs and commits appear in Git tooling and `git log --all`;
- the project object database grows with application-owned data;
- mirror or broad ref pushes can publish application checkpoints;
- deleting a ref leaves unreachable objects until the user's repository is garbage-collected;
- linked worktrees share the common object database, so all worktrees inherit the pollution; and
- the storage locator (`CheckpointRef`) leaks a Git-ref implementation into orchestration contracts.

T3's own branch push uses an explicit `HEAD:refs/heads/<branch>` refspec and does not normally push
these refs. That reduces the immediate risk but does not fix the storage-boundary problem.

## Goals

- Never write checkpoint refs, commits, trees, blobs, temporary indexes, or reflogs into a user's
  `.git` directory for new snapshots.
- Never make checkpoint content reachable by a project remote, including through `git push
--mirror` executed outside T3.
- Support normal repositories, the primary worktree, and any linked Git worktree.
- Resolve and operate on the thread's actual worktree rather than accidentally using the primary
  checkout.
- Permit capture jobs for different worktrees to run concurrently while serializing operations that
  touch the same worktree.
- Keep snapshot creation off the turn-completion and provider-action critical paths.
- Never mark a mixed or contended background capture as ready.
- Provide repeated `/undo` and `/redo` with conventional linear-history semantics.
- Preserve redo until a new turn is started from an undone state; a new turn clears the redo line.
- Make filesystem, timeline, and provider navigation recoverable after partial failure or restart.
- Keep a pre-navigation rescue snapshot until the operation commits and for a short recovery TTL.
- Add bounded retention and garbage collection in T3's state directory.
- Keep changes to upstream-owned files small and additive so this fork can continue to merge
  upstream changes with low conflict risk.

## Non-goals

- Syncing checkpoints between machines or uploading them to a T3 service.
- Exposing sidecar refs or object IDs as a user-facing Git feature.
- Replacing the user's source-control history.
- Capturing ignored files. Match the current checkpoint policy: tracked files plus untracked,
  non-ignored files under the worktree root.
- Replaying removed prompts through a model to synthesize redo. Redo must not invoke a model or
  repeat tool calls.
- Automatically deleting checkpoint refs from remotes. Remote cleanup is explicit administration.
- Perfect point-in-time consistency for arbitrary external processes that write outside T3's
  control on filesystems without snapshot support. Such contention must be detected where possible
  and must never be represented as a known-good boundary snapshot.

## Required invariants

### Repository isolation

- The sidecar Git directory is below `ServerConfig.checkpointsDir`, never below the workspace.
- The sidecar has no remotes.
- Project Git commands never receive a sidecar ref.
- Sidecar commands always receive an explicit `--git-dir` and `--work-tree`; do not rely on process
  CWD or ambient `GIT_*` variables.
- Sanitize inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, and
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` before running checkpoint commands.
- Do not use alternates pointing at the project object database. The sidecar must remain restorable
  after project history rewrites and project Git garbage collection.

### Worktree identity

Resolve both values for every operation:

- **repository family root:** absolute, real-pathed `git rev-parse --git-common-dir`;
- **worktree root:** absolute, real-pathed `git rev-parse --show-toplevel`.

The repository key is a SHA-256 hash of a versioned identity payload containing the canonical common
directory and Git object format. All linked worktrees of one repository family therefore share one
sidecar object database. The worktree key is a hash of the canonical worktree root and distinguishes
concurrent workspaces within that family.

Every checkpoint row stores both keys. Restore may target a different linked worktree only when:

- it resolves to the same repository key;
- the caller explicitly supplies that worktree as the target; and
- the target belongs to the same T3 thread, or the operation is an explicit administrative restore.

If a worktree is moved or recreated, rebind it by resolving the same Git common directory and
updating the stored worktree key. Never fall back silently to the primary worktree.

### Snapshot correctness

- A ready snapshot is immutable.
- Snapshot creation never changes the user's HEAD, refs, index, worktree, config, hooks, or reflogs.
- Restore changes only the selected worktree and does not stage files in the user's real index.
- Ignored files are preserved during restore.
- Files introduced after the target checkpoint are removed only when Git classifies them as tracked
  or untracked/non-ignored in the target worktree.
- All filesystem paths are validated to remain within the resolved worktree root before writes or
  deletes.
- A capture that overlaps a known workspace mutation or produces different verification trees is
  `contended`, never `ready`.

### Navigation correctness

- Undo and redo are allowed only while the thread has no running turn, pending approval mutation, or
  unresolved navigation operation.
- Navigation is not complete until filesystem, provider cursor, SQLite projection cursor, and client
  refresh all correspond to the same checkpoint.
- Any failure after preparation triggers compensation to the rescue snapshot and prior provider
  binding.
- A crash can resume or compensate the operation from persisted phase markers.
- Starting a new turn while the cursor is behind the forward tip abandons the forward line and clears
  redo before dispatching the new turn.

## Proposed storage layout

```text
<stateDir>/
  state.sqlite
  checkpoints/
    repositories/
      <repository-key>.git/
        objects/
        refs/t3/threads/<encoded-thread-id>/entries/<entry-id>
        refs/t3/rescue/<operation-id>
        refs/t3/migration/<encoded-legacy-ref>
    tmp/
      <job-id>/
        index
        paths.z
```

Refs inside the sidecar are intentional GC roots. They cannot be pushed with the user's repository
because the sidecar is a different Git repository with no remote. Temporary job directories are
removed in finalizers and scavenged at startup.

Add `checkpointsDir` to `ServerDerivedPaths`, derive it as `join(stateDir, "checkpoints")`, and create
it in `ensureServerDirectories`. Tests should continue to receive it through `deriveServerPaths`
rather than constructing paths manually.

## Sidecar Git capture design

### Initialization

On first use, initialize a bare repository with the same object format as the source repository. Copy
only relevant worktree interpretation settings (`core.fileMode`, `core.symlinks`, `core.ignoreCase`,
and `core.precomposeUnicode` when present). Do not copy remotes, hooks, credentials, filters, signing
configuration, or arbitrary project config.

Use restrictive directory permissions supported by the host OS. Log the repository key and operation
ID, never file contents or environment values.

### File selection

Use the source worktree's Git installation to enumerate the exact snapshot set:

```text
git -C <worktree> ls-files --cached --others --exclude-standard -z
```

This has two important properties: tracked-but-now-ignored files remain included, while the source
`.git` directory/file and ignored untracked content are excluded. Feed the NUL-delimited path list to
the sidecar using a temporary index and pathspec file. Do not walk the workspace with a custom ignore
implementation.

Build a complete tree from an empty temporary index. This naturally records tracked deletions. Use
`git add --force --pathspec-from-file=<paths.z> --pathspec-file-nul` against the explicit sidecar
worktree. Handle an empty path list by writing the empty tree. Create a parentless commit containing
only checkpoint metadata that is safe to log: schema version, thread ID, turn ID, worktree key, and
capture job ID. Update a sidecar ref only after verification succeeds.

No checkpoint command may use the user's index. Add tests with staged changes, intent-to-add entries,
linked worktrees, spaces/non-ASCII paths, symlinks, executable files, submodules, binary files, and an
unborn HEAD.

### Background capture and contention

Persist capture work before enqueueing it. The in-memory worker is only an executor; SQLite is the
durable queue. On startup, reclaim `running` jobs whose lease expired.

Use bounded global concurrency (default 2, configurable internally) and a per-worktree semaphore of

1. Object writes for different worktrees in the same sidecar are safe, but sidecar maintenance takes
   an exclusive repository-family lock.

The orchestration event path performs only a small SQLite insert/upsert and queue notification. It
does not await Git capture, diff generation, or GC. The checkpoint projection initially reports
`pending`/`missing`; a later domain event replaces it with `ready` or `error`.

Introduce a lightweight `WorkspaceMutationCoordinator`:

- each worktree has a monotonic mutation generation;
- provider turn start, T3 VCS mutations, T3 terminal file operations where observable, restore, and
  navigation increment the generation;
- a capture records the generation before enumeration and after commit construction;
- a new T3-controlled mutation preempts/cancels an active capture rather than waiting for it to
  finish;
- provider work never waits for full snapshot creation; at most it performs a bounded cancellation
  handoff, after which the capture is considered contended even if its child process exits later;
- capture builds and compares a second verification tree before publishing when the worktree may
  have changed; and
- a filesystem watcher may increment the generation for external writes, but watcher delivery is
  an additional signal, not the sole correctness mechanism.

If generation or verification differs, discard the unreferenced candidate commit and mark the job
`contended`. Retry only while the workspace is idle and only when doing so can still represent the
desired stable state. Never relabel a later workspace state as the earlier turn boundary. If the exact
boundary was missed, expose that checkpoint as unavailable and continue the conversation normally.

This is the portable non-blocking tradeoff: agent actions are not held behind a full workspace read,
and T3 refuses to claim an exact checkpoint when concurrent writes make that impossible. Platforms
with a future native copy-on-write snapshot adapter may replace the capture source without changing
the queue or navigation model.

### Initial baseline

Queue turn-0 capture when a thread obtains its worktree/session binding, not only when the first turn
starts. If the workspace is clean and no baseline is ready, `HEAD` may be recorded as an explicit
baseline locator. Do not use `HEAD` as a fallback for a dirty workspace because that would silently
discard pre-existing user changes. If first-turn mutation wins the race with a dirty baseline, mark
turn 0 unavailable rather than delaying the agent.

### Diffing

Diff sidecar OIDs directly with `git diff --binary --no-ext-diff`. Keep the existing SQLite diff blob
cache. Include the snapshot IDs and diff options in the cache key so rewinds and branched histories do
not collide on reused turn counts. Existing file-summary parsing can remain unchanged.

### Restore

Restore through the sidecar's temporary index/worktree plumbing, never `--staged` against the project
repository. Before applying content:

1. verify the target commit and tree;
2. verify repository/worktree identity;
3. enumerate the current tracked plus untracked/non-ignored set through the project Git repository;
4. compute files that must be removed;
5. validate every path remains inside the target root; and
6. write target files through temporary siblings and atomic rename where supported.

Preserve ignored files. Refresh `WorkspaceEntries` and `VcsStatusBroadcaster` after a successful
restore. A navigation restore always has a rescue snapshot and compensation path; an administrative
restore must require explicit confirmation.

## SQLite changes

Add one additive migration. Do not rewrite the original migration files.

Suggested tables (names may be adjusted to existing repository conventions):

### `checkpoint_repositories`

| Column                       | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `repository_key` PK          | Stable sidecar repository family key                      |
| `common_dir_fingerprint`     | Hash only; avoid persisting/logging unnecessary raw paths |
| `object_format`              | `sha1` or `sha256`                                        |
| `sidecar_relative_path`      | Relative path below `checkpointsDir`                      |
| `created_at`, `last_used_at` | Retention and diagnostics                                 |

### `checkpoint_snapshots`

| Column                                 | Purpose                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `snapshot_id` PK                       | Opaque application ID                                            |
| `repository_key` FK                    | Owning sidecar                                                   |
| `worktree_key`                         | Capture/restore worktree identity                                |
| `commit_oid`                           | Sidecar commit OID                                               |
| `tree_oid`                             | Verification and dedup diagnostics                               |
| `kind`                                 | `baseline`, `turn`, `rescue`, or `legacy-import`                 |
| `state`                                | `queued`, `capturing`, `ready`, `contended`, `error`, `deleting` |
| `created_at`, `ready_at`, `expires_at` | Lifecycle                                                        |
| `error_code`                           | Sanitized typed failure code; no raw content                     |

### `checkpoint_capture_jobs`

Store job ID, snapshot ID, thread/turn identity, repository/worktree keys, requested boundary,
attempt count, lease owner/expiry, state, and timestamps. Use an idempotency uniqueness constraint on
the logical thread/turn boundary.

### `thread_checkpoint_entries`

Store immutable entry ID, thread ID, timeline generation, ordinal, turn ID, snapshot ID, provider
cursor/binding payload, assistant message ID, completion time, and state. Use `(thread_id,
timeline_generation, ordinal)` uniqueness rather than treating turn count as globally unique forever.

Provider cursor payloads are server-internal, versioned, provider-tagged JSON decoded at the adapter
boundary. They must not contain credentials.

### `thread_checkpoint_cursors`

Store thread ID, active timeline generation, current entry ID/ordinal, forward tip entry ID/ordinal,
navigation version, and update time. Initialize existing threads at their latest ready checkpoint with
no redo state.

### `checkpoint_navigation_operations`

Store operation ID, thread ID, kind (`undo`, `redo`, `jump`), from/to entry IDs, rescue snapshot ID,
prior/target provider bindings, phase, failure/compensation state, command ID, and timestamps. The
command ID is unique for idempotent retries.

### Projection compatibility

Keep existing `projection_turns.checkpoint_ref` and wire `checkpointRef` during the first migration to
minimize upstream conflicts. Treat the value as an opaque locator and encode new values as a
versioned sidecar locator, for example `t3-sidecar:v1:<snapshot-id>`. No code outside
`CheckpointStore` may parse it.

Do not immediately rename `CheckpointRef` across contracts. A later cleanup can introduce
`CheckpointSnapshotId` after the fork is stable or upstream adopts the abstraction.

## Timeline cursor and redo semantics

The existing revert projection removes newer visible material. Redo instead requires those rows to
remain recoverable.

- Keep future turn/message/plan/activity projection rows while the cursor is behind the tip.
- Projection queries return only rows on the active generation at or before the current cursor.
- User messages are associated through `projection_turns.pending_message_id`; assistant messages,
  plans, and activities use turn IDs.
- Undo moves the cursor to the previous ready entry.
- Redo moves it to the next ready entry on the same generation.
- The existing “Revert to this message” action is a multi-step jump to the selected entry and leaves
  the skipped forward entries redoable.
- Starting a new turn behind the tip first creates a new timeline generation (or marks the prior
  forward segment abandoned), clears redo, and permits ordinal reuse only in the new generation.
- Abandoned snapshots are retained for the normal TTL but are not offered by `/redo`.
- Repeated `/undo` at the baseline and `/redo` at the tip are no-ops with a clear informational
  result, not errors sent to the provider.

After navigation commits, invalidate/refetch the thread detail from server projections. Do not place
an arbitrarily large restored timeline into a domain event. The completion event carries the cursor
version and target entry; clients that miss it recover from the normal snapshot query.

## Provider conversation branching

Filesystem-only redo is incorrect because the provider would continue from the wrong conversation.
Introduce an internal provider conversation navigation capability with operations equivalent to:

```ts
prepareCursor(threadId, checkpoint): ProviderCursor
activateCursor(threadId, cursor): ProviderBinding
restoreBinding(threadId, priorBinding): void
disposeCursor(cursor): void
```

The exact API should follow Effect service conventions and remain server-internal. Persist opaque
provider cursors/bindings before filesystem mutation.

For providers that support native fork/resume-at-message behavior, undo must create or activate a
branch at the target without destroying the original native thread/session. Redo then reactivates the
preserved forward binding. Do not use destructive rollback as the primary implementation for a
redo-capable provider.

Implementation work is required per adapter:

- **Codex:** use the app-server's supported thread fork/resume primitive after verifying its protocol
  semantics against the vendored/installed Codex version. Preserve the original provider thread ID
  as the redo binding. Do not infer support from method names.
- **Claude:** use the persisted native session ID plus assistant message resume cursor, with explicit
  fork behavior so continuing from an old message cannot mutate the forward session.
- **OpenCode:** use the SDK's native session fork/resume facility if available; retain the original
  session ID for redo.
- **ACP/Grok/Cursor or future providers:** advertise navigation only after an adapter test proves
  non-destructive branch activation and restart recovery.

Provider capability reporting must distinguish `branching`, `rollback-only`, and `unsupported`.
`/redo` is enabled only for `branching`. Existing rollback-only behavior may remain behind the old
revert path during rollout, but the UI must not claim redo is available. The migration is not complete
for a provider until its branching adapter tests pass; never simulate redo by replaying prompts.

Providers without branching may still use an explicitly confirmed filesystem-only restore. `/undo`
restores the preceding ready snapshot, and message rewind restores the selected ready snapshot, while
the visible T3 chat history, timeline cursor, and provider conversation binding remain unchanged. The
confirmation must state this limitation before dispatch and the command must carry an explicit
files-only confirmation signal. `/redo` remains unavailable because no conversation branch or forward
filesystem cursor was created. Filesystem-only restore must use the same workspace mutation lock,
identity checks, rescue snapshot, and compensation safeguards as full navigation.

## Recoverable navigation saga

Implement undo, redo, and jump through one `CheckpointNavigationService`. Serialize operations per
thread and persist each phase:

1. **Validate:** thread idle, target ready, identities match, provider supports the requested move.
2. **Prepare rescue:** capture the current live workspace as a rescue snapshot. Navigation may show
   progress here; this is user-requested recovery work, not background turn capture.
3. **Prepare provider:** create/resolve the target provider cursor without replacing the active
   binding. Persist both old and target bindings.
4. **Apply filesystem:** restore the target sidecar snapshot and refresh workspace indexes/status.
5. **Activate provider:** atomically switch T3's persisted session mapping to the target binding.
6. **Move timeline cursor:** update the SQLite cursor/projections and append a completion event.
7. **Commit:** mark the operation committed and retain the rescue snapshot for the rescue TTL.
8. **Notify:** invalidate/refetch active thread detail and update undo/redo availability.

On failure after step 2, compensate in reverse order: restore the prior provider binding, restore the
rescue filesystem snapshot, restore the prior timeline cursor, and mark the operation compensated.
If compensation itself fails, leave the operation in `needs-recovery`, block further mutation for that
thread, surface an actionable error, and retry recovery at startup.

Idempotency rules must make every phase safe to repeat after process death. Never delete forward
snapshots or the rescue ref inside the uncommitted saga.

## `/undo` and `/redo` command wiring

Extend the built-in composer command type and menu with:

- `/undo` — move back one ready checkpoint;
- `/redo` — move forward one ready checkpoint.

They are standalone local commands. They must not be sent to a provider and must reject attachments,
terminal contexts, review comments, and other prompt payloads using the same standalone-command gate
as `/plan` and `/default`.

Add parsers in `composer-logic.ts`, menu entries in `ChatComposer.tsx`, and handlers in
`ChatView.tsx`. Both handlers call new client-runtime environment commands, which dispatch server
orchestration commands. The existing rewind icon calls the same navigation command with a target
entry/ordinal rather than maintaining separate revert logic.

Built-in commands take precedence over provider commands with the same names. The command palette
must show disabled reasons when:

- a turn/navigation is running;
- no ready target exists;
- the latest checkpoint is still pending/contended; or
- the provider cannot preserve conversation branches for redo.

Suggested orchestration commands/events are additive:

- `thread.checkpoint.undo`
- `thread.checkpoint.redo`
- `thread.checkpoint.jump`
- `thread.checkpoint-navigation-requested`
- `thread.checkpoint-navigation-completed`
- `thread.checkpoint-navigation-failed`
- `thread.checkpoint-forward-history-abandoned`

Keep `thread.checkpoint.revert` decoding and map it to `jump` for compatibility with persisted events
and older clients. Do not remove legacy schemas in the first release.

## Legacy checkpoint migration

Use dual-read, sidecar-write migration:

1. New captures write only to sidecars.
2. Reads resolve `t3-sidecar:v1:` first and legacy `refs/t3/checkpoints/` through the existing
   `GitVcsDriver` implementation.
3. A durable background migration discovers legacy refs referenced by SQLite projections.
4. Fetch/copy each legacy ref into the matching sidecar, preserving object format.
5. Verify commit/tree availability and diff equivalence before updating the SQLite locator.
6. Record migration completion per snapshot.
7. Delete a local legacy ref only after all SQLite references point to verified sidecar snapshots and
   a safety period or explicit cleanup confirmation has passed.
8. Never invoke `git gc` in the user's repository. T3 may explain that ordinary Git maintenance will
   eventually prune unreachable objects.

Do not migrate every `refs/t3` ref blindly: import only refs owned by a known projected thread, and
report unknown refs for manual review. Migration must be restartable and idempotent.

Remote cleanup is a separate, explicit tool that lists exact remote refs and generates deletion
refspecs. It must default to dry-run and require remote/credential confirmation. Git hosting may retain
unreferenced uploaded objects according to provider policy; do not promise immediate physical purge.

## Retention and maintenance

Initial conservative policy:

- active timeline snapshots: retain while the thread exists;
- redo line: retain until a new turn abandons it;
- abandoned forward snapshots: 7 days;
- committed rescue snapshots: 24 hours;
- failed/contended candidates without refs: eligible immediately;
- archived threads: retain normally;
- deleted threads: enqueue deletion after a 24-hour recovery grace period.

Add a size ceiling configurable later through settings, but begin with an internal default and
diagnostics. Prune metadata and sidecar refs transactionally, then run sidecar-only `git gc` under an
exclusive repository lock when thresholds justify it. Startup maintenance removes expired temp jobs
and resumes interrupted deletion; it must not block server readiness.

## Observability and privacy

Add metrics/spans for queue depth, capture latency, bytes/object count where cheaply available,
contention, retries, navigation phase latency, compensation, migration progress, and sidecar GC.

Logs may include environment ID, repository key, worktree key, thread/turn IDs, job/operation IDs,
states, and sanitized Git exit information. Do not log raw patches, paths unless already allowed by
existing diagnostics policy, commit contents, credentials, or inherited environment variables.

Expose a diagnostics summary showing sidecar location, repository count, total size, queue state,
oldest job, and recoverable failures. No checkpoint content viewer is required for this migration.

## Upstream-friendly implementation strategy

Prefer new modules and narrow integration seams:

### New server modules

- `checkpointing/SidecarCheckpointRepository.ts` — bare Git plumbing only.
- `checkpointing/CheckpointRepositoryIdentity.ts` — common-dir/worktree identity.
- `checkpointing/CheckpointCaptureQueue.ts` — durable jobs, leases, worker scheduling.
- `checkpointing/CheckpointNavigationService.ts` — undo/redo/jump saga.
- `checkpointing/CheckpointMigration.ts` — legacy dual-read importer/cleanup.
- matching service interfaces under the existing service/layer conventions.

### Minimal edits to existing files

- `config.ts`: add/derive/create `checkpointsDir`.
- `CheckpointStore.ts`: route sidecar locators and retain legacy fallback.
- `CheckpointReactor.ts`: enqueue capture and delegate navigation; remove inline Git-ref lifecycle only
  after dual-read rollout.
- orchestration contracts/decider/projector: additive commands/events and cursor projection.
- provider service/adapters: add the small conversation-branch capability.
- composer files: add two built-ins and call shared navigation handlers.
- projection query/repositories: cursor-aware visibility without unrelated refactors.

Leave `GitVcsDriver` checkpoint operations intact as a legacy adapter during the migration release.
Delete them only in a later cleanup after no legacy locators remain. Avoid broad renames, formatting
passes, or moving existing files in the same change series.

Split implementation into reviewable commits that remain independently type-safe where practical.
Keep fork-only behavior documented in `FORK.md` and rebase each phase on current upstream before
starting the next high-conflict integration phase.

## Implementation phases

### Phase 0 — Characterization and protocol discovery

- Pin tests for current capture, diff, restore, linked-worktree behavior, and revert projections.
- Verify native non-destructive branch/resume behavior for each supported provider version.
- Record capability results; do not begin redo adapter implementation from assumptions.
- Add a fixture proving a mirror push of the project cannot see an external sidecar.

Exit: current behavior is covered and provider branching feasibility is known.

### Phase 1 — Sidecar repository and worktree identity

- Add `checkpointsDir`, identity resolver, bare repository lifecycle, capture/diff/restore/delete.
- Add cross-platform and linked-worktree tests.
- Keep production capture on legacy refs behind an internal rollout switch.

Exit: sidecar unit/integration tests pass without modifying project `.git` contents.

### Phase 2 — Durable background capture

- Add SQLite migration, repositories, leased queue, bounded worker, mutation coordinator, and startup
  recovery.
- Enqueue from existing checkpoint reactor events.
- Publish pending/ready/contended/error states asynchronously.
- Confirm turn completion and provider start do not await full capture.

Exit: restart, contention, rapid consecutive turns, and multi-worktree stress tests pass.

### Phase 3 — Sidecar writes and legacy dual-read

- Switch new production captures to sidecar locators.
- Retain legacy read/restore/diff.
- Add resumable importer and verification.
- Add diagnostics and dry-run cleanup reporting.

Exit: new turns add no refs or objects to project `.git`; old checkpoints still restore.

### Phase 4 — Timeline cursor and navigation saga

- Add immutable entries, cursor state, retained forward projections, rescue snapshots, phase journal,
  compensation, and startup recovery.
- Route existing message rewind through `jump`.
- Do not expose redo yet.

Exit: arbitrary backward jump is recoverable, forward rows remain intact, and injected failures at
every phase compensate correctly.

### Phase 5 — Provider conversation branches

- Implement and test provider cursor preparation/activation/restoration.
- Persist binding changes and recover them after server restart.
- Capability-gate providers that cannot guarantee non-destructive branching.

Exit: filesystem, T3 timeline, and provider native history agree after backward and forward moves.

### Phase 6 — `/undo` and `/redo`

- Add contracts, client-runtime commands, composer parsing/menu entries, shared handlers, disabled
  reasons, refetch/invalidation, and tests.
- Repeated undo/redo, jump-then-redo, restart-between-moves, and new-turn-clears-redo must pass.

Exit: commands never reach the model and behavior matches conventional linear undo/redo.

### Phase 7 — Retention, migration cleanup, and rollout

- Enable retention and sidecar GC.
- Import verified legacy refs and offer explicit cleanup.
- Run soak tests and measure capture contention/latency/size.
- Remove the production legacy-write switch; retain legacy reads for at least one compatibility
  release.

Exit: no new repository pollution, migration is observable/recoverable, and cleanup is safe.

## Test matrix

### Snapshot content

- modified, added, deleted, renamed, staged, and unstaged files;
- tracked ignored files and ignored untracked files;
- binary files, empty files, executable bits, symlinks, non-ASCII and long paths;
- submodules and unborn repositories;
- clean baseline and dirty pre-first-turn baseline;
- no mutation of HEAD, branch refs, project index, reflogs, config, or hooks.

### Worktrees

- primary worktree capture/restore;
- linked worktree capture/restore while primary has different content;
- two linked worktrees captured concurrently;
- same relative file with different content in different worktrees;
- worktree path containing spaces;
- moved/recreated worktree rebind;
- reject unrelated repository and accidental primary-worktree fallback;
- sidecar GC while another worktree is idle, and exclusion while operations are active.

### Background behavior

- turn completion latency excludes capture duration;
- provider action proceeds when capture is slow;
- mutation preempts capture and prevents a mixed ready snapshot;
- queue survives restart and reclaims expired leases;
- duplicate runtime/domain events create one logical snapshot;
- bounded concurrency under many threads/worktrees;
- shutdown drain has a finite bound and leaves durable jobs recoverable.

### Undo/redo and saga

- undo/redo one and many steps;
- jump backward then redo one step at a time;
- baseline/tip no-op;
- new turn after undo clears forward redo;
- pending/error/contended target handling;
- external workspace changes preserved by rescue compensation;
- injected failure before/after every saga phase;
- crash/restart at every persisted phase;
- provider binding recovery and capability gating;
- client reconnect/refetch after navigation completion;
- `/undo` and `/redo` with attachments are not treated as local commands;
- provider slash commands named undo/redo cannot shadow built-ins.

### Migration/security

- sidecar contains no remotes;
- ordinary, `--all`, and `--mirror` project pushes cannot enumerate sidecar refs/objects;
- legacy import is idempotent and verifies tree/diff equivalence;
- unknown legacy refs remain untouched;
- cleanup never runs project `git gc`;
- path traversal and symlink escape attempts are rejected;
- logs and SQLite provider cursor payloads contain no credentials.

## Required validation

For every implementation phase:

- run focused unit and integration tests for touched packages;
- run `vp check`;
- run `vp run typecheck`;
- run `vp test` for built-in Vite+ tests as appropriate;
- use `vp run test` only when the package script is specifically required;
- run `vp run lint:mobile` only if native mobile code is changed;
- update `FORK.md` with files, behavior, validation, and date.

Before enabling sidecar writes by default, also run Windows, macOS, and Linux linked-worktree smoke
tests and a packaged desktop restart/recovery test.

## Acceptance criteria

- Creating and completing turns produces zero new refs and zero new objects in the project Git
  directory attributable to T3 checkpoints.
- The sidecar is usable from every linked worktree in the repository family without content leakage
  between worktrees.
- Snapshot work is asynchronous and does not extend turn completion or wait behind full capture on
  the provider path.
- Contended captures are unavailable rather than corrupt/mixed.
- `/undo`, `/redo`, and message jump share one navigation implementation.
- Redo restores filesystem, visible timeline, and provider conversation binding without rerunning the
  model or tools.
- A new turn after undo clears redo deterministically.
- Every partially completed navigation is committed, compensated, or surfaced as recoverable after
  restart.
- Legacy checkpoints remain readable during rollout and can be imported without destructive
  repository maintenance.
- Retention and GC affect only T3's state directory.
- Required checks pass and the fork divergence is documented.

## Open decisions that must be resolved in Phase 0

These decisions are deliberately explicit gates rather than implementation guesses:

1. Which installed provider versions expose a tested non-destructive fork/resume primitive?
2. Resolved: rollback-only and unsupported providers expose explicitly confirmed filesystem-only
   `/undo` and message rewind; chat history and provider conversation state are not reverted, and
   `/redo` remains hidden/disabled until branching is supported.
3. What internal global capture concurrency and rescue/abandoned TTLs perform acceptably on large
   Windows repositories?
4. Is the initial filesystem watcher reliable enough on each platform to reduce verification passes,
   while retaining verification as the authority?
5. Should remote legacy-ref cleanup remain a documented CLI procedure or become a diagnostics action
   in a later release?

None of these decisions changes the core storage boundary: new checkpoint content belongs in T3's
sidecar state, not in the user's repository.
