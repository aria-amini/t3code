import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import type { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { makeJujutsuWorkspaceOps } from "./JujutsuWorkspaces.ts";
import * as VcsProcess from "./VcsProcess.ts";

const quoteRevision = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const ROOT_COMMIT = "0".repeat(40);
const fileArgs = (paths: readonly string[] | undefined) =>
  paths?.length ? ["--", ...paths.map((file) => `root-file:${quoteRevision(file)}`)] : [];

export const make = Effect.fn("JujutsuWorkflowDriver.make")(function* (
  git: Effect.Success<ReturnType<typeof makeGitVcsDriverCore>>,
) {
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* makeJujutsuWorkspaceOps();
  const { worktreesDir } = yield* ServerConfig;
  const mutationLocks = new Map<string, Semaphore.Semaphore>();
  const error = (cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: "JujutsuWorkflowDriver",
      command: "jj",
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const run = (cwd: string, args: readonly string[], timeoutMs = 20_000) =>
    process
      .run({
        operation: "JujutsuWorkflowDriver",
        command: "jj",
        cwd,
        args: ["--no-pager", "--color=never", ...args],
        timeoutMs,
        maxOutputBytes: 1_000_000,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.mapError((cause) => error(cwd, "Cannot run Jujutsu.", cause)),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(
                error(
                  cwd,
                  result.stderr.trim().slice(0, 4_000) ||
                    `Jujutsu exited with status ${result.exitCode}.`,
                ),
              ),
        ),
      );
  const revisions = (cwd: string, revset: string) =>
    run(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']).pipe(
      Effect.map((result) => result.stdout.trim().split("\n").filter(Boolean)),
    );
  const revision = (cwd: string, revset: string) =>
    revisions(cwd, revset).pipe(
      Effect.flatMap((commits) =>
        commits.length === 1
          ? Effect.succeed(commits[0]!)
          : Effect.fail(
              error(cwd, "Select a single, non-conflicted Jujutsu revision before this action."),
            ),
      ),
    );
  // Only an unnamed, unbookmarked change is treated as pending edits by the Git-shaped UI.
  // Described or bookmarked changes are real commits, except the unnamed initial change:
  // its first bookmark cannot point at jj's synthetic root.
  const pendingChange = (cwd: string) =>
    run(cwd, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'description == "" && parents.len() == 1 && (local_bookmarks.len() == 0 || parents.any(|p| p.root()))',
    ]).pipe(Effect.map((result) => result.stdout.trim() === "true"));
  const headRevision = (cwd: string) =>
    pendingChange(cwd).pipe(Effect.flatMap((pending) => revision(cwd, pending ? "@-" : "@")));
  const root = (cwd: string) =>
    run(cwd, ["workspace", "root"]).pipe(Effect.map((result) => result.stdout.trim()));
  const selectionPath = (cwd: string) =>
    root(cwd).pipe(Effect.map((directory) => path.join(directory, ".jj", "t3code-bookmark")));
  const selectBookmark = (cwd: string, name: string) =>
    selectionPath(cwd).pipe(
      Effect.flatMap((file) =>
        writeFileStringAtomically({
          filePath: file,
          contents: name + "\n",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.mapError((cause) => error(cwd, "Cannot save the active Jujutsu bookmark.", cause)),
    );
  const currentBookmark = Effect.fn("JujutsuWorkflowDriver.currentBookmark")(function* (
    cwd: string,
  ) {
    const selected = yield* selectionPath(cwd).pipe(
      Effect.flatMap((file) => fs.readFileString(file)),
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => null),
    );
    if (selected) {
      // Fetch can move a tracked bookmark away from this workspace's stack. Keep an explicit
      // selection so pull can reconcile it rather than silently adopting a different bookmark.
      const result = yield* run(cwd, [
        "log",
        "--no-graph",
        "-r",
        quoteRevision(selected),
        "-T",
        "commit_id",
      ]).pipe(Effect.orElseSucceed(() => null));
      if (result?.stdout.trim()) return selected;
    }
    const result = yield* run(cwd, [
      "log",
      "--no-graph",
      "-r",
      "heads(::@ & bookmarks())",
      "-T",
      'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"',
    ]);
    const names = [...new Set(result.stdout.trim().split("\n").filter(Boolean))];
    if (names.length === 0) return null;
    // Drop bookmarks other workspaces selected, then prefer a feature bookmark over the base branch
    // so a commit here does not move the base.
    const here = path.resolve(yield* root(cwd));
    const listed = yield* workspaces.listWorkspaces(cwd).pipe(Effect.orElseSucceed(() => null));
    // Without the workspace list, claims cannot be checked, so no bookmark is chosen.
    if (!listed) return null;
    const claimed = new Set<string>();
    for (const workspace of listed.workspaces) {
      if (path.resolve(workspace.path) === here) continue;
      const name = yield* fs
        .readFileString(path.join(workspace.path, ".jj", "t3code-bookmark"))
        .pipe(
          Effect.map((value) => value.trim()),
          Effect.orElseSucceed(() => ""),
        );
      claimed.add(name);
    }
    const free = names.filter((name) => !claimed.has(name));
    if (free.length === 1) return free[0]!;
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const defaultBranch = remote
      ? yield* git.resolveDefaultBranchName(cwd, remote).pipe(Effect.orElseSucceed(() => null))
      : null;
    const features = free.filter(
      (name) => name !== defaultBranch && name !== "main" && name !== "master",
    );
    return features.length === 1 ? features[0]! : null;
  });
  const requireBookmark = (cwd: string) =>
    currentBookmark(cwd).pipe(
      Effect.flatMap((name) =>
        name
          ? Effect.succeed(name)
          : Effect.fail(error(cwd, "Select or create a Jujutsu bookmark before this action.")),
      ),
    );
  const localRefName = Effect.fn("JujutsuWorkflowDriver.localRefName")(function* (
    cwd: string,
    ref: string,
  ) {
    if ((yield* git.listLocalBranchNames(cwd)).includes(ref)) return ref;
    const remotes = yield* git.execute({
      operation: "JujutsuWorkflowDriver.remotes",
      cwd,
      args: ["remote"],
    });
    return parseRemoteRefWithRemoteNames(ref, parseRemoteNames(remotes.stdout))?.branchName ?? ref;
  });
  const branchConfig = (cwd: string, branch: string, key: "remote" | "merge") =>
    git
      .execute({
        operation: "JujutsuWorkflowDriver.branchConfig",
        cwd,
        args: ["config", "--get", `branch.${branch}.${key}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
  // Push records `branch.<name>.remote` and `.merge`; fall back to the primary remote and the bookmark name.
  const upstreamRemote = Effect.fn("JujutsuWorkflowDriver.upstreamRemote")(function* (
    cwd: string,
    branch: string,
  ) {
    return (
      (yield* branchConfig(cwd, branch, "remote")) ||
      (yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null)))
    );
  });
  const upstreamRefName = Effect.fn("JujutsuWorkflowDriver.upstreamRefName")(function* (
    cwd: string,
    branch: string,
  ) {
    const remote = yield* upstreamRemote(cwd, branch);
    if (!remote) return null;
    const refName =
      (yield* branchConfig(cwd, branch, "merge")).replace(/^refs\/heads\//u, "") || branch;
    return (yield* git.remoteBranchExists({
      cwd,
      remoteName: remote,
      refName,
    }))
      ? `${remote}/${refName}`
      : null;
  });
  const statusDetails = Effect.fn("JujutsuWorkflowDriver.statusDetails")(function* (
    cwd: string,
    selected?: string,
    options?: GitVcsDriver.GitLocalStatusOptions,
  ) {
    yield* run(cwd, ["status"]);
    const local = yield* git.statusDetailsLocal(cwd, options);
    const branch = selected ?? (yield* currentBookmark(cwd));
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const defaultBranch = remote ? yield* git.resolveDefaultBranchName(cwd, remote) : null;
    const upstreamRef = branch ? yield* upstreamRefName(cwd, branch) : null;
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const pending = yield* pendingChange(cwd);
    const head = yield* headRevision(cwd);
    // The bookmark selects the comparison base; the workspace's actual head supplies the commits.
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? yield* git
            .computeAheadCountAgainstBase(cwd, branch, undefined, head)
            .pipe(Effect.orElseSucceed(() => 0))
        : 0;
    const counts =
      branch && upstreamRef
        ? yield* git
            .execute({
              operation: "JujutsuWorkflowDriver.counts",
              cwd,
              args: ["rev-list", "--left-right", "--count", `${head}...${upstreamRef}`],
            })
            .pipe(Effect.map((result) => result.stdout.trim().split(/\s+/u).map(Number)))
        : [0, 0];
    return {
      ...local,
      branch,
      upstreamRef,
      defaultBranch,
      hasUpstream: upstreamRef !== null,
      isDefaultBranch,
      hasWorkingTreeChanges: pending && local.hasWorkingTreeChanges,
      workingTree: pending ? local.workingTree : { files: [], insertions: 0, deletions: 0 },
      aheadCount: upstreamRef ? (counts[0] ?? 0) : aheadOfDefaultCount,
      behindCount: counts[1] ?? 0,
      aheadOfDefaultCount,
    };
  });
  const mutate = <A>(cwd: string, effect: Effect.Effect<A, GitCommandError>) =>
    git.withListRefsInvalidation(
      cwd,
      Effect.gen(function* () {
        const repository = yield* git.resolveGitCommonDir(cwd);
        let lock = mutationLocks.get(repository);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          mutationLocks.set(repository, lock);
        }
        return yield* lock.withPermit(effect);
      }),
    );
  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = (cwd, subject, body, options) =>
    mutate(
      cwd,
      Effect.gen(function* () {
        const name = yield* requireBookmark(cwd);
        if (!(yield* pendingChange(cwd)))
          return yield* error(
            cwd,
            "The current Jujutsu change is already a commit. Create a new change before committing.",
          );
        const reachable = yield* run(cwd, [
          "log",
          "--no-graph",
          "-r",
          `${quoteRevision(name)} & ::@`,
          "-T",
          "commit_id",
        ]);
        if (!reachable.stdout.trim())
          return yield* error(
            cwd,
            "The bookmark moved outside this workspace. Pull or switch before a commit.",
          );
        yield* run(
          cwd,
          [
            "commit",
            "-m",
            body ? `${subject}\n\n${body}` : subject,
            ...fileArgs(options?.stage?.filePaths ?? options?.filePaths),
          ],
          options?.timeoutMs ?? 20_000,
        );
        const commitSha = (yield* run(cwd, [
          "log",
          "--no-graph",
          "-r",
          "@-",
          "-T",
          "commit_id",
        ])).stdout.trim();
        yield* run(cwd, ["bookmark", "set", name, "-r", commitSha]);
        yield* selectBookmark(cwd, name);
        return { commitSha };
      }),
    );
  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = (input) =>
    mutate(
      input.cwd,
      Effect.gen(function* () {
        const previous = yield* currentBookmark(input.cwd);
        const head = yield* headRevision(input.cwd);
        yield* run(input.cwd, [
          "bookmark",
          "create",
          input.refName,
          "-r",
          // Git cannot export a bookmark pointing at jj's synthetic root commit.
          head === ROOT_COMMIT ? yield* revision(input.cwd, "@") : head,
        ]);
        if (input.switchRef) yield* selectBookmark(input.cwd, input.refName);
        else if (previous) yield* selectBookmark(input.cwd, previous);
        return { refName: input.refName };
      }),
    );
  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = (input) =>
    mutate(
      input.cwd,
      Effect.gen(function* () {
        const target = (yield* git.resolveCommit({
          cwd: input.cwd,
          revision: input.refName,
        })).commitSha;
        const refName = yield* localRefName(input.cwd, input.refName);
        if (!(yield* git.listLocalBranchNames(input.cwd)).includes(refName)) {
          yield* run(input.cwd, ["bookmark", "create", refName, "-r", target]);
        }
        const current = yield* revision(input.cwd, "@");
        if (current !== target) {
          // Carry pending edits, but leave described/bookmarked commits on their original branch.
          yield* run(
            input.cwd,
            (yield* pendingChange(input.cwd))
              ? ["rebase", "-r", "@", "-d", target]
              : ["new", target],
          );
        }
        yield* selectBookmark(input.cwd, refName);
        return { refName };
      }),
    );
  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = (input, options) =>
    mutate(
      input.cwd,
      Effect.gen(function* () {
        if (input.newRefName)
          yield* git.execute({
            operation: "JujutsuWorkflowDriver.createWorktree",
            cwd: input.cwd,
            args: ["check-ref-format", "--branch", input.newRefName],
          });
        const target = (yield* git.resolveCommit({
          cwd: input.cwd,
          revision: input.refName,
        })).commitSha;
        const name = (input.newRefName ?? input.refName).replace(/\//gu, "-");
        let directory = input.path;
        if (directory == null) {
          const parentDir = resolveWorktreesDirectory(
            options?.worktreesDirectory ?? "",
            worktreesDir,
            path,
            yield* HostProcess.HomeDirectory,
          );
          if (parentDir === null) {
            return yield* error(
              input.cwd,
              `The worktree location "${options?.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Storage.`,
            );
          }
          directory = path.join(parentDir, path.basename(yield* root(input.cwd)), name);
        }
        const workspace = yield* workspaces
          .createWorkspace({
            cwd: input.cwd,
            name,
            revision: target,
            path: directory,
          })
          .pipe(
            Effect.mapError((cause) =>
              error(input.cwd, "Cannot create the Jujutsu workspace.", cause),
            ),
          );
        return yield* Effect.gen(function* () {
          if (options?.progress?.onWorktreeClaimed)
            yield* options.progress.onWorktreeClaimed(workspace.path);
          const refName = input.newRefName ?? (yield* localRefName(input.cwd, input.refName));
          if (input.newRefName || !(yield* git.listLocalBranchNames(input.cwd)).includes(refName)) {
            yield* run(workspace.path, ["bookmark", "create", refName, "-r", target]);
          }
          yield* selectBookmark(workspace.path, refName);
          yield* git.initializeWorktreeSubmodules(workspace.path, options);
          if (input.baseRefName)
            yield* git.execute({
              operation: "JujutsuWorkflowDriver.baseRef",
              cwd: input.cwd,
              args: [
                "config",
                `branch.${refName}.gh-merge-base`,
                yield* localRefName(input.cwd, input.baseRefName),
              ],
            });
          return { worktree: { path: workspace.path, refName } };
        }).pipe(
          Effect.onError(() =>
            workspaces
              .removeWorkspace({
                cwd: input.cwd,
                name: workspace.name,
                deleteDirectory: true,
              })
              .pipe(Effect.ignoreCause({ log: true })),
          ),
        );
      }),
    );
  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = (
    cwd,
    _fallback,
    options,
  ) =>
    mutate(
      cwd,
      Effect.gen(function* () {
        const branch = yield* requireBookmark(cwd);
        const remote =
          options?.remoteName ??
          (yield* git.resolvePushRemoteName(cwd, branch)) ??
          (yield* git.resolvePrimaryRemoteName(cwd));
        const tip = yield* revision(cwd, quoteRevision(branch));
        const head = yield* headRevision(cwd);
        if (tip !== head) {
          if ((yield* revisions(cwd, `${tip} & ::${head}`)).length === 0) {
            return yield* error(
              cwd,
              "The bookmark moved outside this workspace. Pull or switch before pushing.",
            );
          }
          // Publishing advances the label over local commits, leaving an unnamed pending change out.
          yield* run(cwd, ["bookmark", "set", branch, "-r", head]);
        }
        yield* run(
          cwd,
          ["git", "push", "--remote", remote, "--bookmark", `exact:${branch}`],
          15 * 60_000,
        );
        // A later fetch can advance the tracked bookmark past `@`; the saved selection keeps it active.
        yield* selectBookmark(cwd, branch);
        for (const [key, value] of [
          ["remote", remote],
          ["merge", `refs/heads/${branch}`],
        ]) {
          yield* git.execute({
            operation: "JujutsuWorkflowDriver.upstream",
            cwd,
            args: ["config", `branch.${branch}.${key}`, value!],
          });
        }
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${remote}/${branch}`,
          setUpstream: true,
        };
      }),
    );
  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = (cwd) =>
    mutate(
      cwd,
      Effect.gen(function* () {
        const branch = yield* requireBookmark(cwd);
        const remote =
          (yield* upstreamRemote(cwd, branch)) ?? (yield* git.resolvePrimaryRemoteName(cwd));
        // Capture this before fetch: tracked bookmarks can advance as part of the fetch itself.
        const oldTip = yield* revision(cwd, quoteRevision(branch));
        yield* run(cwd, ["git", "fetch", "--remote", remote], 5 * 60_000);
        const upstreamRef = yield* upstreamRefName(cwd, branch);
        if (!upstreamRef) return yield* error(cwd, "The bookmark has no remote target to pull.");
        const target = (yield* git.resolveCommit({
          cwd,
          revision: upstreamRef,
        })).commitSha;
        const result = (status: "pulled" | "skipped_up_to_date") => ({
          status,
          refName: branch,
          upstreamRef,
        });
        const finish = Effect.fn("JujutsuWorkflowDriver.finishPull")(function* (
          status: "pulled" | "skipped_up_to_date",
        ) {
          if (oldTip !== target) yield* run(cwd, ["bookmark", "set", branch, "-r", target]);
          yield* selectBookmark(cwd, branch);
          return result(status);
        });
        if (oldTip !== target) {
          if ((yield* revisions(cwd, `${target} & ::${oldTip}`)).length > 0)
            return result("skipped_up_to_date");
          if ((yield* revisions(cwd, `${oldTip} & ::${target}`)).length === 0) {
            return yield* error(
              cwd,
              "The bookmark and its remote have diverged. Resolve the pull with jj first.",
            );
          }
        }
        const current = yield* revision(cwd, "@");
        if (current === target)
          return yield* finish(oldTip === target ? "skipped_up_to_date" : "pulled");
        const stack = `${target}..@`;
        if ((yield* revisions(cwd, stack)).length === 0) {
          // @ is an existing commit on the remote's history, not a scratch change to rebase.
          yield* run(cwd, ["new", target]);
        } else {
          const roots = yield* revisions(cwd, `roots(${stack})`);
          const parents = yield* revisions(cwd, `parents(roots(${stack})) ~ (${stack})`);
          if (parents.length === 1 && parents[0] === target) {
            return yield* finish(oldTip === target ? "skipped_up_to_date" : "pulled");
          }
          // Rebase the whole local line, not only @. Refuse merges with unrelated parents rather
          // than flattening them into a different history through the Git-shaped pull action.
          if (roots.length !== 1 || parents.length !== 1) {
            return yield* error(
              cwd,
              "This workspace has a merge stack. Resolve the pull with jj first.",
            );
          }
          yield* run(cwd, ["rebase", "-r", stack, "-d", target]);
        }
        return yield* finish("pulled");
      }),
    );
  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn(
    "JujutsuWorkflowDriver.listRefs",
  )(function* (input) {
    yield* run(input.cwd, ["status"]);
    const refs = yield* git.listRefs(input);
    const active = yield* currentBookmark(input.cwd);
    const listed = yield* workspaces
      .listWorkspaces(input.cwd)
      .pipe(Effect.mapError((cause) => error(input.cwd, "Cannot list Jujutsu workspaces.", cause)));
    const assignments = new Map<string, string>();
    for (const workspace of listed.workspaces) {
      const bookmark = yield* fs
        .readFileString(path.join(workspace.path, ".jj", "t3code-bookmark"))
        .pipe(
          Effect.map((value) => value.trim()),
          Effect.orElseSucceed(() => null),
        );
      if (bookmark) assignments.set(bookmark, workspace.path);
    }
    if (active) assignments.set(active, yield* root(input.cwd));
    return {
      ...refs,
      refs: refs.refs.map((ref) =>
        ref.isRemote
          ? ref
          : {
              ...ref,
              current: ref.name === active,
              worktreePath: assignments.get(ref.name) ?? ref.worktreePath,
            },
      ),
    };
  });
  return {
    ...git,
    resolveRemoteTrackingCommit: (input) =>
      git.resolveRemoteTrackingCommit(input).pipe(
        Effect.catchTags({
          GitCommandError: (cause) =>
            Effect.gen(function* () {
              // A local-only bookmark is a valid workspace base in jj. Keep Git's remote-only lookup
              // unchanged so a missing remote branch cannot silently select an unrelated local branch.
              if (!(yield* git.listLocalBranchNames(input.cwd)).includes(input.refName))
                return yield* cause;
              return {
                commitSha: yield* revision(input.cwd, quoteRevision(input.refName)),
                remoteRefName: `${input.fallbackRemoteName}/${input.refName}`,
              };
            }),
        }),
      ),
    statusDetails,
    statusDetailsLocal: (cwd, options) => statusDetails(cwd, undefined, options),
    statusDetailsRemote: Effect.fn("JujutsuWorkflowDriver.statusDetailsRemote")(
      function* (cwd, options) {
        const branch = options?.refreshUpstream === false ? null : yield* currentBookmark(cwd);
        const remote = branch ? yield* upstreamRemote(cwd, branch) : null;
        // jj imports the fetched remote-tracking refs on its next command in a colocated repository.
        if (remote)
          yield* git.refreshRemoteIfStale(cwd, remote).pipe(Effect.ignoreCause({ log: true }));
        return yield* statusDetails(cwd);
      },
    ),
    status: (input) =>
      statusDetails(input.cwd).pipe(
        Effect.map((status) => ({
          isRepo: status.isRepo,
          hasPrimaryRemote: status.hasOriginRemote,
          isDefaultRef: status.isDefaultBranch,
          refName: status.branch,
          hasWorkingTreeChanges: status.hasWorkingTreeChanges,
          workingTree: status.workingTree,
          hasUpstream: status.hasUpstream,
          aheadCount: status.aheadCount,
          behindCount: status.behindCount,
          aheadOfDefaultCount: status.aheadOfDefaultCount,
          pr: null,
        })),
      ),
    prepareCommitContext: Effect.fn("JujutsuWorkflowDriver.prepareCommitContext")(
      function* (cwd, filePaths, options) {
        if (!(yield* pendingChange(cwd))) return null;
        const args = fileArgs(filePaths);
        const files = yield* run(cwd, ["diff", "--name-only", ...args]);
        if (!files.stdout.trim()) return null;
        const summary = yield* run(cwd, ["diff", "--stat", ...args]);
        const stagedPatch =
          options?.includePatch === false
            ? ""
            : (yield* run(cwd, ["diff", "--git", ...args])).stdout;
        return { stagedSummary: summary.stdout, stagedPatch };
      },
    ),
    // jj bookmarks are labels that rarely keep up with the working copy, so the review compares the
    // whole working copy with the base; the active bookmark only names the head.
    getReviewDiffPreview: Effect.fn("JujutsuWorkflowDriver.getReviewDiffPreview")(
      function* (input, options) {
        const branch =
          options?.branch !== undefined ? options.branch : yield* currentBookmark(input.cwd);
        const workingCopy = yield* revision(input.cwd, "@");
        const head = yield* headRevision(input.cwd);
        // Let Git's unborn-HEAD handling use the empty tree for the first pending change.
        const workingTreeBase = head === ROOT_COMMIT ? "HEAD" : head;
        return yield* git.getReviewDiffPreview(input, {
          branch,
          workingCopy,
          workingTreeBase,
        });
      },
    ),
    commit,
    createRef,
    switchRef,
    createWorktree,
    pushCurrentBranch,
    pullCurrentBranch,
    listRefs,
    renameBranch: (input) =>
      mutate(
        input.cwd,
        Effect.gen(function* () {
          const active = yield* currentBookmark(input.cwd);
          yield* run(input.cwd, ["bookmark", "rename", input.oldBranch, input.newBranch]);
          const config = yield* git.execute({
            operation: "JujutsuWorkflowDriver.renameBranch",
            cwd: input.cwd,
            args: [
              "config",
              "--get-regexp",
              `^branch\\.${input.oldBranch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.`,
            ],
            allowNonZeroExit: true,
          });
          if (config.exitCode === 0)
            yield* git.execute({
              operation: "JujutsuWorkflowDriver.renameBranch",
              cwd: input.cwd,
              args: [
                "config",
                "--rename-section",
                `branch.${input.oldBranch}`,
                `branch.${input.newBranch}`,
              ],
            });
          if (active === input.oldBranch) yield* selectBookmark(input.cwd, input.newBranch);
          return { branch: input.newBranch };
        }),
      ),
    fetchRemote: (input) =>
      mutate(
        input.cwd,
        run(input.cwd, ["git", "fetch", "--remote", input.remoteName], 5 * 60_000).pipe(
          Effect.asVoid,
        ),
      ),
    removeWorktree: (input) =>
      mutate(
        input.cwd,
        Effect.gen(function* () {
          const listed = yield* workspaces
            .listWorkspaces(input.cwd)
            .pipe(
              Effect.mapError((cause) =>
                error(input.cwd, "Cannot list Jujutsu workspaces.", cause),
              ),
            );
          const workspace = listed.workspaces.find(
            (entry) => path.resolve(entry.path) === path.resolve(input.path),
          );
          yield* git.removeWorktree(input);
          if (workspace)
            yield* workspaces
              .removeWorkspace({ cwd: input.cwd, name: workspace.name })
              .pipe(
                Effect.mapError((cause) =>
                  error(input.cwd, "Cannot forget the Jujutsu workspace.", cause),
                ),
              );
        }),
      ),
  } satisfies GitVcsDriver.GitVcsDriver["Service"];
});
