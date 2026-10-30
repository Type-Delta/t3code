// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { describe, expect, it as test } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointRepositoryIdentity from "./CheckpointRepositoryIdentity.ts";
import * as SidecarCheckpointRepository from "./SidecarCheckpointRepository.ts";
import * as OnlineObjects from "./SidecarOnlineObjects.ts";

const layerFor = (onlineSnapshots: boolean) =>
  SidecarCheckpointRepository.layer.pipe(
    Layer.provideMerge(
      CheckpointRepositoryIdentity.layer.pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Layer.provideMerge(ServerSettings.layerTest({ onlineSnapshots }).pipe(Layer.orDie)),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-online-snapshots-test-" }),
    ),
    Layer.provideMerge(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(NodeServices.layer),
  );

const git = Effect.fn("SidecarOnlineSnapshots.test.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly allowNonZeroExit?: boolean; readonly stdin?: string } = {},
) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const result = yield* vcsProcess.run({
    operation: "SidecarOnlineSnapshots.test.git",
    command: "git",
    cwd,
    args,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
    ...(options.allowNonZeroExit === undefined
      ? {}
      : { allowNonZeroExit: options.allowNonZeroExit }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  return { exitCode: result.exitCode, stdout: result.stdout.trim() };
});

const write = (filePath: string, contents: string) =>
  Effect.promise(() => NodeFSP.writeFile(filePath, contents));
const read = (filePath: string) => Effect.promise(() => NodeFSP.readFile(filePath, "utf8"));

/**
 * A blobless clone of a remote that serves objects by id, as GitHub does. The
 * project lacks every remote blob, so only a fetch can bring an evicted one back.
 */
const makeProject = Effect.fn("SidecarOnlineSnapshots.test.makeProject")(function* (
  options: { readonly crlfWorkspace?: boolean } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-online-snapshots-" });
  const remote = NodePath.join(root, "remote.git");
  const author = NodePath.join(root, "author");
  const project = NodePath.join(root, "project");
  const remoteUrl = `file://${remote}`;
  yield* git(root, ["init", "--bare", "-q", "-b", "main", remote]);
  yield* git(root, [`--git-dir=${remote}`, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  yield* git(root, [`--git-dir=${remote}`, "config", "uploadpack.allowFilter", "true"]);
  yield* git(root, ["init", "-q", "-b", "main", author]);
  yield* write(NodePath.join(author, "shared.txt"), "shared v1\n");
  yield* write(NodePath.join(author, "other.txt"), "other\n");
  if (options.crlfWorkspace)
    yield* write(NodePath.join(author, ".gitattributes"), "* text eol=lf\n");
  yield* git(author, ["add", "."]);
  yield* git(author, ["commit", "-qm", "initial"]);
  yield* git(author, ["push", "-q", remoteUrl, "main"]);

  yield* git(root, ["clone", "-q", "--filter=blob:none", "--no-checkout", remoteUrl, project]);
  // Populate the worktree and index without letting the project fetch any blob.
  yield* git(project, ["read-tree", "HEAD"]);
  for (const name of [
    "shared.txt",
    "other.txt",
    ...(options.crlfWorkspace ? [".gitattributes"] : []),
  ]) {
    yield* Effect.promise(() =>
      NodeFSP.copyFile(NodePath.join(author, name), NodePath.join(project, name)),
    );
  }
  if (options.crlfWorkspace) yield* write(NodePath.join(project, "shared.txt"), "shared v1\r\n");
  yield* write(NodePath.join(project, "local.txt"), "local only\n");
  const sharedBlob = (yield* git(project, ["rev-parse", "HEAD:shared.txt"])).stdout;
  const localBlob = (yield* git(project, ["hash-object", "local.txt"])).stdout;

  const identity =
    yield* (yield* CheckpointRepositoryIdentity.CheckpointRepositoryIdentityResolver).resolve(
      project,
    );
  const sidecarDir = NodePath.join(
    (yield* ServerConfig.ServerConfig).checkpointsDir,
    "repositories",
    `${identity.repositoryKey}.git`,
  );
  const sidecarHas = (oid: string) =>
    git(root, [`--git-dir=${sidecarDir}`, "cat-file", "-e", oid], { allowNonZeroExit: true }).pipe(
      Effect.map((result) => result.exitCode === 0),
    );
  const checkpointRef = (snapshotId: string) =>
    SidecarCheckpointRepository.sidecarCheckpointRef(identity, snapshotId);
  const sidecarGit = (args: ReadonlyArray<string>) =>
    git(root, [`--git-dir=${sidecarDir}`, ...args]).pipe(Effect.map((result) => result.stdout));
  const evict = Effect.gen(function* () {
    const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
    yield* sidecars.capture({ cwd: project, checkpointRef: checkpointRef("baseline") });
    yield* sidecars.maintain({ cwd: project, force: true });
    expect(yield* sidecarHas(sharedBlob)).toBe(false);
    return checkpointRef("baseline");
  });
  return {
    root,
    sidecarGit,
    evict,
    remote,
    remoteUrl,
    project,
    sharedBlob,
    localBlob,
    sidecarDir,
    sidecarHas,
    checkpointRef,
  };
});

describe("Online Snapshots", () => {
  it.layer(layerFor(true))("enabled", (it) => {
    it.effect("evicts remote-held blobs and keeps local-only ones", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        const first = project.checkpointRef("first");
        yield* sidecars.capture({ cwd: project.project, checkpointRef: first });
        const unreachable = (yield* git(
          project.root,
          [`--git-dir=${project.sidecarDir}`, "hash-object", "-w", "--stdin"],
          { stdin: "unreachable\n" },
        )).stdout;
        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(true);

        yield* sidecars.maintain({ cwd: project.project, force: true });

        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(false);
        expect(yield* project.sidecarHas(project.localBlob)).toBe(true);
        expect(yield* project.sidecarHas(unreachable)).toBe(true);
        const counts = OnlineObjects.parseCountObjects(
          (yield* git(project.root, [`--git-dir=${project.sidecarDir}`, "count-objects", "-v"]))
            .stdout,
        );
        expect(counts).toEqual({ looseObjects: 0, packs: 1 });
        expect(
          JSON.parse(yield* read(NodePath.join(project.sidecarDir, "t3-online.json"))),
        ).toEqual({ remotes: [{ name: "origin", url: project.remoteUrl }], rehydrated: false });

        // A capture over evicted index entries builds the empty-index tree.
        yield* write(NodePath.join(project.project, "local.txt"), "local edited\n");
        const second = yield* sidecars.captureWithMetadata({
          cwd: project.project,
          checkpointRef: project.checkpointRef("second"),
        });
        const scratch = NodePath.join(project.root, "scratch.git");
        yield* git(project.root, ["init", "--bare", "-q", scratch]);
        const scratchArgs = [`--git-dir=${scratch}`, `--work-tree=${project.project}`];
        yield* git(project.project, [...scratchArgs, "add", "-A"]);
        expect(second.treeOid).toBe(
          (yield* git(project.project, [...scratchArgs, "write-tree"])).stdout,
        );

        // Diff and restore fetch the evicted version back from the remote.
        const numstat = yield* sidecars.diff({
          cwd: project.project,
          fromCheckpointRef: first,
          toCheckpointRef: project.checkpointRef("second"),
          ignoreWhitespace: false,
          format: "numstat",
        });
        expect(numstat).toBe("1\t1\tlocal.txt\0");
        yield* write(NodePath.join(project.project, "shared.txt"), "shared edited\n");
        expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: first })).toBe(true);
        expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared v1\n");
        expect(yield* read(NodePath.join(project.project, "local.txt"))).toBe("local only\n");
      }),
    );

    it.effect("fails restore and diff with a typed error until the remote is reachable", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        const checkpointRef = project.checkpointRef("baseline");
        yield* sidecars.capture({ cwd: project.project, checkpointRef });
        yield* sidecars.maintain({ cwd: project.project, force: true });
        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(false);

        yield* write(NodePath.join(project.project, "shared.txt"), "shared edited\n");
        yield* write(NodePath.join(project.project, "added.txt"), "added\n");
        const edited = project.checkpointRef("edited");
        yield* sidecars.capture({ cwd: project.project, checkpointRef: edited });
        yield* git(project.project, [
          "remote",
          "set-url",
          "origin",
          "http://127.0.0.1:1/unreachable.git",
        ]);
        const restoreFailure = yield* Effect.flip(
          sidecars.restore({ cwd: project.project, checkpointRef }),
        );
        expect(restoreFailure).toMatchObject({
          _tag: "CheckpointObjectsUnavailableError",
          operation: "restore",
          reason: "network",
          remote: "origin (127.0.0.1:1/unreachable)",
          objectCount: 1,
        });
        expect(restoreFailure.message).toContain("Check your network connection");
        expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared edited\n");
        expect(yield* read(NodePath.join(project.project, "added.txt"))).toBe("added\n");
        const diffFailure = yield* Effect.flip(
          sidecars.diff({
            cwd: project.project,
            fromCheckpointRef: checkpointRef,
            toCheckpointRef: edited,
            ignoreWhitespace: false,
          }),
        );
        // Capture summaries never download: they list paths without line counts.
        expect(
          yield* sidecars.diff({
            cwd: project.project,
            fromCheckpointRef: checkpointRef,
            toCheckpointRef: edited,
            ignoreWhitespace: false,
            format: "numstat",
            allowNetwork: false,
          }),
        ).toBe("-\t-\tadded.txt\0-\t-\tshared.txt\0");
        expect(diffFailure).toMatchObject({
          _tag: "CheckpointObjectsUnavailableError",
          operation: "diff",
          reason: "network",
        });
        expect(yield* sidecars.has({ cwd: project.project, checkpointRef })).toBe(true);

        yield* git(project.project, ["remote", "set-url", "origin", project.remoteUrl]);
        expect(yield* sidecars.restore({ cwd: project.project, checkpointRef })).toBe(true);
        expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared v1\n");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(project.project, "added.txt")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
    );
    it.effect("keeps every object when the sidecar config splits packs", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        // Incompressible local-only files larger than the 1 MiB minimum split limit.
        for (const index of [0, 1, 2]) {
          yield* write(
            NodePath.join(project.project, `random-${index}.bin`),
            NodeCrypto.randomBytes(700 * 1024).toString("base64"),
          );
        }
        const checkpointRef = project.checkpointRef("large");
        yield* sidecars.capture({ cwd: project.project, checkpointRef });
        yield* project.sidecarGit(["config", "pack.packSizeLimit", "1m"]);
        yield* sidecars.maintain({ cwd: project.project, force: true });
        expect(yield* sidecars.has({ cwd: project.project, checkpointRef })).toBe(true);
        expect(yield* project.sidecarHas(project.localBlob)).toBe(true);
        expect(
          OnlineObjects.parseCountObjects(yield* project.sidecarGit(["count-objects", "-v"])),
        ).toEqual({ looseObjects: 0, packs: 1 });
      }),
    );

    it.effect("ignores local replace refs when deciding what the remote holds", () =>
      Effect.gen(function* () {
        const project = yield* makeProject();
        // A local commit whose tree holds the local-only file replaces the remote tip.
        yield* git(project.project, ["hash-object", "-w", "local.txt"]);
        const tree = (yield* git(project.project, ["mktree"], {
          stdin: `100644 blob ${project.localBlob}\tlocal.txt\n`,
        })).stdout;
        const replacement = (yield* git(project.project, ["commit-tree", tree, "-m", "local"]))
          .stdout;
        yield* git(project.project, ["replace", "origin/main", replacement]);

        yield* project.evict;
        expect(yield* project.sidecarHas(project.localBlob)).toBe(true);
      }),
    );

    it.effect("defers eviction of blobs a prepared restore pinned during the pass", () =>
      Effect.gen(function* () {
        const project = yield* makeProject();
        const realProcess = yield* VcsProcess.VcsProcess;
        const packWriting = yield* Deferred.make<void>();
        const resumePack = yield* Deferred.make<void>();
        let gated = false;
        const sidecars = yield* SidecarCheckpointRepository.make.pipe(
          Effect.provideService(
            VcsProcess.VcsProcess,
            VcsProcess.VcsProcess.of({
              run: (input) =>
                !gated && input.operation === "SidecarCheckpointRepository.maintenance.repack.write"
                  ? Effect.sync(() => {
                      gated = true;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(packWriting, undefined)),
                      Effect.andThen(Deferred.await(resumePack)),
                      Effect.andThen(realProcess.run(input)),
                    )
                  : realProcess.run(input),
            }),
          ),
        );
        const checkpointRef = project.checkpointRef("pinned");
        yield* sidecars.capture({ cwd: project.project, checkpointRef });
        const pass = yield* Effect.forkChild(
          sidecars.maintain({ cwd: project.project, force: true }),
        );
        yield* Deferred.await(packWriting);
        const pinScope = yield* Scope.make();
        yield* sidecars
          .prepareRestore({ cwd: project.project, checkpointRef })
          .pipe(Scope.provide(pinScope));
        yield* Deferred.succeed(resumePack, undefined);
        yield* Fiber.join(pass);
        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(true);

        yield* Scope.close(pinScope, Exit.void);
        yield* sidecars.maintain({ cwd: project.project, force: true });
        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(false);
      }),
    );

    it.effect("downloads from a remote eviction used after the upstream changes", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        const checkpointRef = yield* project.evict;
        const mirror = NodePath.join(project.root, "mirror.git");
        yield* git(project.root, ["init", "--bare", "-q", mirror]);
        yield* git(project.project, ["remote", "add", "mirror", `file://${mirror}`]);
        yield* git(project.project, ["config", "branch.main.remote", "mirror"]);

        yield* write(NodePath.join(project.project, "shared.txt"), "shared edited\n");
        expect(yield* sidecars.restore({ cwd: project.project, checkpointRef })).toBe(true);
        expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared v1\n");
      }),
    );

    it.effect("downloads with transport settings from the project's own config", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        // An "ssh" that runs the remote command locally, reachable only through project config.
        const fakeSsh = NodePath.join(project.root, "fake-ssh");
        yield* write(fakeSsh, '#!/bin/sh\nfor command; do :; done\nexec sh -c "$command"\n');
        yield* Effect.promise(() => NodeFSP.chmod(fakeSsh, 0o755));
        yield* git(project.project, ["config", "core.sshCommand", fakeSsh]);
        yield* git(project.project, [
          "remote",
          "set-url",
          "origin",
          `ssh://t3-unresolvable-host${project.remote}`,
        ]);
        const checkpointRef = yield* project.evict;

        yield* write(NodePath.join(project.project, "shared.txt"), "shared edited\n");
        expect(yield* sidecars.restore({ cwd: project.project, checkpointRef })).toBe(true);
        expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared v1\n");
      }),
    );

    it.effect("restores line endings when a CRLF workspace file normalizes to the target", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject({ crlfWorkspace: true });
        const checkpointRef = yield* project.evict;
        expect(yield* sidecars.restore({ cwd: project.project, checkpointRef })).toBe(true);
        expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared v1\n");
      }),
    );

    it.effect("recovers an evicted blob from an identical workspace file without a remote", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        const checkpointRef = yield* project.evict;
        yield* git(project.project, ["remote", "set-url", "origin", "http://127.0.0.1:1/x.git"]);
        yield* write(NodePath.join(project.project, "local.txt"), "local edited\n");
        expect(yield* sidecars.restore({ cwd: project.project, checkpointRef })).toBe(true);
        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(true);
        expect(yield* read(NodePath.join(project.project, "local.txt"))).toBe("local only\n");
      }),
    );

    it.effect("downloads every evicted blob back once the setting is off", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const settings = yield* ServerSettings.ServerSettingsService;
        const project = yield* makeProject();
        yield* project.evict;
        yield* Effect.gen(function* () {
          yield* settings.updateSettings({ onlineSnapshots: false });
          yield* sidecars.maintain({ cwd: project.project });
          expect(yield* project.sidecarHas(project.sharedBlob)).toBe(true);
          expect(
            JSON.parse(yield* read(NodePath.join(project.sidecarDir, "t3-online.json"))),
          ).toMatchObject({ rehydrated: true });
        }).pipe(
          Effect.ensuring(settings.updateSettings({ onlineSnapshots: true }).pipe(Effect.ignore)),
        );
      }),
    );
  });

  it.layer(layerFor(false))("disabled", (it) => {
    it.effect("packs without evicting", () =>
      Effect.gen(function* () {
        const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
        const project = yield* makeProject();
        yield* sidecars.capture({
          cwd: project.project,
          checkpointRef: project.checkpointRef("baseline"),
        });
        yield* sidecars.maintain({ cwd: project.project, force: true });
        expect(yield* project.sidecarHas(project.sharedBlob)).toBe(true);
        expect(
          OnlineObjects.parseCountObjects(
            (yield* git(project.root, [`--git-dir=${project.sidecarDir}`, "count-objects", "-v"]))
              .stdout,
          ),
        ).toEqual({ looseObjects: 0, packs: 1 });
      }),
    );
  });
});

