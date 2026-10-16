// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { CheckpointRef } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JujutsuVcsDriver from "./JujutsuVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

process.env.JJ_USER ??= "T3 Tests";
process.env.JJ_EMAIL ??= "t3-tests@example.com";
const jj = (cwd: string, args: readonly string[]) =>
  NodeChildProcess.execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const available = (() => {
  try {
    jj(process.cwd(), ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
const itJj = it.effect.skipIf(!available);
const TestLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-workflow-" });
  jj(cwd, ["git", "init", "--colocate"]);
  jj(cwd, ["config", "set", "--repo", "git.colocate", "false"]);
  yield* fs.writeFileString(path.join(cwd, "base.txt"), "base\n");
  jj(cwd, ["describe", "-m", "initial"]);
  jj(cwd, ["new"]);
  jj(cwd, ["bookmark", "create", "main", "-r", "@-"]);
  const driver = yield* GitVcsDriver.make.pipe(
    Effect.provide(
      ServerConfig.layerTest(cwd, {
        prefix: "t3-jj-workflow-config-",
      }),
    ),
  );
  return { fs, path, cwd, driver };
});

const remoteFixture = Effect.gen(function* () {
  const repo = yield* fixture;
  const { fs, path, cwd, driver } = repo;
  const remote = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-jj-audit-remote-",
  });
  yield* driver.execute({
    operation: "test",
    cwd: remote,
    args: ["init", "--bare"],
  });
  yield* driver.execute({
    operation: "test",
    cwd: remote,
    args: ["symbolic-ref", "HEAD", "refs/heads/main"],
  });
  jj(cwd, ["git", "remote", "add", "origin", remote]);
  yield* driver.pushCurrentBranch(cwd, "main");
  const cloneParent = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-jj-audit-clone-",
  });
  const clone = path.join(cloneParent, "repo");
  jj(cloneParent, ["git", "clone", "--colocate", remote, clone]);
  const advanceRemote = Effect.gen(function* () {
    yield* fs.writeFileString(path.join(clone, "remote.txt"), "remote\n");
    jj(clone, ["commit", "-m", "remote change"]);
    jj(clone, ["bookmark", "set", "main", "-r", "@-"]);
    jj(clone, ["git", "push", "--bookmark", "main"]);
  });
  return { ...repo, clone, advanceRemote };
});

const commitId = (cwd: string, revset: string) =>
  jj(cwd, ["log", "--no-graph", "-r", revset, "-T", "commit_id"]).trim();

itJj("allows a local-only jj workspace base without changing Git's remote-only lookup", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const input = { cwd, refName: "main", fallbackRemoteName: "origin" };
    assert.equal(
      (yield* driver.resolveRemoteTrackingCommit(input)).commitSha,
      commitId(cwd, "main"),
    );
    yield* fs.makeDirectory(path.join(cwd, ".t3code"));
    yield* fs.writeFileString(path.join(cwd, ".t3code", "vcs.json"), '{"vcs":{"kind":"git"}}');
    assert.equal(
      (yield* driver.resolveRemoteTrackingCommit(input).pipe(Effect.flip))._tag,
      "GitCommandError",
    );
  }).pipe(Effect.provide(TestLayer)),
);

