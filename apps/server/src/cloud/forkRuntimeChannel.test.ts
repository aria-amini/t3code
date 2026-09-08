import { describe, expect, it } from "@effect/vitest";

import {
	forkRuntimeFromAssets,
	resolveForkUpdateRequest,
} from "./forkRuntimeChannel.ts";
import { compareForkServiceVersions } from "./forkServiceVersions.ts";

const RELEASE_URL = (version: string) =>
	`https://github.com/aria-amini/t3code/releases/download/fork-runtime/t3-${version}.tgz`;

describe("forkRuntimeFromAssets", () => {
	it("returns null when no fork runtime asset exists", () => {
		expect(
			forkRuntimeFromAssets([
				{ name: "t3-runtime.tgz", browser_download_url: "https://x/t3-runtime.tgz" },
				{ name: "t3-0.0.40.tgz", browser_download_url: "https://x/t3-0.0.40.tgz" },
			]),
		).toBeNull();
		expect(forkRuntimeFromAssets([])).toBeNull();
	});

	it("picks the newest fork runtime asset", () => {
		const release = forkRuntimeFromAssets([
			{ name: "t3-0.0.39-fork.3.tgz", browser_download_url: RELEASE_URL("0.0.39-fork.3") },
			{ name: "t3-runtime.tgz", browser_download_url: "https://x/t3-runtime.tgz" },
			{ name: "t3-0.0.40-fork.1.tgz", browser_download_url: RELEASE_URL("0.0.40-fork.1") },
		]);
		expect(release).toEqual({
			version: "0.0.40-fork.1",
			packageSpec: RELEASE_URL("0.0.40-fork.1"),
		});
	});
});

describe("compareForkServiceVersions", () => {
	it("ranks a fork build above the plain release of the same core", () => {
		expect(compareForkServiceVersions("0.0.40-fork.2", "0.0.40")).toBeGreaterThan(0);
		expect(compareForkServiceVersions("0.0.40", "0.0.40-fork.2")).toBeLessThan(0);
	});

	it("keeps exact ordering in every other combination", () => {
		expect(compareForkServiceVersions("0.0.40-fork.2", "0.0.40-fork.1")).toBeGreaterThan(0);
		expect(compareForkServiceVersions("0.0.40", "0.0.39")).toBeGreaterThan(0);
		expect(compareForkServiceVersions("0.0.39-fork.3", "0.0.40")).toBeLessThan(0);
		expect(compareForkServiceVersions("0.0.40", "0.0.40")).toBe(0);
		expect(compareForkServiceVersions("0.0.40-fork.2", "0.0.40-fork.2")).toBe(0);
	});
});

describe("resolveForkUpdateRequest", () => {
	const channel = {
		version: "0.0.40-fork.1",
		packageSpec: RELEASE_URL("0.0.40-fork.1"),
	};

	it("blocks when the channel is unreachable", () => {
		const resolution = resolveForkUpdateRequest({
			requestedVersion: "0.0.40",
			channel: null,
		});
		expect(resolution.action).toBe("block");
	});

	it("redirects an upstream target to a caught-up fork runtime", () => {
		expect(
			resolveForkUpdateRequest({
				requestedVersion: "0.0.40",
				channel,
			}),
		).toEqual({ action: "redirect", targetVersion: "0.0.40-fork.1", packageSpec: channel.packageSpec });
	});

	it("redirects when the fork runtime is newer than the requested core", () => {
		expect(
			resolveForkUpdateRequest({
				requestedVersion: "0.0.39",
				channel,
			})?.action,
		).toBe("redirect");
	});

	it("blocks when the fork has no runtime for the requested core yet", () => {
		const resolution = resolveForkUpdateRequest({
			requestedVersion: "0.0.41",
			channel,
		});
		expect(resolution.action).toBe("block");
	});

	it("redirects a fork target that matches the channel exactly", () => {
		expect(
			resolveForkUpdateRequest({
				requestedVersion: "0.0.40-fork.1",
				channel,
			}),
		).toEqual({ action: "redirect", targetVersion: "0.0.40-fork.1", packageSpec: channel.packageSpec });
	});

	it("blocks a fork target the channel does not carry", () => {
		const resolution = resolveForkUpdateRequest({
			requestedVersion: "0.0.39-fork.9",
			channel,
		});
		expect(resolution.action).toBe("block");
	});
});
