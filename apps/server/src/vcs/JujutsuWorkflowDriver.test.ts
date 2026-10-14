// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { CheckpointRef } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JujutsuVcsDriver from "./JujutsuVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

process.env.JJ_USER ??= "T3 Tests";
process.env.JJ_EMAIL ??= "t3-tests@example.com";
const jj = (cwd: string, args: readonly string[]) => NodeChildProcess.execFileSync("jj", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const available = (() => { try { jj(process.cwd(), ["--version"]); return true; } catch { return false; } })();
const itJj = it.effect.skipIf(!available);
const TestLayer = VcsProcess.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest({ versionControlSystem: "jj" })),
  Layer.provideMerge(NodeServices.layer),
);
const GitModeLayer = VcsProcess.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest({ versionControlSystem: "git" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-workflow-" });
  jj(cwd, ["git", "init", "--colocate"]);
  yield* fs.writeFileString(path.join(cwd, "base.txt"), "base\n");
  jj(cwd, ["describe", "-m", "initial"]);
  jj(cwd, ["new"]);
  jj(cwd, ["bookmark", "create", "main", "-r", "@-"]);
  const driver = yield* GitVcsDriver.make.pipe(Effect.provide(ServerConfig.layerTest(cwd, {
    prefix: "t3-jj-workflow-config-",
  })));
  return { fs, path, cwd, driver };
});

itJj("commits selected files with jj and advances the selected bookmark", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "main");
    yield* fs.writeFileString(path.join(cwd, "selected.txt"), "selected\n");
    yield* fs.writeFileString(path.join(cwd, "left.txt"), "left\n");
    const context = yield* driver.prepareCommitContext(cwd, ["selected.txt"]);
    assert.include(context!.stagedPatch, "selected.txt");
    assert.notInclude(context!.stagedPatch, "left.txt");
    const committed = yield* driver.commit(cwd, "selected change", "", { filePaths: ["selected.txt"] });
    assert.equal(jj(cwd, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]).trim(), committed.commitSha);
    assert.include(jj(cwd, ["diff", "--summary"]), "left.txt");
    assert.notInclude(jj(cwd, ["diff", "--summary"]), "selected.txt");
    assert.notEqual((yield* driver.execute({ operation: "test", cwd,
      args: ["symbolic-ref", "--short", "HEAD"], allowNonZeroExit: true })).exitCode, 0);
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

itJj("prefers a feature bookmark over the base branch when both sit on the working copy's parent", () =>
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
    yield* driver.createWorktree({ cwd, refName: "main", newRefName: "thread", path: workspacePath });
    jj(cwd, ["bookmark", "delete", "main"]);
    assert.isNull((yield* driver.statusDetailsLocal(cwd)).branch);
  }).pipe(Effect.provide(TestLayer)),
);

const reviewRange = (preview: { readonly sources: ReadonlyArray<{ readonly kind: string; readonly baseRef?: string | null; readonly headRef?: string | null; readonly files?: ReadonlyArray<{ readonly path: string }> }> }) => {
  const range = preview.sources.find((source) => source.kind === "branch-range");
  return { baseRef: range?.baseRef, headRef: range?.headRef, files: range?.files?.map((file) => file.path).sort() };
};

itJj("reviews committed and uncommitted work against the base despite the detached Git HEAD", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.createRef({ cwd, refName: "feature", switchRef: true });
    yield* fs.writeFileString(path.join(cwd, "committed.txt"), "committed\n");
    yield* driver.commit(cwd, "feature change", "");
    yield* fs.writeFileString(path.join(cwd, "dirty.txt"), "dirty\n");
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    assert.deepEqual(reviewRange(preview), { baseRef: "main", headRef: "feature", files: ["committed.txt", "dirty.txt"] });
    const dirty = preview.sources.find((source) => source.kind === "working-tree");
    assert.deepEqual(dirty?.files?.map((file) => file.path), ["dirty.txt"]);
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
    assert.deepEqual(reviewRange(preview), { baseRef: "main", headRef: "main", files: ["dirty.txt", "local.txt"] });
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
    assert.deepEqual(reviewRange(preview), { baseRef: "main", headRef: "feature", files: ["first.txt", "second.txt"] });
  }).pipe(Effect.provide(TestLayer)),
);

