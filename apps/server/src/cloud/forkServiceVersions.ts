import { compareExactServiceVersions } from "./serviceProtocol.ts";

function splitVersion(version: string): {
	readonly core: string;
	readonly prerelease: string | undefined;
} {
	const withoutBuild = version.split("+", 1)[0] ?? version;
	const separator = withoutBuild.indexOf("-");
	return {
		core: separator === -1 ? withoutBuild : withoutBuild.slice(0, separator),
		prerelease:
			separator === -1 ? undefined : withoutBuild.slice(separator + 1),
	};
}

const FORK_PRERELEASE = /^fork\.\d+$/;

/**
 * Exact-version comparison with one fork rule: a `-fork.N` build replaces the
 * plain release of the same core version instead of ranking below it, so
 * `0.0.40-fork.2` counts as newer than `0.0.40`. Everything else matches
 * `compareExactServiceVersions`, including fork-to-fork ordering.
 */
export function compareForkServiceVersions(
	left: string,
	right: string,
): number {
	const exact = compareExactServiceVersions(left, right);
	if (exact === 0) return 0;
	const a = splitVersion(left);
	const b = splitVersion(right);
	if (a.core !== b.core) return exact;
	const aFork = a.prerelease !== undefined && FORK_PRERELEASE.test(a.prerelease);
	const bFork = b.prerelease !== undefined && FORK_PRERELEASE.test(b.prerelease);
	if (aFork === bFork) return exact;
	return aFork ? 1 : -1;
}