itJj("creates the first feature bookmark and commit in an unborn colocated repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-unborn-" });
    jj(cwd, ["git", "init", "--colocate"]);
    yield* fs.writeFileString(path.join(cwd, "first.txt"), "first\n");
    const driver = yield* GitVcsDriver.make.pipe(
      Effect.provide(ServerConfig.layerTest(cwd, { prefix: "t3-jj-unborn-config-" })),
    );
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    assert.deepEqual(
      preview.sources
        .find((source) => source.kind === "working-tree")
        ?.files?.map((file) => file.path),
      ["first.txt"],
    );
    yield* driver.createRef({ cwd, refName: "feature" });
    yield* driver.switchRef({ cwd, refName: "feature" });
    const committed = yield* driver.commit(cwd, "first", "");
    assert.equal(commitId(cwd, "feature"), committed.commitSha);
    assert.equal(yield* fs.readFileString(path.join(cwd, "first.txt")), "first\n");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pull is a no-op when @ is the already published bookmarked commit", () =>
  Effect.gen(function* () {
    const { cwd, driver } = yield* remoteFixture;
    jj(cwd, ["--ignore-immutable", "edit", "main"]);
    const before = commitId(cwd, "@");
    assert.equal((yield* driver.statusDetailsLocal(cwd)).behindCount, 0);
    assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "skipped_up_to_date");
    assert.equal(commitId(cwd, "@"), before);
    assert.equal(commitId(cwd, "main"), before);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pull rebases the whole local stack above a lagging bookmark", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver, advanceRemote } = yield* remoteFixture;
    for (const name of ["first", "second"]) {
      yield* fs.writeFileString(path.join(cwd, `${name}.txt`), `${name}\n`);
      jj(cwd, ["commit", "-m", name]);
    }
    yield* fs.writeFileString(path.join(cwd, "pending.txt"), "pending\n");
    yield* advanceRemote;
    assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "pulled");
    for (const name of ["first", "second", "pending", "remote"]) {
      assert.equal(yield* fs.readFileString(path.join(cwd, `${name}.txt`)), `${name}\n`);
    }
    assert.equal(
      jj(cwd, ["log", "--no-graph", "-r", "main..@-", "-T", 'description.first_line() ++ "\\n"']),
      "second\nfirst\n",
    );
    assert.equal(commitId(cwd, "@---"), commitId(cwd, "main@origin"));
  }).pipe(Effect.provide(TestLayer)),
);

itJj(
  "pull keeps the selection and rebases local work after an earlier fetch advanced the bookmark",
  () =>
    Effect.gen(function* () {
      const { fs, path, cwd, driver, advanceRemote } = yield* remoteFixture;
      yield* fs.writeFileString(path.join(cwd, "local.txt"), "local\n");
      jj(cwd, ["commit", "-m", "local"]);
      yield* advanceRemote;
      yield* driver.fetchRemote({ cwd, remoteName: "origin" });
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "main");
      assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "pulled");
      assert.equal(commitId(cwd, "@--"), commitId(cwd, "main@origin"));
      assert.equal(yield* fs.readFileString(path.join(cwd, "local.txt")), "local\n");
      assert.equal(yield* fs.readFileString(path.join(cwd, "remote.txt")), "remote\n");
      assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "skipped_up_to_date");
    }).pipe(Effect.provide(TestLayer)),
);

