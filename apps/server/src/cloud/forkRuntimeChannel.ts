import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { cliArchiveFileName, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import type { ServerForkUpdates } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

const Release = Schema.Struct({
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const RELEASE_URL = "https://api.github.com/repos/aria-amini/t3code/releases/tags/fork-runtime";

function forkVersionsForPlatform(
  assets: ReadonlyArray<{ readonly name: string }>,
  platform: CliArchivePlatformKey,
) {
  return [
    ...new Set(
      assets.flatMap(({ name }) => {
        const version = /^t3-(\d+\.\d+\.\d+-fork\.\d+)-/u.exec(name)?.[1];
        return version && name === cliArchiveFileName(version, platform) ? [version] : [];
      }),
    ),
  ].sort((a, b) => compareSemverVersions(b, a));
}

export function resolveForkUpdateVersion(
  requested: string,
  assets: ReadonlyArray<{ readonly name: string }>,
  platform: CliArchivePlatformKey,
): string | null {
  const versions = forkVersionsForPlatform(assets, platform);
  if (requested.includes("-fork.")) return versions.includes(requested) ? requested : null;
  const core = requested.split(/[-+]/u, 1)[0] ?? requested;
  if (parseSemver(core) === null) return null;
  return (
    versions.find((version) => compareSemverVersions(version.split("-", 1)[0]!, core) >= 0) ?? null
  );
}

export const latestForkUpdateVersion = Effect.fn("cloud.fork_runtime_channel.latest")(function* (
  requested: string,
  platform: CliArchivePlatformKey,
) {
  const client = yield* HttpClient.HttpClient;
  const release = yield* client
    .execute(HttpClientRequest.get(RELEASE_URL))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Release)),
      Effect.timeout("10 seconds"),
    );
  return resolveForkUpdateVersion(requested, release.assets, platform);
});

export function resolveForkUpdates(
  currentVersion: string,
  assets: ReadonlyArray<{ readonly name: string }>,
  platform: CliArchivePlatformKey,
  upstreamTag: string,
): ServerForkUpdates {
  const upstream = upstreamTag.replace(/^v/u, "");
  const parsed = parseSemver(upstream);
  const core = currentVersion.split("-", 1)[0]!;
  return {
    currentVersion,
    forkVersions: forkVersionsForPlatform(assets, platform),
    upstreamVersion:
      parsed !== null &&
      /^\d+\.\d+\.\d+$/u.test(upstream) &&
      compareSemverVersions(upstream, core) > 0
        ? upstream
        : null,
  };
}

export const checkForkUpdates = Effect.fn("cloud.fork_runtime_channel.check")(function* (
  currentVersion: string,
  platform: CliArchivePlatformKey,
) {
  const client = yield* HttpClient.HttpClient;
  const [release, upstream] = yield* Effect.all(
    [
      client
        .execute(HttpClientRequest.get(RELEASE_URL))
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Release)),
        ),
      client
        .execute(
          HttpClientRequest.get("https://api.github.com/repos/pingdotgg/t3code/releases/latest"),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(Schema.Struct({ tag_name: Schema.String })),
          ),
        ),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.timeout("10 seconds"));
  return resolveForkUpdates(currentVersion, release.assets, platform, upstream.tag_name);
});
