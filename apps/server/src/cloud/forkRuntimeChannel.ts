import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { cliArchiveFileName, type CliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as HostProcess from "@t3tools/shared/HostProcess";

const Assets = Schema.Array(Schema.Struct({ name: Schema.String }));
const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    assets: Assets,
  }),
);
const API_URL = "https://api.github.com/repos/aria-amini/t3code/releases";
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 10;

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
  const environment = yield* HostProcess.Environment;
  const token = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim();
  const assets: Array<{ readonly name: string }> = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const request = HttpClientRequest.get(
      `${API_URL}?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
    ).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github+json"));
    const releases = yield* client
      .execute(
        token ? HttpClientRequest.setHeader(request, "Authorization", `Bearer ${token}`) : request,
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Releases)),
        Effect.timeout("10 seconds"),
      );
    for (const release of releases) {
      if (release.draft || !/^v\d+\.\d+\.\d+-fork\.\d+$/u.test(release.tag_name)) continue;
      const fileName = cliArchiveFileName(release.tag_name.slice(1), platform);
      assets.push(...release.assets.filter((asset) => asset.name === fileName));
    }
    if (releases.length < RELEASE_PAGE_SIZE) break;
  }
  return resolveForkUpdateVersion(requested, assets, platform);
});