itJj("pull starts a fresh change when @ is a published ancestor of the new remote tip", () =>
  Effect.gen(function* () {
    const { cwd, driver, advanceRemote } = yield* remoteFixture;
    jj(cwd, ["--ignore-immutable", "edit", "main"]);
    const before = commitId(cwd, "@");
    yield* advanceRemote;
    assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "pulled");
    assert.equal(commitId(cwd, "@-"), commitId(cwd, "main@origin"));
    assert.equal(commitId(cwd, "main@origin-"), before);
    assert.equal(jj(cwd, ["diff", "--summary"]), "");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pull leaves an ahead-only bookmark and its working copy untouched", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* remoteFixture;
    yield* fs.writeFileString(path.join(cwd, "local.txt"), "local\n");
    yield* driver.commit(cwd, "local", "");
    const before = commitId(cwd, "@");
    const bookmark = commitId(cwd, "main");
    assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "skipped_up_to_date");
    assert.equal(commitId(cwd, "@"), before);
    assert.equal(commitId(cwd, "main"), bookmark);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pull refuses divergent histories without rebasing local commits", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver, advanceRemote } = yield* remoteFixture;
    yield* fs.writeFileString(path.join(cwd, "local.txt"), "local\n");
    yield* driver.commit(cwd, "local", "");
    const before = commitId(cwd, "@");
    yield* advanceRemote;
    const failure = yield* driver.pullCurrentBranch(cwd).pipe(Effect.flip);
    assert.include(failure.message, "diverged");
    assert.equal(commitId(cwd, "@"), before);
    assert.equal(yield* fs.readFileString(path.join(cwd, "local.txt")), "local\n");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("counts described @ and local commits above a lagging bookmark in remote status", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* remoteFixture;
    yield* fs.writeFileString(path.join(cwd, "first.txt"), "first\n");
    jj(cwd, ["commit", "-m", "first"]);
    yield* fs.writeFileString(path.join(cwd, "second.txt"), "second\n");
    jj(cwd, ["describe", "-m", "second"]);
    const status = yield* driver.statusDetailsLocal(cwd);
    assert.equal(status.aheadCount, 2);
    assert.equal(status.behindCount, 0);
    assert.isFalse(status.hasWorkingTreeChanges);
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    assert.deepEqual(preview.sources.find((source) => source.kind === "working-tree")?.files, []);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("push publishes the local stack up to described @ and review excludes published work", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* remoteFixture;
    yield* fs.writeFileString(path.join(cwd, "first.txt"), "first\n");
    jj(cwd, ["commit", "-m", "first"]);
    yield* fs.writeFileString(path.join(cwd, "second.txt"), "second\n");
    jj(cwd, ["describe", "-m", "second"]);
    const head = commitId(cwd, "@");
    yield* driver.pushCurrentBranch(cwd, "main");
    assert.equal(commitId(cwd, "main@origin"), head);
    assert.equal((yield* driver.statusDetailsLocal(cwd)).aheadCount, 0);
    assert.deepEqual(reviewRange(yield* driver.getReviewDiffPreview({ cwd })).files, []);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("push advances a lagging bookmark while leaving pending edits out", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* remoteFixture;
    yield* fs.writeFileString(path.join(cwd, "local.txt"), "local\n");
    jj(cwd, ["commit", "-m", "local"]);
    yield* fs.writeFileString(path.join(cwd, "pending.txt"), "pending\n");
    yield* driver.pushCurrentBranch(cwd, "main");
    assert.equal(commitId(cwd, "main@origin"), commitId(cwd, "@-"));
    assert.include(jj(cwd, ["diff", "--summary"]), "pending.txt");
    const status = yield* driver.statusDetailsLocal(cwd);
    assert.equal(status.aheadCount, 0);
    assert.isTrue(status.hasWorkingTreeChanges);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("commits literal selected filenames instead of interpreting fileset metacharacters", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* fs.writeFileString(path.join(cwd, "a[1].txt"), "selected\n");
    yield* fs.writeFileString(path.join(cwd, "a1.txt"), "leave\n");
    const context = yield* driver.prepareCommitContext(cwd, ["a[1].txt"]);
    assert.include(context!.stagedPatch, "a[1].txt");
    assert.notInclude(context!.stagedPatch, "a1.txt");
    yield* driver.commit(cwd, "literal path", "", {
      stage: { filePaths: ["a[1].txt"] },
    });
    assert.include(jj(cwd, ["diff", "--summary"]), "a1.txt");
    assert.notInclude(jj(cwd, ["diff", "--summary"]), "a[1].txt");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("creates a bookmark at described @ rather than dropping its last commit", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* fs.writeFileString(path.join(cwd, "feature.txt"), "feature\n");
    jj(cwd, ["describe", "-m", "feature"]);
    const before = commitId(cwd, "@");
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    assert.equal(commitId(cwd, "feature"), before);
    assert.equal(commitId(cwd, "@"), before);
    assert.equal((yield* driver.statusDetailsLocal(cwd)).aheadOfDefaultCount, 1);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("renames the active bookmark while preserving its configured upstream", () =>
  Effect.gen(function* () {
    const { cwd, driver } = yield* remoteFixture;
    yield* driver.renameBranch({
      cwd,
      oldBranch: "main",
      newBranch: "renamed",
    });
    const status = yield* driver.statusDetailsLocal(cwd);
    assert.equal(status.branch, "renamed");
    assert.equal(status.upstreamRef, "origin/main");
    assert.equal((yield* driver.pullCurrentBranch(cwd)).status, "skipped_up_to_date");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("renaming an unrelated bookmark does not select it", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    yield* fs.writeFileString(path.join(cwd, "feature.txt"), "feature\n");
    yield* driver.commit(cwd, "feature", "");
    yield* driver.renameBranch({ cwd, oldBranch: "main", newBranch: "base" });
    assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "feature");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("switching from a bookmarked @ preserves the original commit", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* fs.writeFileString(path.join(cwd, "feature.txt"), "feature\n");
    jj(cwd, ["describe", "-m", "feature"]);
    jj(cwd, ["bookmark", "create", "feature", "-r", "@"]);
    const before = commitId(cwd, "feature");
    yield* driver.switchRef({ cwd, refName: "feature" });
    assert.equal(commitId(cwd, "@"), before);
    yield* driver.switchRef({ cwd, refName: "main" });
    assert.equal(commitId(cwd, "feature"), before);
    assert.isFalse(yield* fs.exists(path.join(cwd, "feature.txt")));
    assert.equal(commitId(cwd, "@-"), commitId(cwd, "main"));
  }).pipe(Effect.provide(TestLayer)),
);

itJj("surfaces jj's reason when switching to an invalid bookmark name", () =>
  Effect.gen(function* () {
    const { cwd, driver } = yield* fixture;
    const failure = yield* driver.createRef({ cwd, refName: "bad name" }).pipe(Effect.flip);
    assert.include(failure.message, "Failed to parse bookmark name");
    assert.notInclude(failure.message, "Jujutsu command failed.");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("commits selected files with jj and advances the selected bookmark", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "main");
    yield* fs.writeFileString(path.join(cwd, "selected.txt"), "selected\n");
    yield* fs.writeFileString(path.join(cwd, "left.txt"), "left\n");
    const context = yield* driver.prepareCommitContext(cwd, ["selected.txt"]);
    assert.include(context!.stagedPatch, "selected.txt");
    assert.notInclude(context!.stagedPatch, "left.txt");
    const committed = yield* driver.commit(cwd, "selected change", "", {
      stage: { filePaths: ["selected.txt"] },
    });
    assert.equal(
      jj(cwd, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]).trim(),
      committed.commitSha,
    );
    assert.include(jj(cwd, ["diff", "--summary"]), "left.txt");
    assert.notInclude(jj(cwd, ["diff", "--summary"]), "selected.txt");
    assert.notEqual(
      (yield* driver.execute({
        operation: "test",
        cwd,
        args: ["symbolic-ref", "--short", "HEAD"],
        allowNonZeroExit: true,
      })).exitCode,
      0,
    );
  }).pipe(Effect.provide(TestLayer)),
);

itJj("creates and switches bookmarks without discarding working-copy changes", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* fs.writeFileString(path.join(cwd, "pending.txt"), "pending\n");
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "feature");
    yield* driver.commit(cwd, "feature change", "");
    yield* fs.writeFileString(path.join(cwd, "uncommitted.txt"), "keep\n");
    yield* driver.switchRef({ cwd, refName: "main" });
    assert.equal(yield* fs.readFileString(path.join(cwd, "uncommitted.txt")), "keep\n");
    assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "main");
    assert.isFalse(yield* fs.exists(path.join(cwd, "pending.txt")));
  }).pipe(Effect.provide(TestLayer)),
);

itJj(
  "prefers a feature bookmark over the base branch when both sit on the working copy's parent",
  () =>
    Effect.gen(function* () {
      const { cwd, driver } = yield* fixture;
      jj(cwd, ["bookmark", "create", "feature", "-r", "@-"]);
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "feature");
      jj(cwd, ["bookmark", "create", "other", "-r", "@-"]);
      assert.isNull((yield* driver.statusDetailsLocal(cwd)).branch);
    }).pipe(Effect.provide(TestLayer)),
);

itJj("does not adopt the only bookmark on the parent when another workspace selected it", () =>
  Effect.gen(function* () {
    const { cwd, driver } = yield* fixture;
    const workspacePath = (yield* Path.Path).join(cwd, "siblings", "thread");
    yield* driver.createWorktree({
      cwd,
      refName: "main",
      newRefName: "thread",
      path: workspacePath,
    });
    jj(cwd, ["bookmark", "delete", "main"]);
    assert.isNull((yield* driver.statusDetailsLocal(cwd)).branch);
  }).pipe(Effect.provide(TestLayer)),
);

const reviewRange = (preview: {
  readonly sources: ReadonlyArray<{
    readonly kind: string;
    readonly baseRef?: string | null;
    readonly headRef?: string | null;
    readonly files?: ReadonlyArray<{ readonly path: string }>;
  }>;
}) => {
  const range = preview.sources.find((source) => source.kind === "branch-range");
  return {
    baseRef: range?.baseRef,
    headRef: range?.headRef,
    files: range?.files?.map((file) => file.path).sort(),
  };
};

itJj("reviews committed and uncommitted work against the base despite the detached Git HEAD", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    yield* fs.writeFileString(path.join(cwd, "committed.txt"), "committed\n");
    yield* driver.commit(cwd, "feature change", "");
    yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "dirty\n");
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    assert.deepEqual(reviewRange(preview), {
      baseRef: "main",
      headRef: "feature",
      files: ["committed.txt", "dirty.txt"],
    });
    const dirty = preview.sources.find((source) => source.kind === "working-tree");
    assert.deepEqual(
      dirty?.files?.map((file) => file.path),
      ["dirty.txt"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

itJj("reviews local commits and edits when the bookmark is the base branch and has not moved", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* fs.writeFileString(path.join(cwd, "local.txt"), "local\n");
    jj(cwd, ["commit", "-m", "local work"]);
    yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "dirty\n");
    assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "main");
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    assert.deepEqual(reviewRange(preview), {
      baseRef: "main",
      headRef: "main",
      files: ["dirty.txt", "local.txt"],
    });
    const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
    assert.deepEqual(status.branchChanges, { baseRef: "main", insertions: 2, deletions: 0 });
  }).pipe(Effect.provide(TestLayer)),
);

