import { describe, expect, it } from "@effect/vitest";
import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  checkForkUpdates,
  resolveForkUpdates,
  resolveForkUpdateVersion,
} from "./forkRuntimeChannel.ts";
import { compareExactServiceVersions } from "./serviceProtocol.ts";

const assets = [
  { name: "t3-0.0.44-fork.2-linux-arm64.tar.gz" },
  { name: "t3-0.0.45-fork.1-linux-arm64.tar.gz" },
  { name: "t3-0.0.46-fork.1-linux-x64.tar.gz" },
  { name: "t3-0.0.46-linux-arm64.tar.gz" },
];

describe("fork runtime updates", () => {
  it("redirects to the newest compatible fork archive for the host", () => {
    expect(resolveForkUpdateVersion("0.0.45", assets, "linux-arm64")).toBe("0.0.45-fork.1");
    expect(resolveForkUpdateVersion("0.0.44", assets, "linux-arm64")).toBe("0.0.45-fork.1");
    expect(resolveForkUpdateVersion("0.0.45", assets, "linux-x64")).toBe("0.0.46-fork.1");
  });
  it("blocks unsupported versions and platforms instead of installing upstream", () => {
    expect(resolveForkUpdateVersion("0.0.46", assets, "linux-arm64")).toBeNull();
    expect(resolveForkUpdateVersion("0.0.45", assets, "darwin-arm64")).toBeNull();
    expect(resolveForkUpdateVersion("0.0.45", [], "linux-arm64")).toBeNull();
  });
  it("honors retained exact fork versions", () => {
    expect(resolveForkUpdateVersion("0.0.45-fork.1", assets, "linux-arm64")).toBe("0.0.45-fork.1");
    expect(resolveForkUpdateVersion("0.0.44-fork.2", assets, "linux-arm64")).toBe("0.0.44-fork.2");
    expect(resolveForkUpdateVersion("0.0.44-fork.99", assets, "linux-arm64")).toBeNull();
    expect(resolveForkUpdateVersion("0.0.44-fork.2", assets, "linux-x64")).toBeNull();
  });
  it("uses fork assets and preserves explicit mirror overrides", () => {
    expect(cliReleaseDownloadBaseUrl("0.0.45-fork.1")).toBe(
      "https://github.com/aria-amini/t3code/releases/download/fork-runtime",
    );
    expect(cliReleaseDownloadBaseUrl("0.0.45")).toBe(
      "https://github.com/pingdotgg/t3code/releases/download/v0.0.45",
    );
    expect(cliReleaseDownloadBaseUrl("0.0.45-fork.1", "https://mirror.test/releases")).toBe(
      "https://mirror.test/releases/v0.0.45-fork.1",
    );
  });
  it("allows vanilla-to-fork updates without changing other version precedence", () => {
    expect(compareExactServiceVersions("0.0.45-fork.1", "0.0.45")).toBeGreaterThan(0);
    expect(compareExactServiceVersions("0.0.45", "0.0.45-fork.1")).toBeLessThan(0);
    expect(compareExactServiceVersions("0.0.45-fork.2", "0.0.45-fork.1")).toBeGreaterThan(0);
    expect(compareExactServiceVersions("0.0.45-fork.1", "0.0.46")).toBeLessThan(0);
    expect(compareExactServiceVersions("0.0.45-preview.1", "0.0.45")).toBeLessThan(0);
  });
});

it("orders fork builds consistently above all same-core upstream versions", () => {
  const ordered = [
    "0.0.45-nightly.1",
    "0.0.45-preview.1",
    "0.0.45-rc.1",
    "0.0.45",
    "0.0.45-fork.1",
    "0.0.45-fork.2",
    "0.0.46-preview.1",
    "0.0.46",
  ];
  for (const [leftIndex, left] of ordered.entries()) {
    for (const [rightIndex, right] of ordered.entries()) {
      expect(Math.sign(compareExactServiceVersions(left, right))).toBe(
        Math.sign(leftIndex - rightIndex),
      );
    }
  }
});

it("lists compatible retained fork builds and only announces a newer upstream base", () => {
  const builds = [
    { name: "t3-0.0.45-fork.26001-linux-x64.tar.gz" },
    { name: "t3-0.0.45-fork.29001-linux-x64.tar.gz" },
    { name: "t3-0.0.45-fork.29001-linux-x64.tar.gz" },
    { name: "t3-0.0.46-fork.1-linux-arm64.tar.gz" },
    { name: "t3-0.0.46-linux-x64.tar.gz" },
  ];
  const current = "0.0.45-fork.26001";
  const available = resolveForkUpdates(current, builds, "linux-x64", "v0.0.46");
  expect(available).toEqual({
    currentVersion: current,
    forkVersions: ["0.0.45-fork.29001", "0.0.45-fork.26001"],
    upstreamVersion: "0.0.46",
  });
  for (const upstream of ["v0.0.45", "v0.0.44", "v0.0.46-preview.1", "fork-runtime"]) {
    expect(resolveForkUpdates(current, builds, "linux-x64", upstream).upstreamVersion).toBeNull();
  }
  expect(resolveForkUpdates(current, builds, "darwin-arm64", "v0.0.46").forkVersions).toEqual([]);
});

it.effect("checks fork builds and upstream releases through the HTTP client", () =>
  checkForkUpdates("0.0.45-fork.26001", "linux-x64").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/fork-runtime")
                ? { assets: [{ name: "t3-0.0.45-fork.29001-linux-x64.tar.gz" }] }
                : { tag_name: "v0.0.46" },
            ),
          ),
        ),
      ),
    ),
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.forkVersions).toEqual(["0.0.45-fork.29001"]);
        expect(result.upstreamVersion).toBe("0.0.46");
      }),
    ),
  ),
);

it.effect("fails visibly when a release source is unavailable", () =>
  checkForkUpdates("0.0.45-fork.26001", "linux-x64").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("rate limited", { status: 403 })),
        ),
      ),
    ),
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error).toBeDefined())),
  ),
);
