import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
	GitCommandError,
	VcsProcessExitError,
	type VcsSwitchRefInput,
	type VcsSwitchRefResult,
	type VcsCreateRefInput,
	type VcsCreateRefResult,
	type VcsCreateWorktreeInput,
	type VcsCreateWorktreeResult,
	type ReviewDiffPreviewInput,
	type ReviewDiffPreviewResult,
	type ReviewDiffFileContentsInput,
	type ReviewDiffFileContentsResult,
	type VcsInitInput,
	type VcsListRefsInput,
	type VcsListRefsResult,
	type VcsPullResult,
	type VcsRemoveWorktreeInput,
	type VcsStatusInput,
	type VcsStatusResult,
	VcsUnsupportedOperationError,
	type VcsCreateWorkspaceInput,
	type VcsRemoveWorkspaceInput,
} from "@t3tools/contracts";
import {
	makeGitVcsDriverCore,
	PATCH_RENDER_PREFIX_ARGS,
	splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import { ServerConfig } from "../config.ts";
import {
	parseRemoteNames,
	parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import {
	makeJujutsuWorkspaceOps,
	type JujutsuWorkspaceOps,
} from "./JujutsuWorkspaces.ts";

export interface ExecuteGitInput {
	readonly operation: string;
	readonly cwd: string;
	readonly args: ReadonlyArray<string>;
	readonly stdin?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly allowNonZeroExit?: boolean;
	readonly timeoutMs?: number | null;
	readonly maxOutputBytes?: number;
	readonly appendTruncationMarker?: boolean;
	readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
	readonly exitCode: ChildProcessSpawner.ExitCode;
	readonly stdout: string;
	readonly stderr: string;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
	isRepo: boolean;
	sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
	hasOriginRemote: boolean;
	isDefaultBranch: boolean;
	branch: string | null;
	upstreamRef: string | null;
	hasWorkingTreeChanges: boolean;
	workingTree: VcsStatusResult["workingTree"];
	hasUpstream: boolean;
	aheadCount: number;
	behindCount: number;
	aheadOfDefaultCount: number;
}

export interface GitRemoteStatusDetails {
	isRepo: boolean;
	defaultBranch: string | null;
	isDefaultBranch: boolean;
	branch: string | null;
	upstreamRef: string | null;
	hasUpstream: boolean;
	aheadCount: number;
	behindCount: number;
	aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
	stagedSummary: string;
	stagedPatch: string;
}

export interface ExecuteGitProgress {
	readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
	readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
	readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
	readonly onHookFinished?: (input: {
		hookName: string;
		exitCode: number | null;
		durationMs: number | null;
	}) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
	readonly onOutputLine?: (input: {
		stream: "stdout" | "stderr";
		text: string;
	}) => Effect.Effect<void, never>;
	readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
	readonly onHookFinished?: (input: {
		hookName: string;
		exitCode: number | null;
		durationMs: number | null;
	}) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
	readonly timeoutMs?: number;
	readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
	status: "pushed" | "skipped_up_to_date";
	branch: string;
	upstreamBranch?: string | undefined;
	setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
	commitSummary: string;
	diffSummary: string;
	diffPatch: string;
}

export interface GitRenameBranchInput {
	cwd: string;
	oldBranch: string;
	newBranch: string;
}

export interface GitRenameBranchResult {
	branch: string;
}

export interface GitFetchPullRequestBranchInput {
	cwd: string;
	prNumber: number;
	branch: string;
}

export interface GitFetchPullRequestHeadCommitInput {
	cwd: string;
	prNumber: number;
}

export interface GitResolveCommitInput {
	cwd: string;
	revision: string;
}

export interface GitResolveCommitResult {
	commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
	cwd: string;
	targetCommit: string;
	/**
	 * Commit the checkout is allowed to be hard-reset away from: the upstream commit read before
	 * the fetch. HEAD sitting there means the checkout holds no work of its own.
	 */
	resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
	headCommit: string;
	moved: boolean;
	onTarget: boolean;
}

export interface GitEnsureRemoteInput {
	cwd: string;
	preferredName: string;
	url: string;
}

export interface GitFetchRemoteBranchInput {
	cwd: string;
	remoteName: string;
	remoteBranch: string;
	localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
	cwd: string;
	remoteName: string;
	remoteBranch: string;
}

export interface GitFetchRemoteInput {
	cwd: string;
	remoteName: string;
}

export interface GitRemoteExistsInput {
	cwd: string;
	remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
	refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
	cwd: string;
	refName: string;
	fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
	commitSha: string;
	remoteRefName: string;
}

export interface GitSetBranchUpstreamInput {
	cwd: string;
	branch: string;
	remoteName: string;
	remoteBranch: string;
}

export interface GitRemoteStatusOptions {
	readonly refreshUpstream?: boolean;
}

export class GitVcsDriver extends Context.Service<
	GitVcsDriver,
	{
		readonly execute: (
			input: ExecuteGitInput,
		) => Effect.Effect<ExecuteGitResult, GitCommandError>;
		readonly status: (
			input: VcsStatusInput,
		) => Effect.Effect<VcsStatusResult, GitCommandError>;
		readonly statusDetails: (
			cwd: string,
		) => Effect.Effect<GitStatusDetails, GitCommandError>;
		readonly statusDetailsLocal: (
			cwd: string,
		) => Effect.Effect<GitStatusDetails, GitCommandError>;
		readonly statusDetailsRemote: (
			cwd: string,
			options?: GitRemoteStatusOptions,
		) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
		readonly prepareCommitContext: (
			cwd: string,
			filePaths?: readonly string[],
		) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
		readonly commit: (
			cwd: string,
			subject: string,
			body: string,
			options?: GitCommitOptions,
		) => Effect.Effect<{ commitSha: string }, GitCommandError>;
		readonly pushCurrentBranch: (
			cwd: string,
			fallbackBranch: string | null,
			options?: { readonly remoteName?: string | null },
		) => Effect.Effect<GitPushResult, GitCommandError>;
		readonly readRangeContext: (
			cwd: string,
			baseRef: string,
		) => Effect.Effect<GitRangeContext, GitCommandError>;
		readonly getReviewDiffPreview: (
			input: ReviewDiffPreviewInput,
		) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
		readonly getReviewDiffFileContents: (
			input: ReviewDiffFileContentsInput,
		) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
		readonly readConfigValue: (
			cwd: string,
			key: string,
		) => Effect.Effect<string | null, GitCommandError>;
		readonly listRefs: (
			input: VcsListRefsInput,
		) => Effect.Effect<VcsListRefsResult, GitCommandError>;
		readonly pullCurrentBranch: (
			cwd: string,
		) => Effect.Effect<VcsPullResult, GitCommandError>;
		readonly createWorktree: (
			input: VcsCreateWorktreeInput,
		) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
		readonly fetchPullRequestBranch: (
			input: GitFetchPullRequestBranchInput,
		) => Effect.Effect<void, GitCommandError>;
		/** Fetches `refs/pull/<n>/head` without writing a branch, for heads that exist nowhere else. */
		readonly fetchPullRequestHeadCommit: (
			input: GitFetchPullRequestHeadCommitInput,
		) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
		readonly resolveCommit: (
			input: GitResolveCommitInput,
		) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
		/** Moves the branch checked out in `cwd` onto `targetCommit`, from inside that worktree. */
		readonly refreshCheckedOutBranch: (
			input: GitRefreshCheckedOutBranchInput,
		) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
		readonly ensureRemote: (
			input: GitEnsureRemoteInput,
		) => Effect.Effect<string, GitCommandError>;
		readonly resolvePrimaryRemoteName: (
			cwd: string,
		) => Effect.Effect<string, GitCommandError>;
		readonly resolveDefaultBranchName: (
			cwd: string,
			remoteName: string,
		) => Effect.Effect<string | null, GitCommandError>;
		readonly fetchRemote: (
			input: GitFetchRemoteInput,
		) => Effect.Effect<void, GitCommandError>;
		readonly remoteExists: (
			input: GitRemoteExistsInput,
		) => Effect.Effect<boolean, GitCommandError>;
		readonly remoteBranchExists: (
			input: GitRemoteBranchExistsInput,
		) => Effect.Effect<boolean, GitCommandError>;
		readonly resolveRemoteTrackingCommit: (
			input: GitResolveRemoteTrackingCommitInput,
		) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
		readonly fetchRemoteBranch: (
			input: GitFetchRemoteBranchInput,
		) => Effect.Effect<void, GitCommandError>;
		readonly fetchRemoteTrackingBranch: (
			input: GitFetchRemoteTrackingBranchInput,
		) => Effect.Effect<void, GitCommandError>;
		readonly setBranchUpstream: (
			input: GitSetBranchUpstreamInput,
		) => Effect.Effect<void, GitCommandError>;
		readonly removeWorktree: (
			input: VcsRemoveWorktreeInput,
		) => Effect.Effect<void, GitCommandError>;
		/** Drops worktree admin entries whose directory is already gone (`git worktree prune`). */
		readonly pruneWorktrees: (input: {
			readonly cwd: string;
		}) => Effect.Effect<void, GitCommandError>;
		readonly renameBranch: (
			input: GitRenameBranchInput,
		) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
		readonly createRef: (
			input: VcsCreateRefInput,
		) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
		readonly switchRef: (
			input: VcsSwitchRefInput,
		) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
		readonly initRepo: (
			input: VcsInitInput,
		) => Effect.Effect<void, GitCommandError>;
		readonly listLocalBranchNames: (
			cwd: string,
		) => Effect.Effect<string[], GitCommandError>;
	}
>()("t3/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
	const now = yield* DateTime.now;
	return {
		source: "live-local" as const,
		observedAt: now,
		expiresAt: Option.none(),
	};
});

function chunkPathsForGitCheckIgnore(
	relativePaths: ReadonlyArray<string>,
): string[][] {
	const chunks: string[][] = [];
	let chunk: string[] = [];
	let chunkBytes = 0;

	for (const relativePath of relativePaths) {
		const relativePathBytes = Buffer.byteLength(relativePath) + 1;
		if (
			chunk.length > 0 &&
			chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES
		) {
			chunks.push(chunk);
			chunk = [];
			chunkBytes = 0;
		}

		chunk.push(relativePath);
		chunkBytes += relativePathBytes;

		if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
			chunks.push(chunk);
			chunk = [];
			chunkBytes = 0;
		}
	}

	if (chunk.length > 0) {
		chunks.push(chunk);
	}

	return chunks;
}