itJj("reviews every local commit when the selected bookmark lags behind them", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    yield* fs.writeFileString(path.join(cwd, "first.txt"), "first\n");
    yield* driver.commit(cwd, "first", "");
    yield* fs.writeFileString(path.join(cwd, "second.txt"), "second\n");
    jj(cwd, ["commit", "-m", "second"]);
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    assert.deepEqual(reviewRange(preview), {
      baseRef: "main",
      headRef: "feature",
      files: ["first.txt", "second.txt"],
    });
  }).pipe(Effect.provide(TestLayer)),
);

itJj("uses the configured worktree directory for native jj workspaces", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-custom-worktrees-" });
    const result = yield* driver.createWorktree(
      {
        cwd,
        refName: "main",
        newRefName: "custom-thread",
        path: null,
      },
      { worktreesDirectory: parent },
    );
    assert.equal(result.worktree.path, path.join(parent, path.basename(cwd), "custom-thread"));
    assert.isTrue(yield* fs.exists(path.join(result.worktree.path, ".jj")));
    assert.equal((yield* driver.statusDetailsLocal(result.worktree.path)).branch, "custom-thread");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("creates native jj thread workspaces and lists their selected bookmarks", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.listRefs({ cwd });
    const workspacePath = path.join(cwd, "siblings", "thread");
    yield* driver.createWorktree({
      cwd,
      refName: "main",
      newRefName: "thread",
      path: workspacePath,
    });
    assert.isTrue(yield* fs.exists(path.join(workspacePath, ".jj")));
    assert.equal((yield* driver.statusDetailsLocal(workspacePath)).branch, "thread");
    const refs = yield* driver.listRefs({ cwd });
    assert.equal(refs.refs.find((ref) => ref.name === "thread")?.worktreePath, workspacePath);
    yield* driver.removeWorktree({ cwd, path: workspacePath });
    assert.isFalse(yield* fs.exists(workspacePath));
    assert.notInclude(jj(cwd, ["workspace", "list", "-T", 'name ++ "\\n"']), "thread");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pushes the selected bookmark through jj", () =>
  Effect.gen(function* () {
    const { fs, cwd, driver } = yield* fixture;
    const remote = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-remote-",
    });
    yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["init", "--bare"],
    });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    const pushed = yield* driver.pushCurrentBranch(cwd, "main");
    assert.equal(pushed.branch, "main");
    const remoteCommit = (yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["rev-parse", "refs/heads/main"],
    })).stdout.trim();
    assert.equal(
      remoteCommit,
      jj(cwd, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]).trim(),
    );
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pushes to the configured publishing remote", () =>
  Effect.gen(function* () {
    const { fs, cwd, driver } = yield* fixture;
    const origin = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-origin-",
    });
    const publish = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-publish-",
    });
    for (const remote of [origin, publish]) {
      yield* driver.execute({
        operation: "test",
        cwd: remote,
        args: ["init", "--bare"],
      });
    }
    jj(cwd, ["git", "remote", "add", "origin", origin]);
    jj(cwd, ["git", "remote", "add", "publish", publish]);
    yield* driver.execute({
      operation: "test",
      cwd,
      args: ["config", "remote.pushDefault", "publish"],
    });
    const pushed = yield* driver.pushCurrentBranch(cwd, "main");
    assert.equal(pushed.upstreamBranch, "publish/main");
    const originRefs = (yield* driver.execute({
      operation: "test",
      cwd: origin,
      args: ["for-each-ref", "refs/heads"],
    })).stdout.trim();
    assert.equal(originRefs, "");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pulls remote commits with jj and retains working-copy changes", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const remote = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-pull-remote-",
    });
    yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["init", "--bare"],
    });
    yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["symbolic-ref", "HEAD", "refs/heads/main"],
    });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    yield* driver.pushCurrentBranch(cwd, "main");
    const cloneParent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-pull-clone-",
    });
    const clone = path.join(cloneParent, "repo");
    jj(cloneParent, ["git", "clone", "--colocate", remote, clone]);
    yield* fs.writeFileString(path.join(clone, "remote.txt"), "remote\n");
    jj(clone, ["commit", "-m", "remote change"]);
    jj(clone, ["bookmark", "set", "main", "-r", "@-"]);
    jj(clone, ["git", "push", "--bookmark", "main"]);
    yield* fs.writeFileString(path.join(cwd, "local.txt"), "keep\n");
    const pulled = yield* driver.pullCurrentBranch(cwd);
    assert.equal(pulled.status, "pulled");
    assert.equal(yield* fs.readFileString(path.join(cwd, "local.txt")), "keep\n");
    assert.equal(yield* fs.readFileString(path.join(cwd, "remote.txt")), "remote\n");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("retains checkpoint capture and restore when the jj driver is selected", () =>
  Effect.gen(function* () {
    const { fs, path, cwd } = yield* fixture;
    const driver = yield* JujutsuVcsDriver.make;
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/jj-test");
    yield* fs.writeFileString(path.join(cwd, "base.txt"), "snapshot\n");
    yield* driver.checkpoints!.captureCheckpoint({ cwd, checkpointRef });
    yield* fs.writeFileString(path.join(cwd, "base.txt"), "later\n");
    yield* driver.checkpoints!.restoreCheckpoint({ cwd, checkpointRef });
    assert.equal(yield* fs.readFileString(path.join(cwd, "base.txt")), "snapshot\n");
    assert.isTrue(yield* fs.exists(path.join(cwd, ".jj")));
  }).pipe(Effect.provide(TestLayer)),
);

