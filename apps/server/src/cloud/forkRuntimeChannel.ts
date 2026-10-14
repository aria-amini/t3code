import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { cliArchiveFileName, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

const Release = Schema.Struct({
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const RELEASE_URL = "https://api.github.com/repos/aria-amini/t3code/releases/tags/fork-runtime";

export function resolveForkUpdateVersion(
  requested: string,
  assets: ReadonlyArray<{ readonly name: string }>,
  platform: CliArchivePlatformKey,
): string | null {
  const versions = assets
    .flatMap(({ name }) => {
      const version = /^t3-(\d+\.\d+\.\d+-fork\.\d+)-/u.exec(name)?.[1];
      return version && name === cliArchiveFileName(version, platform) ? [version] : [];
    })
    .sort((a, b) => compareSemverVersions(b, a));
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
