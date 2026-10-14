import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { cliArchiveFileName, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

const Assets = Schema.Array(Schema.Struct({ name: Schema.String }));
const Release = Schema.Struct({ id: Schema.Number });
const API_URL = "https://api.github.com/repos/aria-amini/t3code/releases";
const ASSETS_PAGE_SIZE = 100;
const MAX_ASSET_PAGES = 10;

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
  const getJson = <S extends Schema.Top>(url: string, schema: S) =>
    client.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.timeout("10 seconds"),
    );
  // The release object embeds only its first assets, and the rolling release keeps every build.
  const release = yield* getJson(`${API_URL}/tags/fork-runtime`, Release);
  const assets: Array<{ readonly name: string }> = [];
  for (let page = 1; page <= MAX_ASSET_PAGES; page++) {
    const batch = yield* getJson(
      `${API_URL}/${release.id}/assets?per_page=${ASSETS_PAGE_SIZE}&page=${page}`,
      Assets,
    );
    assets.push(...batch);
    if (batch.length < ASSETS_PAGE_SIZE) break;
  }
  return resolveForkUpdateVersion(requested, assets, platform);
});
