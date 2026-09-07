/**
 * JujutsuWorkspaces - shared `jj workspace` plumbing.
 *
 * Both the native jj driver and the colocated mode of the git driver route
 * thread worktrees through jj workspaces, so the CLI semantics (argument
 * shape, `workspace list` parsing, removal cleanup) live here once.
 *
 * @module vcs/JujutsuWorkspaces
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
	type VcsCreateWorkspaceInput,
	type VcsError,
	type VcsListWorkspacesResult,
	type VcsRemoveWorkspaceInput,
	VcsProcessExitError,
	type VcsWorkspace,
} from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const WORKSPACE_ADD_TIMEOUT_MS = 300_000;
const WORKSPACE_LIST_TIMEOUT_MS = 5_000;
const WORKSPACE_REMOVE_TIMEOUT_MS = 30_000;
const WORKSPACE_OUTPUT_MAX_BYTES = 64 * 1024;

export interface JujutsuWorkspaceOps {
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

const nowFreshness = Effect.fn("JujutsuWorkspaces.nowFreshness")(function* () {
	const now = yield* DateTime.now;
	return {
		source: "live-local" as const,
		observedAt: now,
		expiresAt: Option.none(),
	};
});

export const makeJujutsuWorkspaceOps = Effect.fn("makeJujutsuWorkspaceOps")(
	function* () {
		const vcsProcess = yield* VcsProcess.VcsProcess;
		const fileSystem = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const jjCommand = (
			operation: string,
			cwd: string,
			args: ReadonlyArray<string>,
			options: {
				readonly allowNonZeroExit?: boolean;
				readonly timeoutMs?: number;
				readonly maxOutputBytes?: number;
			} = {},
		) =>
			vcsProcess.run({
				operation,
				command: "jj",
				args: ["--no-pager", ...args],
				cwd,
				...(options.allowNonZeroExit !== undefined
					? { allowNonZeroExit: options.allowNonZeroExit }
					: {}),
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxOutputBytes: options.maxOutputBytes ?? WORKSPACE_OUTPUT_MAX_BYTES,
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

		const createWorkspace: JujutsuWorkspaceOps["createWorkspace"] = Effect.fn(
			"JujutsuWorkspaces.createWorkspace",
		)(function* (input) {
			const args = ["workspace", "add", "--name", input.name];
			if (input.revision) {
				args.push("-r", input.revision);
			}
			args.push(input.path);
			// `jj workspace add` does not create missing parent directories.
			yield* fileSystem
				.makeDirectory(path.dirname(input.path), { recursive: true })
				.pipe(Effect.catch(() => Effect.void));
			yield* jjCommand("JujutsuWorkspaces.createWorkspace", input.cwd, args, {
				timeoutMs: WORKSPACE_ADD_TIMEOUT_MS,
			});
			return {
				name: input.name,
				path: input.path,
			};
		});

		const listWorkspaces: JujutsuWorkspaceOps["listWorkspaces"] = Effect.fn(
			"JujutsuWorkspaces.listWorkspaces",
		)(function* (cwd) {
			const args = ["workspace", "list"];
			const result = yield* jjCommand(
				"JujutsuWorkspaces.listWorkspaces",
				cwd,
				args,
				{ allowNonZeroExit: true, timeoutMs: WORKSPACE_LIST_TIMEOUT_MS },
			);
			if (result.exitCode !== 0) {
				return yield* exitError(
					"JujutsuWorkspaces.listWorkspaces",
					cwd,
					args,
				)(result);
			}

			// Output lines look like `<name>: <path> <change id> <commit>`; the path is
			// relative to the current workspace root.
			const workspaces = result.stdout
				.split(/\r?\n/g)
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.flatMap((line) => {
					const separatorIndex = line.indexOf(": ");
					if (separatorIndex === -1) {
						return [];
					}
					const name = line.slice(0, separatorIndex);
					const rest = line.slice(separatorIndex + 2).trim();
					const pathEnd = rest.search(/\s/);
					const relativePath = pathEnd === -1 ? rest : rest.slice(0, pathEnd);
					if (name.length === 0 || relativePath.length === 0) {
						return [];
					}
					return [
						{
							name,
							path: path.resolve(cwd, relativePath),
						} satisfies VcsWorkspace,
					];
				});

			return {
				workspaces,
				freshness: yield* nowFreshness(),
			};
		});

		const removeWorkspace: JujutsuWorkspaceOps["removeWorkspace"] = Effect.fn(
			"JujutsuWorkspaces.removeWorkspace",
		)(function* (input) {
			const workspaces = yield* listWorkspaces(input.cwd);
			const target = workspaces.workspaces.find(
				(workspace) => workspace.name === input.name,
			);
			yield* jjCommand(
				"JujutsuWorkspaces.removeWorkspace",
				input.cwd,
				["workspace", "forget", input.name],
				{ timeoutMs: WORKSPACE_REMOVE_TIMEOUT_MS },
			);
			if (input.deleteDirectory && target) {
				yield* fileSystem
					.remove(target.path, { recursive: true })
					.pipe(Effect.catch(() => Effect.void));
			}
		});

		return {
			createWorkspace,
			listWorkspaces,
			removeWorkspace,
		} satisfies JujutsuWorkspaceOps;
	},
);

export class JujutsuWorkspaces extends Context.Service<
	JujutsuWorkspaces,
	JujutsuWorkspaceOps
>()("t3/vcs/JujutsuWorkspaces") {}

export const layer = Layer.effect(JujutsuWorkspaces, makeJujutsuWorkspaceOps());
