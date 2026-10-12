import { describe, expect, it } from "@effect/vitest";
import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import { resolveForkUpdateVersion } from "./forkRuntimeChannel.ts";
import { compareExactServiceVersions } from "./serviceProtocol.ts";

const assets = [
	{ name: "t3-0.0.44-fork.2-linux-arm64.tar.gz" },
	{ name: "t3-0.0.45-fork.1-linux-arm64.tar.gz" },
	{ name: "t3-0.0.46-fork.1-linux-x64.tar.gz" },
	{ name: "t3-0.0.46-linux-arm64.tar.gz" },
];

describe("fork runtime updates", () => {
	it("redirects to the newest compatible fork archive for the host", () => {
		expect(resolveForkUpdateVersion("0.0.45", assets, "linux-arm64")).toBe(
			"0.0.45-fork.1",
		);
		expect(resolveForkUpdateVersion("0.0.44", assets, "linux-arm64")).toBe(
			"0.0.45-fork.1",
		);
		expect(resolveForkUpdateVersion("0.0.45", assets, "linux-x64")).toBe(
			"0.0.46-fork.1",
		);
	});
	it("blocks unsupported versions and platforms instead of installing upstream", () => {
		expect(
			resolveForkUpdateVersion("0.0.46", assets, "linux-arm64"),
		).toBeNull();
		expect(
			resolveForkUpdateVersion("0.0.45", assets, "darwin-arm64"),
		).toBeNull();
		expect(resolveForkUpdateVersion("0.0.45", [], "linux-arm64")).toBeNull();
	});
	it("honors only the current exact fork version", () => {
		expect(
			resolveForkUpdateVersion("0.0.45-fork.1", assets, "linux-arm64"),
		).toBe("0.0.45-fork.1");
		expect(
			resolveForkUpdateVersion("0.0.44-fork.2", assets, "linux-arm64"),
		).toBeNull();
	});
	it("uses fork assets and preserves explicit mirror overrides", () => {
		expect(cliReleaseDownloadBaseUrl("0.0.45-fork.1")).toBe(
			"https://github.com/aria-amini/t3code/releases/download/fork-runtime",
		);
		expect(cliReleaseDownloadBaseUrl("0.0.45")).toBe(
			"https://github.com/pingdotgg/t3code/releases/download/v0.0.45",
		);
		expect(
			cliReleaseDownloadBaseUrl(
				"0.0.45-fork.1",
				"https://mirror.test/releases",
			),
		).toBe("https://mirror.test/releases/v0.0.45-fork.1");
	});
	it("allows vanilla-to-fork updates without changing other version precedence", () => {
		expect(
			compareExactServiceVersions("0.0.45-fork.1", "0.0.45"),
		).toBeGreaterThan(0);
		expect(compareExactServiceVersions("0.0.45", "0.0.45-fork.1")).toBeLessThan(
			0,
		);
		expect(
			compareExactServiceVersions("0.0.45-fork.2", "0.0.45-fork.1"),
		).toBeGreaterThan(0);
		expect(compareExactServiceVersions("0.0.45-fork.1", "0.0.46")).toBeLessThan(
			0,
		);
		expect(
			compareExactServiceVersions("0.0.45-preview.1", "0.0.45"),
		).toBeLessThan(0);
	});
});