itJj("reports bookmark commits ahead of the default branch so Create PR stays available", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    yield* fs.writeFileString(path.join(cwd, "feature.txt"), "feature\n");
    yield* driver.commit(cwd, "feature change", "");
    const status = yield* driver.status({ cwd });
    assert.equal(status.refName, "feature");
    assert.equal(status.aheadOfDefaultCount, 1);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pulls from the upstream that push recorded", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const origin = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-pull-origin-",
    });
    const publish = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-pull-publish-",
    });
    for (const remote of [origin, publish]) {
      yield* driver.execute({
        operation: "test",
        cwd: remote,
        args: ["init", "--bare"],
      });
    }
    yield* driver.execute({
      operation: "test",
      cwd: publish,
      args: ["symbolic-ref", "HEAD", "refs/heads/main"],
    });
    jj(cwd, ["git", "remote", "add", "origin", origin]);
    jj(cwd, ["git", "remote", "add", "publish", publish]);
    yield* driver.pushCurrentBranch(cwd, "main", { remoteName: "publish" });
    const cloneParent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-pull-publish-clone-",
    });
    const clone = path.join(cloneParent, "repo");
    jj(cloneParent, ["git", "clone", "--colocate", publish, clone]);
    yield* fs.writeFileString(path.join(clone, "remote.txt"), "remote\n");
    jj(clone, ["commit", "-m", "remote change"]);
    jj(clone, ["bookmark", "set", "main", "-r", "@-"]);
    jj(clone, ["git", "push", "--bookmark", "main"]);
    const pulled = yield* driver.pullCurrentBranch(cwd);
    assert.equal(pulled.status, "pulled");
    assert.equal(pulled.upstreamRef, "publish/main");
    assert.equal(yield* fs.readFileString(path.join(cwd, "remote.txt")), "remote\n");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("never resets an existing branch when the requested branch is checked out elsewhere", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    // Colocated repositories use jj unless `.t3code/vcs.json` pins git.
    yield* fs.makeDirectory(path.join(cwd, ".t3code"), { recursive: true });
    yield* fs.writeFileString(path.join(cwd, ".t3code", "vcs.json"), '{"vcs":{"kind":"git"}}');
    yield* fs.writeFileString(path.join(cwd, "second.txt"), "second\n");
    jj(cwd, ["commit", "-m", "second"]);
    const head = (yield* driver.execute({
      operation: "test",
      cwd,
      args: ["rev-parse", "HEAD"],
    })).stdout.trim();
    yield* driver.execute({
      operation: "test",
      cwd,
      args: ["branch", "feature/x", head],
    });
    yield* driver.execute({
      operation: "test",
      cwd,
      args: ["branch", "feature-x", `${head}~1`],
    });
    const featureX = (yield* driver.execute({
      operation: "test",
      cwd,
      args: ["rev-parse", "feature-x"],
    })).stdout.trim();
    yield* driver.execute({
      operation: "test",
      cwd,
      args: ["worktree", "add", path.join(cwd, "siblings", "plain"), "feature/x"],
    });
    const created = yield* Effect.exit(
      driver.createWorktree({
        cwd,
        refName: "feature/x",
        path: path.join(cwd, "siblings", "thread"),
      }),
    );
    assert.isTrue(created._tag === "Failure");
    const after = (yield* driver.execute({
      operation: "test",
      cwd,
      args: ["rev-parse", "feature-x"],
    })).stdout.trim();
    assert.equal(after, featureX);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("fetches the bookmark upstream before it reports remote status", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const remote = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-status-remote-",
    });
    yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["init", "--bare"],
    });
    yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["symbolic-ref", "HEAD", "refs/heads/main"],
    });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    yield* driver.pushCurrentBranch(cwd, "main");
    const cloneParent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-jj-status-clone-",
    });
    const clone = path.join(cloneParent, "repo");
    jj(cloneParent, ["git", "clone", "--colocate", remote, clone]);
    yield* fs.writeFileString(path.join(clone, "remote.txt"), "remote\n");
    jj(clone, ["commit", "-m", "remote change"]);
    jj(clone, ["bookmark", "set", "main", "-r", "@-"]);
    jj(clone, ["git", "push", "--bookmark", "main"]);
    const status = yield* driver.statusDetailsRemote(cwd);
    assert.equal(status.behindCount, 1);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("does not prepare empty jj commits, including an unchanged file selection", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    assert.equal(yield* driver.prepareCommitContext(cwd), null);
    yield* fs.writeFileString(path.join(cwd, "other.txt"), "changed\n");
    assert.equal(yield* driver.prepareCommitContext(cwd, ["base.txt"]), null);
    assert.isNotNull(yield* driver.prepareCommitContext(cwd));
  }).pipe(Effect.provide(TestLayer)),
);

