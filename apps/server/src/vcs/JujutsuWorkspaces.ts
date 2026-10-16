import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";
import type { VcsDriver } from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

export type JujutsuWorkspaceOps = {
  readonly [K in "createWorkspace" | "listWorkspaces" | "removeWorkspace"]: NonNullable<
    VcsDriver["Service"][K]
  >;
};

export const makeJujutsuWorkspaceOps = Effect.fn("makeJujutsuWorkspaceOps")(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = (operation: string, cwd: string, args: ReadonlyArray<string>, timeoutMs = 30_000) =>
    process.run({
      operation,
      command: "jj",
      args: ["--no-pager", ...args],
      cwd,
      timeoutMs,
      maxOutputBytes: 64 * 1024,
    });
  const listWorkspaces: JujutsuWorkspaceOps["listWorkspaces"] = Effect.fn(
    "JujutsuWorkspaces.listWorkspaces",
  )(function* (cwd) {
    const result = yield* run(
      "JujutsuWorkspaces.listWorkspaces",
      cwd,
      ["workspace", "list", "-T", 'name ++ "\\t" ++ root ++ "\\n"'],
      5_000,
    );
    const workspaces = result.stdout.split(/\r?\n/u).flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator < 1 || separator === line.length - 1) return [];
      return [
        {
          name: line.slice(0, separator),
          path: path.resolve(line.slice(separator + 1)),
        },
      ];
    });
    return {
      workspaces,
      freshness: {
        source: "live-local" as const,
        observedAt: yield* DateTime.now,
        expiresAt: Option.none(),
      },
    };
  });
  const createWorkspace: JujutsuWorkspaceOps["createWorkspace"] = Effect.fn(
    "JujutsuWorkspaces.createWorkspace",
  )(function* (input) {
    const operation = "JujutsuWorkspaces.createWorkspace";
    yield* fs.makeDirectory(path.dirname(input.path), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd: input.cwd,
            detail: "Cannot create the workspace parent directory.",
            cause,
          }),
      ),
    );
    const args = ["workspace", "add", "--colocate", "--name", input.name];
    if (input.revision) args.push("-r", input.revision);
    args.push(input.path);
    yield* run(operation, input.cwd, args, 300_000);
    return { name: input.name, path: input.path };
  });
  const removeWorkspace: JujutsuWorkspaceOps["removeWorkspace"] = Effect.fn(
    "JujutsuWorkspaces.removeWorkspace",
  )(function* (input) {
    const { workspaces } = yield* listWorkspaces(input.cwd);
    const target = workspaces.find((entry) => entry.name === input.name);
    if (input.deleteDirectory && target) {
      const repository = yield* fs.stat(path.join(target.path, ".jj", "repo")).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation: "JujutsuWorkspaces.removeWorkspace",
              cwd: input.cwd,
              detail: "Cannot inspect the workspace repository.",
              cause,
            }),
        ),
      );
      if (repository.type === "Directory")
        return yield* new VcsRepositoryDetectionError({
          operation: "JujutsuWorkspaces.removeWorkspace",
          cwd: input.cwd,
          detail: "Cannot delete the workspace that owns the repository.",
        });
      const changes = yield* run("JujutsuWorkspaces.removeWorkspace.changes", target.path, [
        "diff",
        "--summary",
      ]);
      if (changes.stdout.trim())
        return yield* new VcsRepositoryDetectionError({
          operation: "JujutsuWorkspaces.removeWorkspace",
          cwd: input.cwd,
          detail: "Cannot delete a workspace with uncommitted changes.",
        });
    }
    yield* run("JujutsuWorkspaces.removeWorkspace", input.cwd, ["workspace", "forget", input.name]);
    if (input.deleteDirectory && target)
      yield* fs.remove(target.path, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation: "JujutsuWorkspaces.removeWorkspace",
              cwd: input.cwd,
              detail: "Cannot remove the workspace directory.",
              cause,
            }),
        ),
      );
  });
  return { createWorkspace, listWorkspaces, removeWorkspace };
});
