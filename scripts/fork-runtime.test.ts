import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const oldChecksum = `${"a".repeat(64)}  t3-0.0.45-fork.1-linux-x64.tar.gz`;
const mockGh = `#!/bin/bash
set -euo pipefail
case "$1 $2" in
  'release view')
    if [[ "$*" == *--json* ]]; then
      case "$SCENARIO" in
        checksums|download-failure) printf '%s\\n' SHA256SUMS old.tar.gz ;;
        archives-only) echo old.tar.gz ;;
        query-failure) exit 17 ;;
      esac
    fi ;;
  'release download')
    if [[ "$SCENARIO" == download-failure ]]; then exit 18; fi
    printf '%s\\n' "$OLD_CHECKSUM" > previous/SHA256SUMS ;;
  'release upload'|'release create') echo "$*" >> uploads ;;
  *) exit 19 ;;
esac
`;
const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );

it.effect.each(["empty", "checksums", "archives-only", "download-failure", "query-failure"])(
  "publishes rolling fork runtime safely with %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workflow = yield* fs.readFileString(
        path.join(import.meta.dirname, "../.github/workflows/fork-runtime.yml"),
      );
      const step = workflow
        .split("      - name: Publish runtime\n")[1]
        ?.split("  # New upstream workflows")[0];
      const script = step
        ?.split("        run: |\n")[1]
        ?.split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      assert.isDefined(script);
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-publish-test-" });
      yield* fs.makeDirectory(path.join(cwd, "release"));
      yield* fs.makeDirectory(path.join(cwd, "bin"));
      yield* fs.writeFileString(path.join(cwd, "bin/gh"), mockGh);
      yield* fs.chmod(path.join(cwd, "bin/gh"), 0o755);
      yield* fs.writeFileString(
        path.join(cwd, "release/t3-0.0.45-fork.999-linux-x64.tar.gz"),
        "runtime archive",
      );
      const child = yield* spawner.spawn(
        ChildProcess.make("bash", ["-euo", "pipefail", "-c", script!], {
          cwd,
          env: {
            PATH: `${path.join(cwd, "bin")}:${process.env.PATH}`,
            SCENARIO: scenario,
            OLD_CHECKSUM: oldChecksum,
            GITHUB_SHA: "test-sha",
            GITHUB_RUN_ID: "test-run",
          },
        }),
      );
      const [, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (scenario === "empty" || scenario === "checksums") {
        assert.equal(Number(exitCode), 0, stderr);
        const rolling = yield* fs.readFileString(path.join(cwd, "release/SHA256SUMS"));
        assert.include(rolling, "t3-0.0.45-fork.999-linux-x64.tar.gz");
        assert.equal(rolling.includes(oldChecksum), scenario === "checksums");
        const retained = yield* fs.readFileString(path.join(cwd, "retained/SHA256SUMS"));
        assert.notInclude(retained, oldChecksum);
        const uploads = yield* fs.readFileString(path.join(cwd, "uploads"));
        assert.include(uploads, "release upload fork-runtime");
        assert.include(uploads, "release upload v0.0.45-fork.999");
      } else {
        assert.notEqual(Number(exitCode), 0);
        assert.isFalse(yield* fs.exists(path.join(cwd, "uploads")));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
