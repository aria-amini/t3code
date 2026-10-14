import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { VcsProcessExitError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeJujutsuWorkspaceOps, type JujutsuWorkspaceOps } from "./JujutsuWorkspaces.ts";

export class JujutsuVcsDriver extends Context.Service<
  JujutsuVcsDriver,
  VcsDriver.VcsDriver["Service"] & JujutsuWorkspaceOps
>()("t3/vcs/JujutsuVcsDriver") {}

const freshness = Effect.gen(function* () {
  return {
    source: "live-local" as const,
    observedAt: yield* DateTime.now,
    expiresAt: Option.none(),
  };
});

const makeJujutsuVcsDriverShape = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const process = yield* VcsProcess.VcsProcess;
  const workspaces = yield* makeJujutsuWorkspaceOps();
  const git = yield* GitVcsDriver.makeVcsDriverShape();
  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    maxOutputBytes = 64 * 1024,
  ) =>
    process.run({
      operation,
      command: "jj",
      args: ["--no-pager", ...args],
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes,
    });
  const requireSuccess = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    Effect.flatMap((result: VcsProcess.VcsProcessOutput) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new VcsProcessExitError({
              operation,
              command: "jj",
              cwd,
              argumentCount: args.length,
              exitCode: result.exitCode,
              detail: result.stderr.trim() || "jj command failed",
            }),
          ),
    );
  const root = (cwd: string) =>
    run("JujutsuVcsDriver.detectRepository.root", cwd, ["workspace", "root"]);
  const listWorkspaceFiles = Effect.fn("JujutsuVcsDriver.listWorkspaceFiles")(function* (
    cwd: string,
  ) {
    const args = ["file", "list"];
    const result = yield* process
      .run({
        operation: "JujutsuVcsDriver.listWorkspaceFiles",
        command: "jj",
        args: ["--no-pager", ...args],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: GitVcsDriver.WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      })
      .pipe(requireSuccess("JujutsuVcsDriver.listWorkspaceFiles", cwd, args));
    const lines = result.stdout.split(/\r?\n/u);
    // A truncated last line may be only part of a path.
    if (result.stdoutTruncated) lines.pop();
    return {
      paths: lines.map((line) => line.trim()).filter(Boolean),
      truncated: result.stdoutTruncated,
      freshness: yield* freshness,
    };
  });
  return {
    checkpoints: git.checkpoints,
    capabilities: {
      kind: "jj" as const,
      supportsWorktrees: true,
      supportsBookmarks: true,
      supportsAtomicSnapshot: true,
      supportsPushDefaultRemote: true,
      ignoreClassifier: "native" as const,
    },
    execute: (input: Parameters<VcsDriver.VcsDriver["Service"]["execute"]>[0]) =>
      process.run({
        ...input,
        command: "jj",
        args: ["--no-pager", ...input.args],
      }),
    isInsideWorkTree: (cwd: string) =>
      root(cwd).pipe(Effect.map((result) => result.exitCode === 0)),
    detectRepository: Effect.fn("JujutsuVcsDriver.detectRepository")(function* (cwd: string) {
      const result = yield* root(cwd);
      const rootPath = result.stdout.trim();
      if (result.exitCode !== 0 || !rootPath) return null;
      if (
        !(yield* fs.exists(path.join(rootPath, ".git")).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new VcsUnsupportedOperationError({
          operation: "JujutsuVcsDriver.detectRepository",
          kind: "jj",
          detail: "T3 Code requires a colocated repository. Run jj git init --colocate first.",
        });
      }
      return {
        kind: "jj" as const,
        rootPath,
        metadataPath: path.join(rootPath, ".jj"),
        freshness: yield* freshness,
      };
    }),
    listWorkspaceFiles,
    listRemotes: Effect.fn("JujutsuVcsDriver.listRemotes")(function* (cwd: string) {
      const args = ["git", "remote", "list"];
      const result = yield* run("JujutsuVcsDriver.listRemotes", cwd, args).pipe(
        requireSuccess("JujutsuVcsDriver.listRemotes", cwd, args),
      );
      const remotes = result.stdout.split(/\r?\n/u).flatMap((line) => {
        const match = /^(\S+)\s+(.+)$/u.exec(line.trim());
        return match
          ? [
              {
                name: match[1]!,
                url: match[2]!,
                pushUrl: Option.none<string>(),
                isPrimary: match[1] === "origin",
              },
            ]
          : [];
      });
      return { remotes, freshness: yield* freshness };
    }),
    filterIgnoredPaths: Effect.fn("JujutsuVcsDriver.filterIgnoredPaths")(function* (
      cwd: string,
      paths: ReadonlyArray<string>,
    ) {
      if (paths.length === 0) return paths;
      const files = yield* listWorkspaceFiles(cwd);
      if (files.truncated) return paths;
      const known = new Set(files.paths);
      for (const file of files.paths) {
        let directory = path.dirname(file);
        while (directory !== "." && directory !== "/" && directory !== path.dirname(directory)) {
          known.add(directory);
          directory = path.dirname(directory);
        }
      }
      return paths.filter((entry) => known.has(entry));
    }),
    initRepository: (input: Parameters<VcsDriver.VcsDriver["Service"]["initRepository"]>[0]) =>
      run("JujutsuVcsDriver.initRepository", input.cwd, ["git", "init", "--colocate"]).pipe(
        requireSuccess("JujutsuVcsDriver.initRepository", input.cwd, ["git", "init", "--colocate"]),
        Effect.asVoid,
      ),
    ...workspaces,
  } satisfies JujutsuVcsDriver["Service"];
});

export const make = makeJujutsuVcsDriverShape;
export const makeVcsDriver = make.pipe(Effect.map(VcsDriver.VcsDriver.of));
export const layer = Layer.effect(JujutsuVcsDriver, make);
