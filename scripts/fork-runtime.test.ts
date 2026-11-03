import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const mockGh = `#!/bin/bash
set -euo pipefail
[[ "$3" == v0.1.1-fork.999 ]] || exit 19
case "$1 $2" in
  'release view')
    [[ "$SCENARIO" != new ]] ;;
  'release upload'|'release create')
    [[ "$SCENARIO" != upload-failure ]] || exit 18
    echo "$*" >> uploads ;;
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

it.effect.each(["new", "retry", "upload-failure"])(
  "publishes only the versioned release (%s)",
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
        path.join(cwd, "release/t3-0.1.1-fork.999-linux-x64.tar.gz"),
        "x64 runtime archive",
      );
      yield* fs.writeFileString(
        path.join(cwd, "release/t3-0.1.1-fork.999-linux-arm64.tar.gz"),
        "arm64 runtime archive",
      );
      const child = yield* spawner.spawn(
        ChildProcess.make("bash", ["-euo", "pipefail", "-c", script!], {
          cwd,
          env: {
            PATH: `${path.join(cwd, "bin")}:${process.env.PATH}`,
            SCENARIO: scenario,
            GITHUB_SHA: "test-sha",
            GITHUB_RUN_ID: "test-run",
          },
        }),
      );
      const [, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (scenario !== "upload-failure") {
        assert.equal(Number(exitCode), 0, stderr);
        const checksums = yield* fs.readFileString(path.join(cwd, "release/SHA256SUMS"));
        assert.equal(checksums.trim().split("\n").length, 2);
        for (const arch of ["x64", "arm64"]) {
          assert.include(checksums, `t3-0.1.1-fork.999-linux-${arch}.tar.gz`);
        }
        const uploads = yield* fs.readFileString(path.join(cwd, "uploads"));
        assert.include(
          uploads,
          scenario === "new" ? "release create v0.1.1-fork.999" : "release upload v0.1.1-fork.999",
        );
        assert.include(uploads, "release/SHA256SUMS");
        assert.include(uploads, "release/t3-0.1.1-fork.999-linux-arm64.tar.gz");
        assert.include(uploads, "release/t3-0.1.1-fork.999-linux-x64.tar.gz");
      } else {
        assert.notEqual(Number(exitCode), 0);
        assert.isFalse(yield* fs.exists(path.join(cwd, "uploads")));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