describe("snapshot retention", () => {
  const exists = (target: string) =>
    Effect.promise(() =>
      NodeFSP.access(target).then(
        () => true,
        () => false,
      ),
    );
  /** Gates the prune's pack write and records every Git operation. */
  const instrumentedSidecars = Effect.gen(function* () {
    const realProcess = yield* VcsProcess.VcsProcess;
    const operations: Array<string> = [];
    const packWriting = yield* Deferred.make<void>();
    const resumePack = yield* Deferred.make<void>();
    let gate = false;
    const sidecars = yield* SidecarCheckpointRepository.make.pipe(
      Effect.provideService(
        VcsProcess.VcsProcess,
        VcsProcess.VcsProcess.of({
          run: (input) => {
            operations.push(input.operation);
            if (!gate || input.operation !== "SidecarCheckpointRepository.prune.repack.write") {
              return realProcess.run(input);
            }
            gate = false;
            return Deferred.succeed(packWriting, undefined).pipe(
              Effect.andThen(Deferred.await(resumePack)),
              Effect.andThen(realProcess.run(input)),
            );
          },
        }),
      ),
    );
    return {
      sidecars,
      operations,
      packWriting,
      resumePack,
      gateNextPack: () => {
        gate = true;
      },
    };
  });

  it.live("deletes expired unnamed snapshots and their objects; named ones still restore", () =>
    Effect.gen(function* () {
      const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
      const project = yield* makeProject();
      const localPath = NodePath.join(project.project, "local.txt");
      const kept = project.checkpointRef("kept");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: kept });
      yield* write(localPath, "dropped\n");
      const droppedBlob = (yield* git(project.project, ["hash-object", "local.txt"])).stdout;
      const dropped = project.checkpointRef("dropped");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: dropped });

      // A run requested later within the second Git recorded still protects it.
      const committedSeconds = Math.max(
        ...(yield* project.sidecarGit([
          "for-each-ref",
          "--format=%(committerdate:unix)",
          "refs/t3/s/",
        ]))
          .split("\n")
          .map(Number),
      );
      expect(
        yield* sidecars.retain({ live: [kept], protectedSince: committedSeconds * 1_000 + 500 }),
      ).toEqual({ snapshots: 0, repositories: 0, bytes: 0, failures: [] });
      expect(yield* sidecars.has({ cwd: project.project, checkpointRef: dropped })).toBe(true);

      yield* write(localPath, "latest\n");
      const latest = project.checkpointRef("latest");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: latest });
      expect(
        yield* sidecars.retain({ live: [kept, latest], protectedSince: Infinity }),
      ).toMatchObject({
        snapshots: 1,
        repositories: 1,
        failures: [],
      });
      expect(yield* sidecars.has({ cwd: project.project, checkpointRef: dropped })).toBe(false);
      expect(yield* project.sidecarHas(droppedBlob)).toBe(false);
      expect(yield* exists(NodePath.join(project.sidecarDir, "t3-prune-pending"))).toBe(false);
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: kept })).toBe(true);
      expect(yield* read(localPath)).toBe("local only\n");
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: latest })).toBe(true);
      expect(yield* read(localPath)).toBe("latest\n");
    }).pipe(Effect.provide(layerFor(false))),
  );

  it.live("removes emptied and abandoned stores; their checkpoints fail cleanly", () =>
    Effect.gen(function* () {
      const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
      const project = yield* makeProject();
      const sharedPath = NodePath.join(project.project, "shared.txt");
      const baseline = project.checkpointRef("baseline");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: baseline });
      yield* write(sharedPath, "shared edited\n");

      // A store that cannot be deleted yet is reported, and the next pass retries it.
      const objects = NodePath.join(project.sidecarDir, "objects");
      const tmp = NodePath.join((yield* ServerConfig.ServerConfig).checkpointsDir, "tmp");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(tmp, "in-use"), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.chmod(objects, 0o500));
      const blocked = yield* sidecars.retain({ live: [], protectedSince: Infinity });
      expect(yield* exists(project.sidecarDir)).toBe(false);
      for (const name of yield* Effect.promise(() => NodeFSP.readdir(tmp))) {
        if (name === "in-use") continue;
        yield* Effect.promise(() => NodeFSP.chmod(NodePath.join(tmp, name, "objects"), 0o700));
      }
      expect(blocked).toMatchObject({ bytes: 0, failures: [expect.any(String)] });
      const result = yield* sidecars.retain({ live: [], protectedSince: Infinity });
      expect(result).toMatchObject({ snapshots: 0, repositories: 1, failures: [] });
      expect(result.bytes).toBeGreaterThan(0);
      expect(yield* Effect.promise(() => NodeFSP.readdir(tmp))).toEqual(["in-use"]);

      expect(
        yield* Effect.flip(
          Effect.scoped(sidecars.prepareRestore({ cwd: project.project, checkpointRef: baseline })),
        ),
      ).toMatchObject({ _tag: "CheckpointSnapshotUnavailableError" });
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: baseline })).toBe(
        false,
      );
      expect(
        yield* Effect.flip(
          sidecars.diff({
            cwd: project.project,
            fromCheckpointRef: baseline,
            toCheckpointRef: baseline,
            ignoreWhitespace: false,
          }),
        ),
      ).toMatchObject({ _tag: "CheckpointSnapshotUnavailableError" });
      expect(yield* read(sharedPath)).toBe("shared edited\n");

      // A later capture starts a fresh store; one left with no snapshot is abandoned.
      const next = project.checkpointRef("next");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: next });
      yield* sidecars.delete({ cwd: project.project, checkpointRefs: [next] });
      const touchedAt = (yield* Effect.promise(() => NodeFSP.stat(project.sidecarDir))).mtimeMs;
      expect(yield* sidecars.retain({ live: [], protectedSince: touchedAt })).toMatchObject({
        repositories: 0,
      });
      expect(yield* sidecars.retain({ live: [], protectedSince: Infinity })).toMatchObject({
        snapshots: 0,
        repositories: 1,
      });
      expect(yield* exists(project.sidecarDir)).toBe(false);
    }).pipe(Effect.provide(layerFor(false))),
  );

  it.live("cancels the swap when a capture lands while packing", () =>
    Effect.gen(function* () {
      const { sidecars, packWriting, resumePack, gateNextPack } = yield* instrumentedSidecars;
      const project = yield* makeProject();
      const localPath = NodePath.join(project.project, "local.txt");
      const pendingPath = NodePath.join(project.sidecarDir, "t3-prune-pending");
      const kept = project.checkpointRef("kept");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: kept });
      yield* write(localPath, "dropped\n");
      const droppedBlob = (yield* git(project.project, ["hash-object", "local.txt"])).stdout;
      yield* sidecars.capture({
        cwd: project.project,
        checkpointRef: project.checkpointRef("dropped"),
      });

      gateNextPack();
      const retaining = yield* Effect.forkChild(
        sidecars.retain({ live: [kept], protectedSince: Infinity }),
      );
      yield* Deferred.await(packWriting);
      yield* write(localPath, "late\n");
      const late = project.checkpointRef("late");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: late });
      yield* Deferred.succeed(resumePack, undefined);
      expect(yield* Fiber.join(retaining)).toMatchObject({ snapshots: 1, failures: [] });

      expect(yield* exists(pendingPath)).toBe(true);
      expect(yield* project.sidecarHas(droppedBlob)).toBe(true);
      yield* write(localPath, "edited\n");
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: late })).toBe(true);
      expect(yield* read(localPath)).toBe("late\n");

      // The next sweep finishes the prune.
      expect(
        yield* sidecars.retain({ live: [kept, late], protectedSince: Infinity }),
      ).toMatchObject({
        snapshots: 0,
        failures: [],
      });
      expect(yield* exists(pendingPath)).toBe(false);
      expect(yield* project.sidecarHas(droppedBlob)).toBe(false);
      yield* write(localPath, "edited\n");
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: late })).toBe(true);
      expect(yield* read(localPath)).toBe("late\n");
    }).pipe(Effect.provide(layerFor(false))),
  );

  it.live("keeps blobs a capture index still names for the next capture", () =>
    Effect.gen(function* () {
      const sidecars = yield* SidecarCheckpointRepository.SidecarCheckpointRepository;
      const project = yield* makeProject();
      const localPath = NodePath.join(project.project, "local.txt");
      const kept = project.checkpointRef("kept");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: kept });
      yield* write(localPath, "indexed\n");
      // An older mtime keeps Git from re-hashing a racily clean entry on the next capture.
      yield* Effect.promise(() => NodeFSP.utimes(localPath, 1_000_000, 1_000_000));
      const indexedBlob = (yield* git(project.project, ["hash-object", "local.txt"])).stdout;
      yield* sidecars.capture({
        cwd: project.project,
        checkpointRef: project.checkpointRef("dropped"),
      });

      // An index list that cannot be read must not read as no indexes.
      const indexes = NodePath.join(project.sidecarDir, "t3-indexes");
      yield* Effect.promise(() => NodeFSP.chmod(indexes, 0o000));
      const blocked = yield* sidecars
        .retain({ live: [kept], protectedSince: Infinity })
        .pipe(Effect.ensuring(Effect.promise(() => NodeFSP.chmod(indexes, 0o700))));
      expect(blocked.failures).toHaveLength(1);
      expect(yield* project.sidecarHas(indexedBlob)).toBe(true);
      expect(yield* sidecars.retain({ live: [kept], protectedSince: Infinity })).toMatchObject({
        snapshots: 0,
        failures: [],
      });
      expect(yield* project.sidecarHas(indexedBlob)).toBe(true);
      const next = project.checkpointRef("next");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: next });
      yield* write(localPath, "edited\n");
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: next })).toBe(true);
      expect(yield* read(localPath)).toBe("indexed\n");
    }).pipe(Effect.provide(layerFor(false))),
  );

  it.live("prunes a store with evicted blobs without downloading them", () =>
    Effect.gen(function* () {
      const { sidecars, operations } = yield* instrumentedSidecars;
      const project = yield* makeProject();
      const baseline = project.checkpointRef("baseline");
      yield* sidecars.capture({ cwd: project.project, checkpointRef: baseline });
      yield* sidecars.maintain({ cwd: project.project, force: true });
      expect(yield* project.sidecarHas(project.sharedBlob)).toBe(false);
      yield* write(NodePath.join(project.project, "local.txt"), "dropped\n");
      yield* sidecars.capture({
        cwd: project.project,
        checkpointRef: project.checkpointRef("dropped"),
      });

      operations.length = 0;
      expect(yield* sidecars.retain({ live: [baseline], protectedSince: Infinity })).toMatchObject({
        snapshots: 1,
        failures: [],
      });
      expect(operations.filter((operation) => operation.includes("fetch"))).toEqual([]);
      expect(yield* project.sidecarHas(project.sharedBlob)).toBe(false);
      expect(yield* sidecars.restore({ cwd: project.project, checkpointRef: baseline })).toBe(true);
      expect(yield* read(NodePath.join(project.project, "shared.txt"))).toBe("shared v1\n");
    }).pipe(Effect.provide(layerFor(true))),
  );
});

