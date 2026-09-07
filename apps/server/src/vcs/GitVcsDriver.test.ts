// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
	prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(
	GitVcsDriver.vcsLayer,
	GitVcsDriver.layer,
).pipe(
	Layer.provide(ServerConfigLayer),
	Layer.provideMerge(VcsProcess.layer),
	Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const driver = yield* GitVcsDriver.GitVcsDriver;
		yield* driver.execute({
			operation: "GitVcsDriver.contract.git",
			cwd,
			args,
			timeoutMs: 10_000,
		});
	});

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
	name: "Git",
	kind: "git",
	layer: GitContractLayer,
	fixture: {
		createRepo: (cwd) =>
			Effect.gen(function* () {
				yield* runGit(cwd, ["init"]);
				yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
				yield* runGit(cwd, ["config", "user.name", "Test"]);
			}),
		writeFile: (cwd, relativePath, contents) =>
			Effect.gen(function* () {
				const fileSystem = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const absolutePath = path.join(cwd, relativePath);
				yield* fileSystem.makeDirectory(path.dirname(absolutePath), {
					recursive: true,
				});
				yield* fileSystem.writeFileString(absolutePath, contents);
			}),
		trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
		commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
		ignorePath: (cwd, pattern) =>
			Effect.gen(function* () {
				const fileSystem = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				yield* fileSystem.writeFileString(
					path.join(cwd, ".gitignore"),
					`${pattern}\n`,
				);
			}),
	},
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
	let observedEnv: NodeJS.ProcessEnv | undefined;
	let observedAppendTruncationMarker: boolean | undefined;
	let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

	return Effect.gen(function* () {
		const driver = yield* GitVcsDriver.makeVcsDriverShape();

		yield* driver.execute({
			operation: "GitVcsDriver.test.env",
			cwd: "/repo",
			args: ["status"],
			env: {
				GIT_INDEX_FILE: "/tmp/t3-index",
			},
			appendTruncationMarker: true,
			outputMode: "error",
		});

		assert.deepStrictEqual(observedEnv, {
			GIT_INDEX_FILE: "/tmp/t3-index",
		});
		assert.strictEqual(observedAppendTruncationMarker, true);
		assert.strictEqual(observedOutputMode, "error");
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				NodeServices.layer,
				Layer.mock(VcsProcess.VcsProcess)({
					run: (input) =>
						Effect.sync(() => {
							observedEnv = input.env;
							observedAppendTruncationMarker = input.appendTruncationMarker;
							observedOutputMode = input.outputMode;
							return {
								exitCode: ChildProcessSpawner.ExitCode(0),
								stdout: "",
								stderr: "",
								stdoutTruncated: false,
								stderrTruncated: false,
							};
						}),
				}),
			),
		),
	);
});

process.env.JJ_USER ??= "T3 Tests";
process.env.JJ_EMAIL ??= "t3-tests@example.com";

const jjBinaryAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("jj", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
})();

const itJj = it.effect.skipIf(!jjBinaryAvailable);

const DriverShapeLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeColocatedRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-git-vcs-colocated-",
  });
  yield* Effect.sync(() => {
    NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  });
  return root;
});

itJj(
  "git driver manages jj workspaces in colocated repositories",
  () =>
    Effect.gen(function* () {
      const root = yield* makeColocatedRepo;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { createWorkspace, listWorkspaces, removeWorkspace } = driver;
      if (!createWorkspace || !listWorkspaces || !removeWorkspace) {
        throw new Error("colocated git driver is missing jj workspace ops");
      }
      const workspacePath = path.join(root, "siblings", "agent");

      const created = yield* createWorkspace({
        cwd: root,
        name: "agent",
        path: workspacePath,
      });
      assert.equal(created.name, "agent");
      assert.isTrue(yield* fileSystem.exists(path.join(workspacePath, ".jj")));

      const listed = yield* listWorkspaces(root);
      assert.deepEqual(
        listed.workspaces.map((workspace) => workspace.name).sort(),
        ["agent", "default"],
      );

      yield* removeWorkspace({ cwd: root, name: "agent", deleteDirectory: true });
      assert.isFalse(yield* fileSystem.exists(workspacePath));
    }).pipe(Effect.provide(DriverShapeLayer)),
);

it.effect(
  "git driver rejects jj workspace ops outside colocated repositories",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-vcs-plain-",
      });
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const createWorkspace = driver.createWorkspace;
      if (!createWorkspace) {
        throw new Error("git driver is missing jj workspace ops");
      }

      const error = yield* createWorkspace({
        cwd: root,
        name: "agent",
        path: path.join(root, "wt"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "VcsUnsupportedOperationError");
    }).pipe(Effect.provide(DriverShapeLayer)),
);