function parseGitRemoteVerboseOutput(
	output: string,
): Map<string, { url?: string; pushUrl?: string }> {
	const remotes = new Map<string, { url?: string; pushUrl?: string }>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}

		const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
		if (!match) {
			continue;
		}

		const name = match[1];
		const url = match[2];
		const direction = match[3];
		if (!name || !url || !direction) {
			continue;
		}
		const remote = remotes.get(name) ?? {};
		if (direction === "fetch") {
			remote.url = url;
		} else {
			remote.pushUrl = url;
		}
		remotes.set(name, remote);
	}
	return remotes;
}

const gitCommand = (
	process: VcsProcess.VcsProcess["Service"],
	operation: string,
	cwd: string,
	args: ReadonlyArray<string>,
	options?: {
		readonly stdin?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly allowNonZeroExit?: boolean;
		readonly timeoutMs?: number;
		readonly maxOutputBytes?: number;
		readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
		readonly appendTruncationMarker?: boolean;
	},
) =>
	process.run({
		operation,
		command: "git",
		args: ["-C", cwd, ...args],
		cwd,
		spawnCwd: globalThis.process.cwd(),
		...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
		...(options?.env !== undefined ? { env: options.env } : {}),
		...(options?.allowNonZeroExit !== undefined
			? { allowNonZeroExit: options.allowNonZeroExit }
			: {}),
		...(options?.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
		...(options?.maxOutputBytes !== undefined
			? { maxOutputBytes: options.maxOutputBytes }
			: {}),
		...(options?.outputMode !== undefined
			? { outputMode: options.outputMode }
			: {}),
		...(options?.appendTruncationMarker !== undefined
			? { appendTruncationMarker: options.appendTruncationMarker }
			: {}),
	});

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(
	function* () {
		const fileSystem = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const vcsProcess = yield* VcsProcess.VcsProcess;
		const jjWorkspaces: JujutsuWorkspaceOps = yield* makeJujutsuWorkspaceOps();
		const capabilities = {
			kind: "git" as const,
			supportsWorktrees: true,
			supportsBookmarks: false,
			supportsAtomicSnapshot: false,
			supportsPushDefaultRemote: true,
			ignoreClassifier: "native" as const,
		};

		const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] =
			(cwd) =>
				gitCommand(
					vcsProcess,
					"GitVcsDriver.isInsideWorkTree",
					cwd,
					["rev-parse", "--is-inside-work-tree"],
					{
						allowNonZeroExit: true,
						timeoutMs: 5_000,
						maxOutputBytes: 4_096,
					},
				).pipe(
					Effect.map(
						(result) =>
							result.exitCode === 0 && result.stdout.trim() === "true",
					),
				);

		const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
			gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
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
				...(input.outputMode !== undefined
					? { outputMode: input.outputMode }
					: {}),
				...(input.appendTruncationMarker !== undefined
					? { appendTruncationMarker: input.appendTruncationMarker }
					: {}),
			});

		const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] =
			Effect.fn("detectRepository")(function* (cwd) {
				if (!(yield* isInsideWorkTree(cwd))) {
					return null;
				}

				const root = yield* gitCommand(
					vcsProcess,
					"GitVcsDriver.detectRepository.root",
					cwd,
					["rev-parse", "--show-toplevel"],
				);
				const gitCommonDir = yield* gitCommand(
					vcsProcess,
					"GitVcsDriver.detectRepository.commonDir",
					cwd,
					["rev-parse", "--git-common-dir"],
				).pipe(Effect.orElseSucceed(() => null));

				return {
					kind: "git" as const,
					rootPath: root.stdout.trim(),
					metadataPath: gitCommonDir?.stdout.trim() || null,
					freshness: yield* nowFreshness(),
				};
			});

		const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] =
			(cwd) =>
				gitCommand(
					vcsProcess,
					"GitVcsDriver.listWorkspaceFiles",
					cwd,
					[
						...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
						"ls-files",
						"--cached",
						"--others",
						"--exclude-standard",
						"-z",
					],
					{
						allowNonZeroExit: true,
						timeoutMs: 20_000,
						maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
						appendTruncationMarker: true,
					},
				).pipe(
					Effect.flatMap((result) =>
						result.exitCode === 0
							? Effect.gen(function* () {
									const freshness = yield* nowFreshness();
									return {
										paths: splitNullSeparatedGitStdoutPaths(result),
										truncated: result.stdoutTruncated,
										freshness,
									};
								})
							: Effect.fail(
									new VcsProcessExitError({
										operation: "GitVcsDriver.listWorkspaceFiles",
										command: "git ls-files",
										cwd,
										exitCode: result.exitCode,
										detail: result.stderr.trim() || "git ls-files failed",
									}),
								),
					),
				);

		const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] =
			Effect.fn("listRemotes")(function* (cwd) {
				const result = yield* gitCommand(
					vcsProcess,
					"GitVcsDriver.listRemotes",
					cwd,
					["remote", "-v"],
					{
						allowNonZeroExit: true,
						timeoutMs: 5_000,
						maxOutputBytes: 64 * 1024,
					},
				);

				if (result.exitCode !== 0) {
					return yield* new VcsProcessExitError({
						operation: "GitVcsDriver.listRemotes",
						command: "git remote -v",
						cwd,
						exitCode: result.exitCode,
						detail: result.stderr.trim() || "git remote -v failed",
					});
				}

				const parsed = parseGitRemoteVerboseOutput(result.stdout);
				const remotes = Array.from(parsed.entries()).flatMap(
					([name, remote]) => {
						if (!remote.url) {
							return [];
						}
						return [
							{
								name,
								url: remote.url,
								pushUrl: remote.pushUrl
									? Option.some(remote.pushUrl)
									: Option.none(),
								isPrimary: name === "origin",
							},
						];
					},
				);

				return {
					remotes,
					freshness: yield* nowFreshness(),
				};
			});

		const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] =
			Effect.fn("filterIgnoredPaths")(function* (cwd, relativePaths) {
				if (relativePaths.length === 0) {
					return relativePaths;
				}

				const ignoredPaths = new Set<string>();
				const chunks = chunkPathsForGitCheckIgnore(relativePaths);

				for (const chunk of chunks) {
					const result = yield* gitCommand(
						vcsProcess,
						"GitVcsDriver.filterIgnoredPaths",
						cwd,
						[
							...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
							"check-ignore",
							"--no-index",
							"-z",
							"--stdin",
						],
						{
							stdin: `${chunk.join("\0")}\0`,
							allowNonZeroExit: true,
							timeoutMs: 20_000,
							maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
							appendTruncationMarker: true,
						},
					);

					if (result.exitCode !== 0 && result.exitCode !== 1) {
						return yield* new VcsProcessExitError({
							operation: "GitVcsDriver.filterIgnoredPaths",
							command: "git check-ignore",
							cwd,
							exitCode: result.exitCode,
							detail: result.stderr.trim() || "git check-ignore failed",
						});
					}

					for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
						ignoredPaths.add(ignoredPath);
					}
				}

				if (ignoredPaths.size === 0) {
					return relativePaths;
				}

				return relativePaths.filter(
					(relativePath) => !ignoredPaths.has(relativePath),
				);
			});

		const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (
			input,
		) =>
			gitCommand(
				vcsProcess,
				"GitVcsDriver.initRepository",
				input.cwd,
				["init"],
				{
					timeoutMs: 10_000,
					maxOutputBytes: 64 * 1024,
				},
			).pipe(Effect.asVoid);

		// Colocated repositories (.git + .jj) route thread worktrees through jj
		// workspaces so the two VCS frontends never disagree about checkouts. Plain
		// git repositories reject these operations and keep `git worktree` plumbing.
		const isJjWorkspaceRepository = (operation: string, cwd: string) =>
			vcsProcess
				.run({
					operation,
					command: "jj",
					args: ["--no-pager", "workspace", "root"],
					cwd,
					allowNonZeroExit: true,
					timeoutMs: 5_000,
					maxOutputBytes: 16_000,
				})
				.pipe(Effect.map((result) => result.exitCode === 0));

		const requireJjWorkspaceRepository = Effect.fn(
			"GitVcsDriver.requireJjWorkspaceRepository",
		)(function* (operation: string, cwd: string) {
			if (yield* isJjWorkspaceRepository(operation, cwd)) {
				return;
			}
			return yield* new VcsUnsupportedOperationError({
				operation,
				kind: "git",
				detail:
					"jj workspace operations require a colocated jj repository (.git + .jj).",
			});
		});

		const createWorkspace: VcsDriver.VcsDriver["Service"]["createWorkspace"] = (
			input: VcsCreateWorkspaceInput,
		) =>
			requireJjWorkspaceRepository("GitVcsDriver.createWorkspace", input.cwd).pipe(
				Effect.andThen(jjWorkspaces.createWorkspace(input)),
				// The git driver only routes here so jj workspaces behave as git
				// worktrees. A jj build without git.auto-register-worktrees still
				// creates the workspace but leaves no .git, which would silently
				// degrade every git command in the workspace to "not a repository".
				Effect.andThen((workspace) =>
					fileSystem
						.exists(path.join(workspace.path, ".git"))
						.pipe(
							Effect.orElseSucceed(() => false),
							Effect.flatMap((hasGitMetadata) =>
								hasGitMetadata
									? Effect.succeed(workspace)
									: new VcsUnsupportedOperationError({
											operation: "GitVcsDriver.createWorkspace",
											kind: "git",
											detail:
												"jj workspace creation did not register a git worktree (.git is missing); the installed jj build may not support git.auto-register-worktrees.",
										}),
							),
						),
				),
			);

		const listWorkspaces: VcsDriver.VcsDriver["Service"]["listWorkspaces"] = (
			cwd: string,
		) =>
			requireJjWorkspaceRepository("GitVcsDriver.listWorkspaces", cwd).pipe(
				Effect.andThen(jjWorkspaces.listWorkspaces(cwd)),
			);

		const removeWorkspace: VcsDriver.VcsDriver["Service"]["removeWorkspace"] = (
			input: VcsRemoveWorkspaceInput,
		) =>
			requireJjWorkspaceRepository("GitVcsDriver.removeWorkspace", input.cwd).pipe(
				Effect.andThen(jjWorkspaces.removeWorkspace(input)),
			);


		const resolveHeadCommit = (cwd: string) =>
			execute({
				operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
				cwd,
				args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
				allowNonZeroExit: true,
			}).pipe(
				Effect.map((result) => {
					if (result.exitCode !== 0) {
						return null;
					}
					const commit = result.stdout.trim();
					return commit.length > 0 ? commit : null;
				}),
			);

		const hasHeadCommit = (cwd: string) =>
			execute({
				operation: "GitVcsDriver.checkpoints.hasHeadCommit",
				cwd,
				args: ["rev-parse", "--verify", "HEAD"],
				allowNonZeroExit: true,
			}).pipe(Effect.map((result) => result.exitCode === 0));

		const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
			execute({
				operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
				cwd,
				args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
				allowNonZeroExit: true,
			}).pipe(
				Effect.map((result) => {
					if (result.exitCode !== 0) {
						return null;
					}
					const commit = result.stdout.trim();
					return commit.length > 0 ? commit : null;
				}),
			);

		const resolveGitCommonDir = (cwd: string) =>
			Effect.gen(function* () {
				const result = yield* execute({
					operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
					cwd,
					args: ["rev-parse", "--git-common-dir"],
				});
				const gitCommonDir = result.stdout.trim();
				return path.isAbsolute(gitCommonDir)
					? gitCommonDir
					: path.resolve(cwd, gitCommonDir);
			});

		const checkpoints: VcsDriver.VcsCheckpointOps = {
			captureCheckpoint: Effect.fn(
				"GitVcsDriver.checkpoints.captureCheckpoint",
			)(function* (input) {
				const operation = "GitVcsDriver.checkpoints.captureCheckpoint";
				const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
				const tempIndexPath = path.join(
					gitCommonDir,
					`t3-checkpoint-index-${NodeCrypto.randomUUID()}`,
				);
				const commitEnv: NodeJS.ProcessEnv = {
					...process.env,
					GIT_INDEX_FILE: tempIndexPath,
					GIT_AUTHOR_NAME: "T3 Code",
					GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
					GIT_COMMITTER_NAME: "T3 Code",
					GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
				};

				const cleanupTempIndex = fileSystem
					.remove(tempIndexPath, { force: true })
					.pipe(Effect.ignore);

				yield* Effect.gen(function* () {
					const headExists = yield* hasHeadCommit(input.cwd);
					if (headExists) {
						yield* execute({
							operation,
							cwd: input.cwd,
							args: ["read-tree", "HEAD"],
							env: commitEnv,
						});
					}

					yield* execute({
						operation,
						cwd: input.cwd,
						args: ["add", "-A", "--", "."],
						env: commitEnv,
					});

					const writeTreeResult = yield* execute({
						operation,
						cwd: input.cwd,
						args: ["write-tree"],
						env: commitEnv,
					});
					const treeOid = writeTreeResult.stdout.trim();
					if (treeOid.length === 0) {
						return yield* new VcsProcessExitError({
							operation,
							command: "git write-tree",
							cwd: input.cwd,
							exitCode: 0,
							detail: "git write-tree returned an empty tree oid.",
						});
					}

					const message = `t3 checkpoint ref=${input.checkpointRef}`;
					const commitTreeResult = yield* execute({
						operation,
						cwd: input.cwd,
						args: ["commit-tree", treeOid, "-m", message],
						env: commitEnv,
					});
					const commitOid = commitTreeResult.stdout.trim();
					if (commitOid.length === 0) {
						return yield* new VcsProcessExitError({
							operation,
							command: "git commit-tree",
							cwd: input.cwd,
							exitCode: 0,
							detail: "git commit-tree returned an empty commit oid.",
						});
					}

					yield* execute({
						operation,
						cwd: input.cwd,
						args: ["update-ref", input.checkpointRef, commitOid],
					});
				}).pipe(Effect.ensuring(cleanupTempIndex));
			}),

			hasCheckpointRef: (input) =>
				resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
					Effect.map((commit) => commit !== null),
				),

			restoreCheckpoint: Effect.fn(
				"GitVcsDriver.checkpoints.restoreCheckpoint",
			)(function* (input) {
				const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

				let commitOid = yield* resolveCheckpointCommit(
					input.cwd,
					input.checkpointRef,
				);

				if (!commitOid && input.fallbackToHead === true) {
					commitOid = yield* resolveHeadCommit(input.cwd);
				}

				if (!commitOid) {
					return false;
				}

				yield* execute({
					operation,
					cwd: input.cwd,
					args: [
						"restore",
						"--source",
						commitOid,
						"--worktree",
						"--staged",
						"--",
						".",
					],
				});
				yield* execute({
					operation,
					cwd: input.cwd,
					args: ["clean", "-fd", "--", "."],
				});

				const headExists = yield* hasHeadCommit(input.cwd);
				if (headExists) {
					yield* execute({
						operation,
						cwd: input.cwd,
						args: ["reset", "--quiet", "--", "."],
					});
				}

				return true;
			}),

			diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(
				function* (input) {
					const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
					yield* Effect.annotateCurrentSpan({
						"checkpoint.cwd": input.cwd,
						"checkpoint.from_ref": input.fromCheckpointRef,
						"checkpoint.to_ref": input.toCheckpointRef,
						"checkpoint.ignore_whitespace": input.ignoreWhitespace,
						"checkpoint.format": input.format ?? "patch",
						"checkpoint.fallback_from_to_head": input.fallbackFromToHead,
					});

					let fromRevision: string = input.fromCheckpointRef;
					if (input.fallbackFromToHead === true) {
						const resolvedFromCommit = yield* resolveCheckpointCommit(
							input.cwd,
							input.fromCheckpointRef,
						);
						if (resolvedFromCommit) {
							fromRevision = resolvedFromCommit;
						} else {
							const headCommit = yield* resolveHeadCommit(input.cwd);
							if (!headCommit) {
								return yield* new VcsProcessExitError({
									operation,
									command: "git diff",
									cwd: input.cwd,
									exitCode: 1,
									detail: "Checkpoint ref is unavailable for diff operation.",
								});
							}
							fromRevision = headCommit;
						}
					}

					const result = yield* execute({
						operation,
						cwd: input.cwd,
						args: [
							"diff",
							...(input.format === "numstat"
								? ["--numstat", "-z"]
								: ["--patch"]),
							"--no-color",
							"--no-ext-diff",
							"--no-textconv",
							...PATCH_RENDER_PREFIX_ARGS,
							...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
							`${fromRevision}^{commit}`,
							`${input.toCheckpointRef}^{commit}`,
						],
						allowNonZeroExit: true,
						maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
						outputMode: input.format === "numstat" ? "error" : "truncate",
					});

					if (result.exitCode !== 0) {
						return yield* new VcsProcessExitError({
							operation,
							command: "git diff",
							cwd: input.cwd,
							exitCode: result.exitCode,
							detail:
								result.stderr.trim() ||
								"Checkpoint ref is unavailable for diff operation.",
						});
					}

					return result.stdout;
				},
			),

			deleteCheckpointRefs: Effect.fn(
				"GitVcsDriver.checkpoints.deleteCheckpointRefs",
			)(function* (input) {
				yield* Effect.forEach(
					input.checkpointRefs,
					(checkpointRef) =>
						execute({
							operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
							cwd: input.cwd,
							args: ["update-ref", "-d", checkpointRef],
							allowNonZeroExit: true,
						}),
					{ discard: true },
				);
			}),
		};

		return {
			capabilities,
			execute,
			checkpoints,
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
	const driver = yield* makeVcsDriverShape();
	return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
	const git = yield* makeGitVcsDriverCore();
	const jjWorkspaces = yield* makeJujutsuWorkspaceOps();
	const fileSystem = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { worktreesDir } = yield* ServerConfig;

	// Colocated repositories (.git + .jj) manage thread worktrees as bridged jj
	// child workspaces: `jj workspace add` creates the git worktree and registers
	// it with jj, so the workspace shows up in jj tooling instead of being an
	// invisible foreign worktree whose HEAD the next import reverts.
	const isColocatedJjRepository = (cwd: string) =>
		fileSystem
			.exists(path.join(cwd, ".jj"))
			.pipe(Effect.orElseSucceed(() => false));

	const runWorkspaceGit = (
		operation: string,
		cwd: string,
		args: ReadonlyArray<string>,
		options?: { readonly allowNonZeroExit?: boolean },
	) =>
		git
			.execute({
				operation,
				cwd,
				args,
				...(options?.allowNonZeroExit === undefined
					? {}
					: { allowNonZeroExit: options.allowNonZeroExit }),
			})
			.pipe(
				Effect.mapError(
					(cause) =>
						new GitCommandError({
							operation,
							command: `git ${args[0]}`,
							cwd,
							detail: "jj workspace branch attachment failed.",
							cause,
						}),
				),
			);

	const createJjWorkspaceWorktree: GitVcsDriver["Service"]["createWorktree"] =
		Effect.fn("createJjWorkspaceWorktree")(function* (input) {
			const operation = "GitVcsDriver.createJjWorkspaceWorktree";
			const name = (input.newRefName ?? input.refName).replace(/\//g, "-");
			const repoName = path.basename(input.cwd);
			const targetPath =
				input.path ?? path.join(worktreesDir, repoName, name);
			const workspace = yield* jjWorkspaces
				.createWorkspace({
					cwd: input.cwd,
					name,
					path: targetPath,
					revision: input.refName,
				})
				.pipe(
					Effect.mapError(
						(cause) =>
							new GitCommandError({
								operation,
								command: "jj workspace add",
								cwd: input.cwd,
								detail: "jj workspace creation failed.",
								cause,
							}),
					),
				);
			const hasGitMetadata = yield* fileSystem
				.exists(path.join(workspace.path, ".git"))
				.pipe(Effect.orElseSucceed(() => false));
			if (!hasGitMetadata) {
				return yield* new GitCommandError({
					operation,
					command: "jj workspace add",
					cwd: input.cwd,
					detail:
						"jj workspace creation did not register a git worktree (.git is missing); the installed jj build may not support git.auto-register-worktrees.",
				});
			}

			// `jj workspace add` leaves the workspace's git HEAD detached at the
			// target revision. Commits must land on a branch, and the base branch
			// usually stays checked out in the default workspace, so git refuses to
			// check it out a second time.
			let refName = input.newRefName ?? input.refName;
			if (input.newRefName) {
				yield* runWorkspaceGit(operation, workspace.path, [
					"checkout",
					"-b",
					input.newRefName,
				]);
			} else if (
				(
					yield* runWorkspaceGit(operation, workspace.path, [
						"checkout",
						input.refName,
					])
				).exitCode !== 0
			) {
				// -B re-points a stale branch left behind by a forgotten workspace
				// with the same name.
				yield* runWorkspaceGit(operation, workspace.path, [
					"checkout",
					"-B",
					name,
				]);
				refName = name;
			}

			if (input.newRefName && input.baseRefName) {
				const remotes = yield* git
					.execute({ operation, cwd: input.cwd, args: ["remote"] })
					.pipe(
						Effect.mapError(
							(cause) =>
								new GitCommandError({
									operation,
									command: "git remote",
									cwd: input.cwd,
									detail: "Reading git remotes failed.",
									cause,
								}),
						),
					);
				const parsedBaseRef = parseRemoteRefWithRemoteNames(
					input.baseRefName,
					parseRemoteNames(remotes.stdout),
				);
				const baseBranch = parsedBaseRef?.branchName ?? input.baseRefName;
				yield* git
					.execute({
						operation,
						cwd: input.cwd,
						args: [
							"config",
							`branch.${input.newRefName}.gh-merge-base`,
							baseBranch,
						],
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new GitCommandError({
									operation,
									command: "git config",
									cwd: input.cwd,
									detail: "Configuring the review base branch failed.",
									cause,
								}),
						),
					);
			}

			return {
				worktree: {
					path: workspace.path,
					refName,
				},
			};
		});

	const removeJjWorkspace: GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
		"removeJjWorkspace",
	)(function* (input) {
		const operation = "GitVcsDriver.removeJjWorkspace";
		const { workspaces } = yield* jjWorkspaces.listWorkspaces(input.cwd).pipe(
			Effect.mapError(
				(cause) =>
					new GitCommandError({
						operation,
						command: "jj workspace list",
						cwd: input.cwd,
						detail: "jj workspace listing failed.",
						cause,
					}),
			),
		);
		const targetPath = path.resolve(input.path);
		const match = workspaces.find(
			(workspace) => path.resolve(workspace.path) === targetPath,
		);
		if (!match) {
			return yield* new GitCommandError({
				operation,
				command: "jj workspace list",
				cwd: input.cwd,
				detail: `No jj workspace is checked out at ${input.path}.`,
			});
		}
		yield* jjWorkspaces
			.removeWorkspace({
				cwd: input.cwd,
				name: match.name,
				deleteDirectory: true,
			})
			.pipe(
				Effect.mapError(
					(cause) =>
						new GitCommandError({
							operation,
							command: "jj workspace forget",
							cwd: input.cwd,
							detail: "jj workspace removal failed.",
							cause,
						}),
				),
			);
	});

	const pruneJjWorkspaces: GitVcsDriver["Service"]["pruneWorktrees"] = Effect.fn(
		"pruneJjWorkspaces",
	)(function* (input) {
		const operation = "GitVcsDriver.pruneJjWorkspaces";
		const result = yield* jjWorkspaces
			.listWorkspaces(input.cwd)
			.pipe(Effect.orElseSucceed(() => null));
		if (result === null) {
			return;
		}
		for (const workspace of result.workspaces) {
			if (workspace.name === "default") {
				continue;
			}
			const exists = yield* fileSystem
				.exists(workspace.path)
				.pipe(Effect.orElseSucceed(() => true));
			if (!exists) {
				yield* jjWorkspaces
					.removeWorkspace({ cwd: input.cwd, name: workspace.name })
					.pipe(Effect.catch(() => Effect.void));
			}
		}
	});

	const routeToJjWorkspace = (cwd: string) =>
		isColocatedJjRepository(cwd).pipe(Effect.orElseSucceed(() => false));

	return GitVcsDriver.of({
		...git,
		createWorktree: (input) =>
			routeToJjWorkspace(input.cwd).pipe(
				Effect.flatMap((colocated) =>
					colocated
						? createJjWorkspaceWorktree(input)
						: git.createWorktree(input),
				),
			),
		removeWorktree: (input) =>
			routeToJjWorkspace(input.cwd).pipe(
				Effect.flatMap((colocated) =>
					colocated ? removeJjWorkspace(input) : git.removeWorktree(input),
				),
			),
		pruneWorktrees: (input) =>
			routeToJjWorkspace(input.cwd).pipe(
				Effect.flatMap((colocated) =>
					colocated ? pruneJjWorkspaces(input) : git.pruneWorktrees(input),
				),
			),
	});
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