it.each([
  ["fatal: unable to access 'https://h/r/': Could not resolve host: h", "network"],
  [
    "fatal: unable to access 'http://127.0.0.1:1/r/': Failed to connect to 127.0.0.1 port 1",
    "network",
  ],
  ["fatal: Authentication failed for 'https://github.com/a/b/'", "auth"],
  ["git@github.com: Permission denied (publickey).", "auth"],
  ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "auth"],
  ["fatal: remote error: upload-pack: not our ref 1111", "not-on-remote"],
  ["fatal: repository 'https://github.com/a/b/' not found", "repository-unavailable"],
  ["fatal: '/srv/gone.git' does not appear to be a git repository", "repository-unavailable"],
  ["error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec", "timeout"],
  ["error: something else", "unknown"],
] as const)("classifies %s as %s", (stderr, reason) => {
  expect(OnlineObjects.classifyRemoteFailure(stderr)).toBe(reason);
});

it.each([
  [
    "https://user:token@github.com/acme/app.git",
    "https://github.com/acme/app.git",
    "github.com/acme/app",
  ],
  ["https://ghp_secret@github.com/acme/app", "https://github.com/acme/app", "github.com/acme/app"],
  [
    "ssh://git:pw@host.example/acme/app.git",
    "ssh://git@host.example/acme/app.git",
    "host.example/acme/app",
  ],
  ["git@github.com:acme/app.git", "git@github.com:acme/app.git", "github.com/acme/app"],
  ["/srv/repos/app.git", "/srv/repos/app.git", "/srv/repos/app"],
] as const)("strips credentials from %s", (url, credentialFree, display) => {
  expect(OnlineObjects.credentialFreeUrl(url)).toBe(credentialFree);
  expect(OnlineObjects.remoteDisplayUrl(url)).toBe(display);
});

