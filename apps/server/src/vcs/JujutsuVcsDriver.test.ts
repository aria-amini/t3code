// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";

import { ServerConfig } from "../config.ts";
import * as JujutsuVcsDriver from "./JujutsuVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

process.env.JJ_USER ??= "T3 Tests";
process.env.JJ_EMAIL ??= "t3-tests@example.com";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
	prefix: "t3-jj-vcs-driver-test-",
});
const TestLayer = JujutsuVcsDriver.layer.pipe(
	Layer.provide(ServerConfigLayer),
	Layer.provide(VcsProcess.layer),
	Layer.provideMerge(NodeServices.layer),
);

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

const makeTmpDir = (
	prefix = "jj-vcs-driver-test-",
): Effect.Effect<
	string,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Scope.Scope
> =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem.FileSystem;
		return yield* fileSystem.makeTempDirectoryScoped({ prefix });
	});

const writeTextFile = (
	cwd: string,
	relativePath: string,
	contents: string,
): Effect.Effect<
	void,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem.FileSystem;
		const pathService = yield* Path.Path;
		const filePath = pathService.join(cwd, relativePath);
		yield* fileSystem.makeDirectory(pathService.dirname(filePath), {
			recursive: true,
		});
		yield* fileSystem.writeFileString(filePath, contents);
	});

const jjSync = (cwd: string, args: ReadonlyArray<string>): void => {
	NodeChildProcess.execFileSync("jj", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
};

describe("JujutsuVcsDriver", () => {
	itJj("reports non-repository directories without failing", () =>
		Effect.gen(function* () {
			const cwd = yield* makeTmpDir();
			const driver = yield* JujutsuVcsDriver.JujutsuVcsDriver;

			assert.equal(yield* driver.detectRepository(cwd), null);
			assert.equal(yield* driver.isInsideWorkTree(cwd), false);
		}).pipe(Effect.provide(TestLayer)),
	);

	itJj("detects a native jj repository", () =>
		Effect.gen(function* () {
			const cwd = yield* makeTmpDir();
			const driver = yield* JujutsuVcsDriver.JujutsuVcsDriver;
			yield* driver.initRepository({ cwd, kind: "jj" });

			const repository = yield* driver.detectRepository(cwd);

			assert.notEqual(repository, null);
			assert.equal(repository?.kind, "jj");
			assert.equal(repository?.rootPath, cwd);
			assert.isTrue(repository?.metadataPath?.endsWith("/.jj") ?? false);
			assert.equal(yield* driver.isInsideWorkTree(cwd), true);
		}).pipe(Effect.provide(TestLayer)),
	);

	itJj("lists workspace files including new snapshots", () =>
		Effect.gen(function* () {
			const cwd = yield* makeTmpDir();
			const driver = yield* JujutsuVcsDriver.JujutsuVcsDriver;
			yield* driver.initRepository({ cwd, kind: "jj" });
			yield* writeTextFile(cwd, "src/hello.ts", "export const hello = 1;\n");

			const files = yield* driver.listWorkspaceFiles(cwd);

			assert.equal(files.truncated, false);
			assert.include(files.paths, "src/hello.ts");
		}).pipe(Effect.provide(TestLayer)),
	);

	itJj("creates, lists, and removes a workspace", () =>
		Effect.gen(function* () {
			const cwd = yield* makeTmpDir();
			const driver = yield* JujutsuVcsDriver.JujutsuVcsDriver;
			yield* driver.initRepository({ cwd, kind: "jj" });
			const pathService = yield* Path.Path;
			const workspacePath = pathService.join(
				cwd,
				"..",
				"jj-vcs-driver-test-ws-agent",
			);

			const created = yield* driver.createWorkspace({
				cwd,
				name: "agent",
				path: workspacePath,
			});
			assert.equal(created.name, "agent");

			const listed = yield* driver.listWorkspaces(cwd);
			const agent = listed.workspaces.find(
				(workspace) => workspace.name === "agent",
			);
			assert.notEqual(agent, undefined);

			yield* driver.removeWorkspace({
				cwd,
				name: "agent",
				deleteDirectory: true,
			});

			const afterRemoval = yield* driver.listWorkspaces(cwd);
			assert.equal(
				afterRemoval.workspaces.find((workspace) => workspace.name === "agent"),
				undefined,
			);
		}).pipe(Effect.provide(TestLayer)),
	);

	itJj("parses remotes added to the repo", () =>
		Effect.gen(function* () {
			const cwd = yield* makeTmpDir();
			const remoteDir = yield* makeTmpDir("jj-vcs-driver-test-remote-");
			const driver = yield* JujutsuVcsDriver.JujutsuVcsDriver;
			yield* driver.initRepository({ cwd, kind: "jj" });
			jjSync(cwd, ["git", "remote", "add", "origin", remoteDir]);

			const remotes = yield* driver.listRemotes(cwd);

			assert.equal(remotes.remotes.length, 1);
			assert.equal(remotes.remotes[0]?.name, "origin");
			assert.equal(remotes.remotes[0]?.isPrimary, true);
		}).pipe(Effect.provide(TestLayer)),
	);

	itJj("keeps tracked files and drops ignored paths from the filter", () =>
		Effect.gen(function* () {
			const cwd = yield* makeTmpDir();
			const driver = yield* JujutsuVcsDriver.JujutsuVcsDriver;
			yield* driver.initRepository({ cwd, kind: "jj" });
			yield* writeTextFile(cwd, "tracked.ts", "export const tracked = 1;\n");
			yield* writeTextFile(cwd, "src/nested.ts", "export const nested = 1;\n");

			const filtered = yield* driver.filterIgnoredPaths(cwd, [
				"tracked.ts",
				"src",
				"does-not-exist.bin",
			]);

			assert.include(filtered as string[], "tracked.ts");
			assert.include(filtered as string[], "src");
			assert.equal(filtered.includes("does-not-exist.bin"), false);
		}).pipe(Effect.provide(TestLayer)),
	);
});