itJj("invalidates jj status caches after a Git compatibility remote mutation", () =>
  Effect.gen(function* () {
    const { fs, cwd, driver } = yield* fixture;
    assert.isFalse((yield* driver.statusDetails(cwd)).hasOriginRemote);
    yield* driver.listRefs({ cwd });
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-cache-remote-" });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    yield* driver.ensureRemote({ cwd, preferredName: "origin", url: remote });
    assert.isTrue((yield* driver.statusDetails(cwd)).hasOriginRemote);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("preserves the detected default branch in remote status", () =>
  Effect.gen(function* () {
    const { fs, cwd, driver } = yield* fixture;
    jj(cwd, ["bookmark", "rename", "main", "develop"]);
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-default-remote-" });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    yield* driver.execute({
      operation: "test",
      cwd: remote,
      args: ["symbolic-ref", "HEAD", "refs/heads/develop"],
    });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    yield* driver.pushCurrentBranch(cwd, "develop");
    yield* driver.execute({
      operation: "test",
      cwd,
      args: ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"],
    });
    const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
    assert.equal(status.defaultBranch, "develop");
    assert.isTrue(status.isDefaultBranch);
  }).pipe(Effect.provide(TestLayer)),
);

itJj("allows unrelated repositories to mutate while one fetch is waiting", () =>
  Effect.gen(function* () {
    const first = yield* fixture;
    const second = yield* fixture;
    const process = yield* VcsProcess.VcsProcess;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const driver = yield* GitVcsDriver.make.pipe(
      Effect.provide(ServerConfig.layerTest(first.cwd, { prefix: "t3-jj-lock-config-" })),
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          input.cwd === first.cwd && input.args.includes("fetch")
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
              )
            : process.run(input),
      }),
    );
    const fetch = yield* driver
      .fetchRemote({ cwd: first.cwd, remoteName: "origin" })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* driver.createRef({ cwd: second.cwd, refName: "independent" });
    assert.equal(commitId(second.cwd, "independent"), commitId(second.cwd, "main"));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fetch);
  }).pipe(Effect.provide(TestLayer)),
);

