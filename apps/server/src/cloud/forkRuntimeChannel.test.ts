import { describe, expect, it } from "@effect/vitest";
import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import { latestForkUpdateVersion, resolveForkUpdateVersion } from "./forkRuntimeChannel.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";
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
      "https://github.com/aria-amini/t3code/releases/download/v0.0.45-fork.1",
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

it.effect(
  "discovers the newest compatible version across release pages without using rolling assets",
  () =>
    Effect.gen(function* () {
      const pages: string[] = [];
      const client = HttpClient.make((request) => {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/repos/aria-amini/t3code/releases");
        expect(request.headers.authorization).toBe("Bearer test-token");
        const page = url.searchParams.get("page")!;
        pages.push(page);
        const releases =
          page === "1"
            ? [
                {
                  tag_name: "fork-runtime",
                  assets: [{ name: "t3-9.0.0-fork.99-linux-arm64.tar.gz" }],
                },
                {
                  tag_name: "v9.0.0-fork.2",
                  draft: true,
                  assets: [{ name: "t3-9.0.0-fork.2-linux-arm64.tar.gz" }],
                },
                {
                  tag_name: "v9.0.0-fork.1",
                  assets: [{ name: "t3-9.0.0-fork.1-linux-x64.tar.gz" }],
                },
                {
                  tag_name: "v0.1.1-fork.37",
                  assets: [{ name: "t3-9.0.0-fork.1-linux-arm64.tar.gz" }],
                },
                ...Array.from({ length: 96 }, () => ({ tag_name: "v0.1.1", assets: [] })),
              ]
            : [
                {
                  tag_name: "v0.1.1-fork.36",
                  assets: [{ name: "t3-0.1.1-fork.36-linux-arm64.tar.gz" }],
                },
                {
                  tag_name: "v0.1.0-fork.33",
                  assets: [{ name: "t3-0.1.0-fork.33-linux-arm64.tar.gz" }],
                },
              ];
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(releases)));
      });
      const version = yield* latestForkUpdateVersion("0.1.0", "linux-arm64").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Environment, { GH_TOKEN: "test-token" }),
      );
      expect(version).toBe("0.1.1-fork.36");
      expect(pages).toEqual(["1", "2"]);
    }),
);

it.effect.each(["unavailable", "invalid"] as const)(
  "fails closed when the release index is %s",
  (scenario) =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            scenario === "unavailable"
              ? new Response("unavailable", { status: 503 })
              : Response.json({ unexpected: true }),
          ),
        ),
      );
      const exit = yield* latestForkUpdateVersion("0.1.1", "linux-arm64").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
);

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