test("forwards only transport config the sidecar does not already read", () => {
  expect(
    OnlineObjects.transportConfigEnvironment(
      "credential.helper\nmanager\0credential.helper\nmanager\0http.sslverify\0core.sshcommand\nssh -i k\0",
      "credential.helper\nmanager\0",
    ),
  ).toEqual({
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "manager",
    GIT_CONFIG_KEY_1: "http.sslverify",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "core.sshcommand",
    GIT_CONFIG_VALUE_2: "ssh -i k",
  });
  expect(OnlineObjects.transportConfigEnvironment("", "")).toEqual({});
});

test("pairs each raw diff header with exactly one path", () => {
  const blob = (digit: string) => digit.repeat(40);
  const records = OnlineObjects.parseRawDiff(
    `:100644 100644 ${blob("1")} ${blob("2")} M\0:colon-led.txt\0` +
      `:000000 100644 ${"0".repeat(40)} ${blob("3")} A\0added.txt\0` +
      `:160000 160000 ${blob("4")} ${blob("5")} M\0submodule\0`,
  );
  expect(records.map((record) => record.path)).toEqual([
    ":colon-led.txt",
    "added.txt",
    "submodule",
  ]);
  expect(OnlineObjects.rawDiffBlobs(records)).toEqual([blob("1"), blob("2"), blob("3")]);
});