for (const described of [true, false]) {
  itJj(`preserves an existing ${described ? "described" : "bookmarked"} working-copy commit`, () =>
    Effect.gen(function* () {
      const { fs, path, cwd, driver } = yield* fixture;
      yield* fs.writeFileString(path.join(cwd, "existing.txt"), "already committed\n");
      if (described) jj(cwd, ["describe", "-m", "user authored message"]);
      else jj(cwd, ["bookmark", "create", "existing", "-r", "@"]);
      const before = commitId(cwd, "@");
      assert.equal(yield* driver.prepareCommitContext(cwd), null);
      const failure = yield* driver.commit(cwd, "generated replacement", "").pipe(Effect.flip);
      assert.include(failure.detail, "already a commit");
      assert.equal(commitId(cwd, "@"), before);
      assert.equal(
        jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "description"]).trim(),
        described ? "user authored message" : "",
      );
    }).pipe(Effect.provide(TestLayer)),
  );
}

for (const newRefName of ["main", "bad name"]) {
  itJj(`cleans up jj workspace setup failure for ${newRefName}`, () =>
    Effect.gen(function* () {
      const { fs, path, cwd, driver } = yield* fixture;
      const directory = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-failed-workspace-" }),
        "workspace",
      );
      const before = jj(cwd, ["workspace", "list"]);
      yield* driver
        .createWorktree({ cwd, refName: "main", newRefName, path: directory })
        .pipe(Effect.flip);
      assert.equal(jj(cwd, ["workspace", "list"]), before);
      assert.isFalse(yield* fs.exists(directory));
      // A corrected request can immediately reuse the same destination.
      yield* driver.createWorktree({ cwd, refName: "main", newRefName: "retry", path: directory });
      assert.isTrue(yield* fs.exists(path.join(directory, ".jj")));
    }).pipe(Effect.provide(TestLayer)),
  );
}
