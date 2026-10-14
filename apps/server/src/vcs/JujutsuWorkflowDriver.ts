import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { makeJujutsuWorkspaceOps } from "./JujutsuWorkspaces.ts";
import * as VcsProcess from "./VcsProcess.ts";

const quoteRevision = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const make = Effect.fn("JujutsuWorkflowDriver.make")(function* () {
  const git = yield* makeGitVcsDriverCore();
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* makeJujutsuWorkspaceOps();
  const { worktreesDir } = yield* ServerConfig;
  const mutationLock = Semaphore.makeUnsafe(1);
  const error = (cwd: string, detail: string, cause?: unknown) => new GitCommandError({
    operation: "JujutsuWorkflowDriver", command: "jj", cwd, detail,
    ...(cause === undefined ? {} : { cause }),
  });
  const run = (cwd: string, args: readonly string[], timeoutMs = 20_000) => process.run({
    operation: "JujutsuWorkflowDriver", command: "jj", cwd,
    args: ["--no-pager", "--color=never", ...args], timeoutMs, maxOutputBytes: 1_000_000,
  }).pipe(Effect.mapError((cause) => error(cwd, "Jujutsu command failed.", cause)));
  const root = (cwd: string) => run(cwd, ["workspace", "root"]).pipe(
    Effect.map((result) => result.stdout.trim()),
  );
  const selectionPath = (cwd: string) => root(cwd).pipe(
    Effect.map((directory) => path.join(directory, ".jj", "t3code-bookmark")),
  );
  const selectBookmark = (cwd: string, name: string) => selectionPath(cwd).pipe(
    Effect.flatMap((file) => writeFileStringAtomically({ filePath: file, contents: name + "\n" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path),
    )),
    Effect.mapError((cause) => error(cwd, "Cannot save the active Jujutsu bookmark.", cause)),
  );
  const currentBookmark = Effect.fn("JujutsuWorkflowDriver.currentBookmark")(function* (cwd: string) {
    const selected = yield* selectionPath(cwd).pipe(
      Effect.flatMap((file) => fs.readFileString(file)),
      Effect.map((value) => value.trim()), Effect.orElseSucceed(() => null),
    );
    if (selected) {
      const result = yield* run(cwd, ["log", "--no-graph", "-r", `(${quoteRevision(selected)} & ::@) | (@- & ::${quoteRevision(selected)})`,
        "-T", "commit_id", "--limit", "1"]).pipe(Effect.orElseSucceed(() => null));
      if (result?.stdout.trim()) return selected;
    }
    const result = yield* run(cwd, ["log", "--no-graph", "-r", "heads(::@ & bookmarks())",
      "-T", 'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"']);
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
      const name = yield* fs.readFileString(path.join(workspace.path, ".jj", "t3code-bookmark")).pipe(
        Effect.map((value) => value.trim()), Effect.orElseSucceed(() => ""));
      claimed.add(name);
    }
    const free = names.filter((name) => !claimed.has(name));
    if (free.length === 1) return free[0]!;
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const defaultBranch = remote ? yield* git.resolveDefaultBranchName(cwd, remote).pipe(Effect.orElseSucceed(() => null)) : null;
    const features = free.filter((name) => name !== defaultBranch && name !== "main" && name !== "master");
    return features.length === 1 ? features[0]! : null;
  });
  const requireBookmark = (cwd: string) => currentBookmark(cwd).pipe(
    Effect.flatMap((name) => name ? Effect.succeed(name) : Effect.fail(
      error(cwd, "Select or create a Jujutsu bookmark before this action."),
    )),
  );
  const revision = (cwd: string, ref: string) => git.resolveCommit({ cwd, revision: ref }).pipe(
    Effect.map((result) => result.commitSha),
  );
  const localRefName = Effect.fn("JujutsuWorkflowDriver.localRefName")(function* (cwd: string, ref: string) {
    if ((yield* git.listLocalBranchNames(cwd)).includes(ref)) return ref;
    const remotes = yield* git.execute({ operation: "JujutsuWorkflowDriver.remotes", cwd, args: ["remote"] });
    return parseRemoteRefWithRemoteNames(ref, parseRemoteNames(remotes.stdout))?.branchName ?? ref;
  });
  const branchConfig = (cwd: string, branch: string, key: "remote" | "merge") => git.execute({
    operation: "JujutsuWorkflowDriver.branchConfig", cwd,
    args: ["config", "--get", `branch.${branch}.${key}`], allowNonZeroExit: true,
  }).pipe(Effect.map((result) => result.exitCode === 0 ? result.stdout.trim() : ""));
  // Push records `branch.<name>.remote` and `.merge`; fall back to the primary remote and the bookmark name.
  const upstreamRemote = Effect.fn("JujutsuWorkflowDriver.upstreamRemote")(function* (cwd: string, branch: string) {
    return (yield* branchConfig(cwd, branch, "remote"))
      || (yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null)));
  });
  const upstreamRefName = Effect.fn("JujutsuWorkflowDriver.upstreamRefName")(function* (cwd: string, branch: string) {
    const remote = yield* upstreamRemote(cwd, branch);
    if (!remote) return null;
    const refName = (yield* branchConfig(cwd, branch, "merge")).replace(/^refs\/heads\//u, "") || branch;
    return (yield* git.remoteBranchExists({ cwd, remoteName: remote, refName })) ? `${remote}/${refName}` : null;
  });
  const statusDetails = Effect.fn("JujutsuWorkflowDriver.statusDetails")(function* (cwd: string, selected?: string) {
    yield* run(cwd, ["status"]);
    const local = yield* git.statusDetailsLocal(cwd);
    const branch = selected ?? (yield* currentBookmark(cwd));
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const defaultBranch = remote ? yield* git.resolveDefaultBranchName(cwd, remote) : null;
    const upstreamRef = branch ? yield* upstreamRefName(cwd, branch) : null;
    const isDefaultBranch = branch !== null && branch === defaultBranch;
    // Git reports no branch in a detached jj workspace, so compute the base delta from the bookmark.
    const aheadOfDefaultCount = branch && !isDefaultBranch
      ? yield* git.computeAheadCountAgainstBase(cwd, branch).pipe(Effect.orElseSucceed(() => 0))
      : 0;
    const head = (yield* run(cwd, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"])).stdout.trim();
    const counts = branch && upstreamRef ? yield* git.execute({
      operation: "JujutsuWorkflowDriver.counts", cwd,
      args: ["rev-list", "--left-right", "--count", `${head}...${upstreamRef}`],
    }).pipe(Effect.map((result) => result.stdout.trim().split(/\s+/u).map(Number))) : [0, 0];
    return {
      ...local, branch, upstreamRef, hasUpstream: upstreamRef !== null, isDefaultBranch,
      aheadCount: upstreamRef ? counts[0] ?? 0 : aheadOfDefaultCount,
      behindCount: counts[1] ?? 0, aheadOfDefaultCount,
    };
  });
  const mutate = <A>(cwd: string, effect: Effect.Effect<A, GitCommandError>) =>
    git.withListRefsInvalidation(cwd, mutationLock.withPermit(effect));
  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = (cwd, subject, body, options) =>
    mutate(cwd, Effect.gen(function* () {
      const name = yield* requireBookmark(cwd);
      const reachable = yield* run(cwd, ["log", "--no-graph", "-r", `${quoteRevision(name)} & ::@`, "-T", "commit_id"]);
      if (!reachable.stdout.trim()) return yield* error(cwd, "The bookmark moved outside this workspace. Pull or switch before a commit.");
      yield* run(cwd, ["commit", "-m", body ? `${subject}\n\n${body}` : subject,
        ...(options?.filePaths ? ["--", ...options.filePaths] : [])], options?.timeoutMs ?? 20_000);
      const commitSha = (yield* run(cwd, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"])).stdout.trim();
      yield* run(cwd, ["bookmark", "set", name, "-r", commitSha]);
      yield* selectBookmark(cwd, name);
      return { commitSha };
    }));
  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = (input) =>
    mutate(input.cwd, Effect.gen(function* () {
      const previous = yield* currentBookmark(input.cwd);
      yield* run(input.cwd, ["bookmark", "create", input.refName, "-r", "@-"]);
      if (input.switchRef) yield* selectBookmark(input.cwd, input.refName);
      else if (previous) yield* selectBookmark(input.cwd, previous);
      return { refName: input.refName };
    }));
  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = (input) =>
    mutate(input.cwd, Effect.gen(function* () {
      const target = yield* revision(input.cwd, input.refName);
      const refName = yield* localRefName(input.cwd, input.refName);
      if (!(yield* git.listLocalBranchNames(input.cwd)).includes(refName)) {
        yield* run(input.cwd, ["bookmark", "create", refName, "-r", target]);
      }
      // Rebase the working-copy change so uncommitted files follow the selected bookmark.
      yield* run(input.cwd, ["rebase", "-r", "@", "-d", target]);
      yield* selectBookmark(input.cwd, refName);
      return { refName };
    }));
  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = (input, options) =>
    mutate(input.cwd, Effect.gen(function* () {
      const target = yield* revision(input.cwd, input.refName);
      const name = (input.newRefName ?? input.refName).replace(/\//gu, "-");
      const directory = input.path ?? path.join(worktreesDir, path.basename(yield* root(input.cwd)), name);
      const workspace = yield* workspaces.createWorkspace({
        cwd: input.cwd, name, revision: target, path: directory,
      }).pipe(Effect.mapError((cause) => error(input.cwd, "Cannot create the Jujutsu workspace.", cause)));
      if (options?.progress?.onWorktreeClaimed) yield* options.progress.onWorktreeClaimed(workspace.path);
      const refName = input.newRefName ?? (yield* localRefName(input.cwd, input.refName));
      if (input.newRefName || !(yield* git.listLocalBranchNames(input.cwd)).includes(refName)) {
        yield* run(workspace.path, ["bookmark", "create", refName, "-r", target]);
      }
      yield* selectBookmark(workspace.path, refName);
      yield* git.initializeWorktreeSubmodules(workspace.path, options);
      if (input.baseRefName) yield* git.execute({
        operation: "JujutsuWorkflowDriver.baseRef", cwd: input.cwd,
        args: ["config", `branch.${refName}.gh-merge-base`, yield* localRefName(input.cwd, input.baseRefName)],
      });
      return { worktree: { path: workspace.path, refName } };
    }));
  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = (cwd, _fallback, options) =>
    mutate(cwd, Effect.gen(function* () {
      const branch = yield* requireBookmark(cwd);
      const remote = options?.remoteName
        ?? (yield* git.resolvePushRemoteName(cwd, branch))
        ?? (yield* git.resolvePrimaryRemoteName(cwd));
      yield* run(cwd, ["git", "push", "--remote", remote, "--bookmark", `exact:${branch}`], 15 * 60_000);
      // A later fetch can advance the tracked bookmark past `@`; the saved selection keeps it active.
      yield* selectBookmark(cwd, branch);
      for (const [key, value] of [["remote", remote], ["merge", `refs/heads/${branch}`]]) {
        yield* git.execute({ operation: "JujutsuWorkflowDriver.upstream", cwd,
          args: ["config", `branch.${branch}.${key}`, value!] });
      }
      return { status: "pushed" as const, branch, upstreamBranch: `${remote}/${branch}`, setUpstream: true };
    }));
  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = (cwd) =>
    mutate(cwd, Effect.gen(function* () {
      const branch = yield* requireBookmark(cwd);
      const remote = (yield* upstreamRemote(cwd, branch)) ?? (yield* git.resolvePrimaryRemoteName(cwd));
      yield* run(cwd, ["git", "fetch", "--remote", remote], 5 * 60_000);
      const status = yield* statusDetails(cwd, branch);
      if (status.aheadCount > 0) return yield* error(cwd, "The bookmark has local commits. Resolve the pull with jj first.");
      if (!status.upstreamRef) return yield* error(cwd, "The bookmark has no remote target to pull.");
      const target = yield* revision(cwd, status.upstreamRef);
      yield* run(cwd, ["rebase", "-r", "@", "-d", target]);
      yield* run(cwd, ["bookmark", "set", branch, "-r", target]);
      return { status: status.behindCount > 0 ? "pulled" as const : "skipped_up_to_date" as const,
        refName: branch, upstreamRef: status.upstreamRef };
    }));
  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("JujutsuWorkflowDriver.listRefs")(
    function* (input) {
      yield* run(input.cwd, ["status"]);
      const refs = yield* git.listRefs(input);
      const active = yield* currentBookmark(input.cwd);
      const listed = yield* workspaces.listWorkspaces(input.cwd).pipe(
        Effect.mapError((cause) => error(input.cwd, "Cannot list Jujutsu workspaces.", cause)),
      );
      const assignments = new Map<string, string>();
      for (const workspace of listed.workspaces) {
        const bookmark = yield* fs.readFileString(path.join(workspace.path, ".jj", "t3code-bookmark")).pipe(
          Effect.map((value) => value.trim()), Effect.orElseSucceed(() => null),
        );
        if (bookmark) assignments.set(bookmark, workspace.path);
      }
      if (active) assignments.set(active, yield* root(input.cwd));
      return { ...refs, refs: refs.refs.map((ref) => ref.isRemote ? ref : ({
        ...ref, current: ref.name === active, worktreePath: assignments.get(ref.name) ?? ref.worktreePath,
      })) };
    },
  );
  return {
    ...git,
    statusDetails, statusDetailsLocal: statusDetails,
    statusDetailsRemote: (cwd, options) => Effect.gen(function* () {
      const branch = options?.refreshUpstream === false ? null : yield* currentBookmark(cwd);
      const remote = branch ? yield* upstreamRemote(cwd, branch) : null;
      // jj imports the fetched remote-tracking refs on its next command in a colocated repository.
      if (remote) yield* git.refreshRemoteIfStale(cwd, remote).pipe(Effect.ignoreCause({ log: true }));
      return { ...(yield* statusDetails(cwd)), defaultBranch: null };
    }),
    status: (input) => statusDetails(input.cwd).pipe(Effect.map((status) => ({
      isRepo: status.isRepo, hasPrimaryRemote: status.hasOriginRemote,
      isDefaultRef: status.isDefaultBranch, refName: status.branch,
      hasWorkingTreeChanges: status.hasWorkingTreeChanges, workingTree: status.workingTree,
      hasUpstream: status.hasUpstream, aheadCount: status.aheadCount, behindCount: status.behindCount,
      aheadOfDefaultCount: status.aheadOfDefaultCount, pr: null,
    }))),
    prepareCommitContext: (cwd, filePaths) => Effect.gen(function* () {
      const args = filePaths ? ["--", ...filePaths] : [];
      const summary = yield* run(cwd, ["diff", "--stat", ...args]);
      if (!summary.stdout.trim()) return null;
      const patch = yield* run(cwd, ["diff", "--git", ...args]);
      return { stagedSummary: summary.stdout, stagedPatch: patch.stdout };
    }),
    // Git HEAD is the working copy's parent. jj does not move bookmarks on commit, so a bookmark that
    // lags HEAD is only a label and the range follows HEAD; one at or ahead of HEAD is the newer tip.
    getReviewDiffPreview: (input, options) => Effect.gen(function* () {
      const branch = options?.branch !== undefined ? options.branch : yield* currentBookmark(input.cwd);
      const containsHead = branch !== null && (yield* run(input.cwd, ["log", "--no-graph", "-r",
        `@- & ::${quoteRevision(branch)}`, "-T", "commit_id", "--limit", "1"]).pipe(
        Effect.map((result) => result.stdout.trim() !== ""), Effect.orElseSucceed(() => false)));
      return yield* git.getReviewDiffPreview(input, { branch, headRef: containsHead && branch ? branch : "HEAD" });
    }),
    commit, createRef, switchRef, createWorktree, pushCurrentBranch, pullCurrentBranch, listRefs,
    renameBranch: (input) => mutate(input.cwd, run(input.cwd, ["bookmark", "rename", input.oldBranch, input.newBranch]).pipe(
      Effect.andThen(selectBookmark(input.cwd, input.newBranch)), Effect.as({ branch: input.newBranch }),
    )),
    fetchRemote: (input) => mutate(input.cwd, run(input.cwd, ["git", "fetch", "--remote", input.remoteName], 5 * 60_000).pipe(Effect.asVoid)),
    removeWorktree: (input) => mutate(input.cwd, Effect.gen(function* () {
      const listed = yield* workspaces.listWorkspaces(input.cwd).pipe(Effect.mapError((cause) => error(input.cwd, "Cannot list Jujutsu workspaces.", cause)));
      const workspace = listed.workspaces.find((entry) => path.resolve(entry.path) === path.resolve(input.path));
      yield* git.removeWorktree(input);
      if (workspace) yield* workspaces.removeWorkspace({ cwd: input.cwd, name: workspace.name }).pipe(
        Effect.mapError((cause) => error(input.cwd, "Cannot forget the Jujutsu workspace.", cause)),
      );
    })),
  } satisfies GitVcsDriver.GitVcsDriver["Service"];
});