itJj("creates native jj thread workspaces and lists their selected bookmarks", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    yield* driver.listRefs({ cwd });
    const workspacePath = path.join(cwd, "siblings", "thread");
    yield* driver.createWorktree({ cwd, refName: "main", newRefName: "thread", path: workspacePath });
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
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-remote-" });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    const pushed = yield* driver.pushCurrentBranch(cwd, "main");
    assert.equal(pushed.branch, "main");
    const remoteCommit = (yield* driver.execute({ operation: "test", cwd: remote,
      args: ["rev-parse", "refs/heads/main"] })).stdout.trim();
    assert.equal(remoteCommit, jj(cwd, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]).trim());
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pushes to the configured publishing remote", () =>
  Effect.gen(function* () {
    const { fs, cwd, driver } = yield* fixture;
    const origin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-origin-" });
    const publish = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-publish-" });
    for (const remote of [origin, publish]) {
      yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    }
    jj(cwd, ["git", "remote", "add", "origin", origin]);
    jj(cwd, ["git", "remote", "add", "publish", publish]);
    yield* driver.execute({ operation: "test", cwd, args: ["config", "remote.pushDefault", "publish"] });
    const pushed = yield* driver.pushCurrentBranch(cwd, "main");
    assert.equal(pushed.upstreamBranch, "publish/main");
    const originRefs = (yield* driver.execute({ operation: "test", cwd: origin,
      args: ["for-each-ref", "refs/heads"] })).stdout.trim();
    assert.equal(originRefs, "");
  }).pipe(Effect.provide(TestLayer)),
);

itJj("pulls remote commits with jj and retains working-copy changes", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-pull-remote-" });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["symbolic-ref", "HEAD", "refs/heads/main"] });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    yield* driver.pushCurrentBranch(cwd, "main");
    const cloneParent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-pull-clone-" });
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
    const origin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-pull-origin-" });
    const publish = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-pull-publish-" });
    for (const remote of [origin, publish]) {
      yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    }
    yield* driver.execute({ operation: "test", cwd: publish, args: ["symbolic-ref", "HEAD", "refs/heads/main"] });
    jj(cwd, ["git", "remote", "add", "origin", origin]);
    jj(cwd, ["git", "remote", "add", "publish", publish]);
    yield* driver.pushCurrentBranch(cwd, "main", { remoteName: "publish" });
    const cloneParent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-pull-publish-clone-" });
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
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    yield* fs.writeFileString(path.join(cwd, ".t3code", "vcs.json"), JSON.stringify({ vcs: { kind: "git" } }));
    yield* fs.writeFileString(path.join(cwd, "second.txt"), "second\n");
    jj(cwd, ["commit", "-m", "second"]);
    const head = (yield* driver.execute({ operation: "test", cwd, args: ["rev-parse", "HEAD"] })).stdout.trim();
    yield* driver.execute({ operation: "test", cwd, args: ["branch", "feature/x", head] });
    yield* driver.execute({ operation: "test", cwd, args: ["branch", "feature-x", `${head}~1`] });
    const featureX = (yield* driver.execute({ operation: "test", cwd, args: ["rev-parse", "feature-x"] })).stdout.trim();
    yield* driver.execute({ operation: "test", cwd,
      args: ["worktree", "add", path.join(cwd, "siblings", "plain"), "feature/x"] });
    const created = yield* Effect.exit(
      driver.createWorktree({ cwd, refName: "feature/x", path: path.join(cwd, "siblings", "thread") }),
    );
    assert.isTrue(created._tag === "Failure");
    const after = (yield* driver.execute({ operation: "test", cwd, args: ["rev-parse", "feature-x"] })).stdout.trim();
    assert.equal(after, featureX);
  }).pipe(Effect.provide(GitModeLayer)),
);

itJj("fetches the bookmark upstream before it reports remote status", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, driver } = yield* fixture;
    const remote = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-status-remote-" });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["init", "--bare"] });
    yield* driver.execute({ operation: "test", cwd: remote, args: ["symbolic-ref", "HEAD", "refs/heads/main"] });
    jj(cwd, ["git", "remote", "add", "origin", remote]);
    yield* driver.pushCurrentBranch(cwd, "main");
    const cloneParent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-status-clone-" });
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

