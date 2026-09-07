import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
	type VcsCreateWorkspaceInput,
	type VcsDriverCapabilities,
	type VcsInitInput,
	type VcsListRemotesResult,
	type VcsListWorkspaceFilesResult,
	type VcsRemoveWorkspaceInput,
	type VcsRepositoryIdentity,
	VcsProcessExitError,
	type VcsError,
	type VcsListWorkspacesResult,
	type VcsWorkspace,
} from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsDriver from "./VcsDriver.ts";
import {
	makeJujutsuWorkspaceOps,
	type JujutsuWorkspaceOps,
} from "./JujutsuWorkspaces.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 1_000_000;

export class JujutsuVcsDriver extends Context.Service<
	JujutsuVcsDriver,
	{
		readonly capabilities: VcsDriverCapabilities;
		readonly execute: (
			input: Omit<VcsProcess.VcsProcessInput, "command">,
		) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
		readonly detectRepository: (
			cwd: string,
		) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
		readonly isInsideWorkTree: (
			cwd: string,
		) => Effect.Effect<boolean, VcsError>;
		readonly listWorkspaceFiles: (
			cwd: string,
		) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
		readonly listRemotes: (
			cwd: string,
		) => Effect.Effect<VcsListRemotesResult, VcsError>;
		readonly filterIgnoredPaths: (
			cwd: string,
			relativePaths: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyArray<string>, VcsError>;
		readonly initRepository: (
			input: VcsInitInput,
		) => Effect.Effect<void, VcsError>;
		readonly createWorkspace: (
			input: VcsCreateWorkspaceInput,
		) => Effect.Effect<VcsWorkspace, VcsError>;
		readonly listWorkspaces: (
			cwd: string,
		) => Effect.Effect<VcsListWorkspacesResult, VcsError>;
		readonly removeWorkspace: (
			input: VcsRemoveWorkspaceInput,
		) => Effect.Effect<void, VcsError>;
	}
>()("t3/vcs/JujutsuVcsDriver") {}

const nowFreshness = Effect.fn("JujutsuVcsDriver.nowFreshness")(function* () {
	const now = yield* DateTime.now;
	return {
		source: "live-local" as const,
		observedAt: now,
		expiresAt: Option.none(),
	};
});

export const makeJujutsuVcsDriverShape = Effect.fn("makeJujutsuVcsDriverShape")(
	function* () {
		const path = yield* Path.Path;
		const vcsProcess = yield* VcsProcess.VcsProcess;
		const jjWorkspaces: JujutsuWorkspaceOps = yield* makeJujutsuWorkspaceOps();

		const capabilities: VcsDriverCapabilities = {
			kind: "jj",
			supportsWorktrees: true,
			supportsBookmarks: true,
			supportsAtomicSnapshot: true,
			supportsPushDefaultRemote: false,
			ignoreClassifier: "native",
		};

		const jjCommand = (
			operation: string,
			cwd: string,
			args: ReadonlyArray<string>,
			options: {
				readonly allowNonZeroExit?: boolean;
				readonly timeoutMs?: number;
				readonly maxOutputBytes?: number;
				readonly appendTruncationMarker?: boolean;
				readonly stdin?: string;
				readonly env?: NodeJS.ProcessEnv;
			} = {},
		) =>
			vcsProcess.run({
				operation,
				command: "jj",
				args: ["--no-pager", ...args],
				cwd,
				...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
				...(options.env !== undefined ? { env: options.env } : {}),
				...(options.allowNonZeroExit !== undefined
					? { allowNonZeroExit: options.allowNonZeroExit }
					: {}),
				...(options.timeoutMs !== undefined
					? { timeoutMs: options.timeoutMs }
					: {}),
				...(options.maxOutputBytes !== undefined
					? { maxOutputBytes: options.maxOutputBytes }
					: {}),
				...(options.appendTruncationMarker !== undefined
					? { appendTruncationMarker: options.appendTruncationMarker }
					: {}),
			});

		const exitError =
			(operation: string, cwd: string, args: ReadonlyArray<string>) =>
			(result: { readonly exitCode: number; readonly stderr: string }) =>
				new VcsProcessExitError({
					operation,
					command: "jj",
					cwd,
					argumentCount: args.length,
					exitCode: result.exitCode,
					detail: result.stderr.trim() || "jj command failed",
				});

		const workspaceRoot = (operation: string, cwd: string) =>
			jjCommand(operation, cwd, ["workspace", "root"], {
				allowNonZeroExit: true,
				timeoutMs: 5_000,
				maxOutputBytes: 16_000,
			});

		const isInsideWorkTree: JujutsuVcsDriver["Service"]["isInsideWorkTree"] = (
			cwd,
		) =>
			workspaceRoot("JujutsuVcsDriver.isInsideWorkTree", cwd).pipe(
				Effect.map((result) => result.exitCode === 0),
			);

		const detectRepository: JujutsuVcsDriver["Service"]["detectRepository"] =
			Effect.fn("detectRepository")(function* (cwd) {
				if (!(yield* isInsideWorkTree(cwd))) {
					return null;
				}
				const root = yield* workspaceRoot(
					"JujutsuVcsDriver.detectRepository.root",
					cwd,
				);
				const rootPath = root.stdout.trim();
				if (rootPath.length === 0) {
					return null;
				}
				return {
					kind: "jj" as const,
					rootPath,
					// A colocated repo carries a .git directory, so auto detection claims
					// it for the git driver; metadataPath distinguishes the layouts.
					metadataPath: path.join(rootPath, ".jj"),
					freshness: yield* nowFreshness(),
				};
			});

		const execute: JujutsuVcsDriver["Service"]["execute"] = (input) =>
			jjCommand(input.operation, input.cwd, input.args, {
				...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
				...(input.env !== undefined ? { env: input.env } : {}),
				...(input.allowNonZeroExit !== undefined
					? { allowNonZeroExit: input.allowNonZeroExit }
					: {}),
				...(input.timeoutMs !== undefined
					? { timeoutMs: input.timeoutMs }
					: {}),
				...(input.maxOutputBytes !== undefined
					? { maxOutputBytes: input.maxOutputBytes }
					: {}),
				...(input.appendTruncationMarker !== undefined
					? { appendTruncationMarker: input.appendTruncationMarker }
					: {}),
			});

		const listWorkspaceFiles: JujutsuVcsDriver["Service"]["listWorkspaceFiles"] =
			(cwd) =>
				jjCommand(
					"JujutsuVcsDriver.listWorkspaceFiles",
					cwd,
					["file", "list"],
					{
						allowNonZeroExit: true,
						timeoutMs: DEFAULT_TIMEOUT_MS,
						maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
						appendTruncationMarker: true,
					},
				).pipe(
					Effect.flatMap((result) => {
						if (result.exitCode !== 0) {
							return Effect.fail(
								exitError("JujutsuVcsDriver.listWorkspaceFiles", cwd, [
									"file",
									"list",
								])(result),
							);
						}
						return Effect.map(nowFreshness(), (freshness) => ({
							paths: result.stdout
								.split(/\r?\n/g)
								.map((line) => line.trim())
								.filter((line) => line.length > 0),
							truncated: result.stdoutTruncated,
							freshness,
						}));
					}),
				);

		const listRemotes: JujutsuVcsDriver["Service"]["listRemotes"] = Effect.fn(
			"listRemotes",
		)(function* (cwd) {
			const args = ["git", "remote", "list"];
			const result = yield* jjCommand(
				"JujutsuVcsDriver.listRemotes",
				cwd,
				args,
				{
					allowNonZeroExit: true,
					timeoutMs: 5_000,
					maxOutputBytes: 64 * 1024,
				},
			);
			if (result.exitCode !== 0) {
				return yield* exitError(
					"JujutsuVcsDriver.listRemotes",
					cwd,
					args,
				)(result);
			}

			const remotes = result.stdout
				.split(/\r?\n/g)
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => {
					const separatorIndex = line.search(/\s/);
					const name =
						separatorIndex === -1 ? line : line.slice(0, separatorIndex);
					const url =
						separatorIndex === -1 ? "" : line.slice(separatorIndex).trim();
					return {
						name,
						url,
						pushUrl: Option.none<string>(),
						isPrimary: name === "origin",
					};
				})
				.filter((remote) => remote.url.length > 0);

			return {
				remotes,
				freshness: yield* nowFreshness(),
			};
		});

		const filterIgnoredPaths: JujutsuVcsDriver["Service"]["filterIgnoredPaths"] =
			Effect.fn("filterIgnoredPaths")(function* (cwd, relativePaths) {
				if (relativePaths.length === 0) {
					return relativePaths;
				}

				// jj snapshots the working copy on every command, so `file list` reflects
				// the live tree. A path survives filtering when it is a listed file or a
				// directory that still contains tracked files.
				const files = yield* listWorkspaceFiles(cwd);
				const known = new Set<string>(files.paths);
				for (const filePath of files.paths) {
					let directory = path.dirname(filePath);
					while (
						directory !== "." &&
						directory !== "/" &&
						directory.length > 0
					) {
						known.add(directory);
						const parent = path.dirname(directory);
						if (parent === directory) {
							break;
						}
						directory = parent;
					}
				}

				return relativePaths.filter((relativePath) => known.has(relativePath));
			});

		const initRepository: JujutsuVcsDriver["Service"]["initRepository"] = (
			input,
		) =>
			jjCommand(
				"JujutsuVcsDriver.initRepository",
				input.cwd,
				["git", "init", "--colocate"],
				{
					timeoutMs: 10_000,
					maxOutputBytes: 64 * 1024,
				},
			).pipe(Effect.asVoid);

		const createWorkspace: JujutsuVcsDriver["Service"]["createWorkspace"] =
			jjWorkspaces.createWorkspace;

		const listWorkspaces: JujutsuVcsDriver["Service"]["listWorkspaces"] =
			jjWorkspaces.listWorkspaces;

		const removeWorkspace: JujutsuVcsDriver["Service"]["removeWorkspace"] =
			jjWorkspaces.removeWorkspace;

		return {
			capabilities,
			execute,
			detectRepository,
			isInsideWorkTree,
			listWorkspaceFiles,
			listRemotes,
			filterIgnoredPaths,
			initRepository,
			createWorkspace,
			listWorkspaces,
			removeWorkspace,
		};
	},
);

export const makeVcsDriver = Effect.gen(function* () {
	const driver = yield* makeJujutsuVcsDriverShape();
	return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
	const driver = yield* makeJujutsuVcsDriverShape();
	return JujutsuVcsDriver.of(driver);
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(JujutsuVcsDriver, make);
