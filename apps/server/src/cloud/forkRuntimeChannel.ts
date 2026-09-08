import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

const FORK_RELEASES_URL =
	"https://api.github.com/repos/aria-amini/t3code/releases/tags/fork-runtime";
const FORK_CHANNEL_TIMEOUT = Duration.seconds(10);
const FORK_CHANNEL_CACHE_TTL = Duration.minutes(10);
const FORK_ASSET_PATTERN = /^t3-(\d+\.\d+\.\d+-fork\.\d+)\.tgz$/u;

export interface ForkRuntimeRelease {
	readonly version: string;
	readonly packageSpec: string;
}

export type ForkUpdateResolution =
	| {
			readonly action: "redirect";
			readonly targetVersion: string;
			readonly packageSpec: string;
	  }
	| { readonly action: "block"; readonly reason: string };

const ReleaseAssets = Schema.Struct({
	assets: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			browser_download_url: Schema.String,
		}),
	),
});

/** Core `major.minor.patch`, dropping any prerelease or build suffix. */
function versionCore(version: string): string {
	return version.replace(/[-+].*$/, "");
}

function compareVersionCores(left: string, right: string): number | null {
	const leftCore = versionCore(left);
	const rightCore = versionCore(right);
	if (parseSemver(leftCore) === null || parseSemver(rightCore) === null) {
		return null;
	}
	return compareSemverVersions(leftCore, rightCore);
}

/** Pick the newest fork runtime tarball from a GitHub release asset list. */
export function forkRuntimeFromAssets(
	assets: ReadonlyArray<{
		readonly name: string;
		readonly browser_download_url: string;
	}>,
): ForkRuntimeRelease | null {
	let best: ForkRuntimeRelease | null = null;
	for (const asset of assets) {
		const match = FORK_ASSET_PATTERN.exec(asset.name);
		const version = match?.[1];
		if (version === undefined) continue;
		if (best === null || compareSemverVersions(version, best.version) > 0) {
			best = { version, packageSpec: asset.browser_download_url };
		}
	}
	return best;
}

/**
 * Decide how a fork server handles a client-requested self-update. Fork builds
 * never install vanilla upstream packages: an upstream target is redirected to
 * the newest fork runtime as long as the fork is caught up with the requested
 * core version, and blocked otherwise. Fork-suffixed targets are honored only
 * when the channel carries exactly that version, because fork runtimes do not
 * exist on the npm registry.
 */
export function resolveForkUpdateRequest(input: {
	readonly requestedVersion: string;
	readonly channel: ForkRuntimeRelease | null;
}): ForkUpdateResolution {
	const { requestedVersion, channel } = input;
	if (channel === null) {
		return {
			action: "block",
			reason:
				"This server runs the Aria fork and its fork runtime channel is unreachable. Update the fork manually with T3_RUNTIME_PACKAGE.",
		};
	}
	if (requestedVersion.includes("-fork.")) {
		return requestedVersion === channel.version
			? {
					action: "redirect",
					targetVersion: channel.version,
					packageSpec: channel.packageSpec,
				}
			: {
					action: "block",
					reason: `Fork runtime ${requestedVersion} is not on the fork runtime channel (latest: ${channel.version}).`,
				};
	}
	const comparison = compareVersionCores(channel.version, requestedVersion);
	if (comparison === null) {
		return {
			action: "block",
			reason: `Cannot compare fork runtime ${channel.version} against ${requestedVersion}. Update the fork manually.`,
		};
	}
	return comparison >= 0
		? {
				action: "redirect",
				targetVersion: channel.version,
				packageSpec: channel.packageSpec,
			}
		: {
				action: "block",
				reason: `The Aria fork has no runtime for T3 Code ${requestedVersion} yet (latest fork runtime: ${channel.version}). Update the fork, or reinstall upstream t3 to leave the fork.`,
			};
}

export class ForkRuntimeChannelError extends Schema.TaggedError<ForkRuntimeChannelError>()(
	"ForkRuntimeChannelError",
	{
		operation: Schema.Literals(["fetch", "decode"]),
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export class ForkRuntimeChannel extends Context.Service<
	ForkRuntimeChannel,
	{
		/** Newest fork runtime published on the rolling release, or null when
		    the release exists but carries no fork runtime tarball. */
		readonly latest: Effect.Effect<
			ForkRuntimeRelease | null,
			ForkRuntimeChannelError
		>;
	}
>()("t3/cloud/fork_runtime_channel") {}

export const makeForkRuntimeChannel = Effect.fn(
	"cloud.fork_runtime_channel.make",
)(function* () {
	const httpClient = (yield* HttpClient.HttpClient).pipe(
		HttpClient.filterStatusOk,
	);
	const cache = yield* Ref.make<
		| { readonly at: number; readonly release: ForkRuntimeRelease | null }
		| undefined
	>(undefined);

	const latest: Effect.Effect<
		ForkRuntimeRelease | null,
		ForkRuntimeChannelError
	> = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const cached = yield* Ref.get(cache);
		if (
			cached !== undefined &&
			now - cached.at < Duration.toMillis(FORK_CHANNEL_CACHE_TTL)
		) {
			return cached.release;
		}
		const release = yield* httpClient
			.execute(
				HttpClientRequest.get(FORK_RELEASES_URL).pipe(
					HttpClientRequest.setHeaders({
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					}),
				),
			)
			.pipe(
				Effect.flatMap(HttpClientResponse.schemaBodyJson(ReleaseAssets)),
				Effect.map((payload) => forkRuntimeFromAssets(payload.assets)),
				Effect.timeout(FORK_CHANNEL_TIMEOUT),
				Effect.mapError(
					(error): ForkRuntimeChannelError =>
						new ForkRuntimeChannelError({
							operation: "fetch",
							cause: error,
						}),
				),
			);
		yield* Ref.set(cache, { at: now, release });
		return release;
	});

	return ForkRuntimeChannel.of({ latest });
});

export const layer = Layer.effect(ForkRuntimeChannel, makeForkRuntimeChannel());
