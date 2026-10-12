import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import { ProjectId } from "@t3tools/contracts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const TestLayer = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("VcsProjectConfig", () => {
  it.layer(TestLayer)("uses an explicit requested VCS kind before config", (it) => {
    it.effect("returns the requested kind", () =>
      Effect.gen(function* () {
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({
          cwd: "/repo",
          requestedKind: "jj",
        });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("discovers .t3code/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("continues to parent configs after a candidate inspect failure", (it) => {
    it.effect("logs the failed candidate and returns the parent config", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const cwd = path.join(root, "invalid\0child");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd });

        assert.equal(kind, "jj");
        const failedCandidate = path.join(cwd, ".t3code", "vcs.json");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to inspect VCS project config at " + failedCandidate + ".",
        );
        assert.deepInclude(error, {
          operation: "inspect",
          cwd,
          configPath: failedCandidate,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when no config exists", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });

  it.layer(TestLayer)("falls back to auto when config JSON is malformed", (it) => {
    it.effect("returns auto and logs the failed operation and path", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "vcs.json"), "{not json");

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to decode VCS project config at " + path.join(configDir, "vcs.json") + ".",
        );
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
        assert.deepInclude(error, {
          operation: "decode",
          cwd: root,
          configPath: path.join(configDir, "vcs.json"),
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when the config path cannot be read", (it) => {
    it.effect("retains the read failure context", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configPath = path.join(root, ".t3code", "vcs.json");
        yield* fileSystem.makeDirectory(configPath, { recursive: true });

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(error.message, "Failed to read VCS project config at " + configPath + ".");
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
        assert.deepInclude(error, {
          operation: "read",
          cwd: root,
          configPath,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when config kind is invalid", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          `{"vcs":{"kind":"svn"}}`,
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });

  describe("matches thread workspaces to nested projects", () => {
    const sourceProject = ProjectId.make("project-src");
    const docsProject = ProjectId.make("project-docs");
    const git = (cwd: string, ...args: Array<string>) =>
      Effect.gen(function* () {
        const vcsProcess = yield* VcsProcess.VcsProcess;
        return yield* vcsProcess.run({
          operation: "VcsProjectConfig.test.git", command: "git", cwd,
          args: ["-c", "user.name=t3", "-c", "user.email=t3@example.com", ...args],
        });
      });

    const resolveInWorkspace = (projectDirectories: ReadonlyArray<string>, relativeCwd: string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-workspace-test-" });
        const repo = path.join(root, "repo");
        const workspace = path.join(root, "workspace");
        for (const directory of ["src", "docs"]) {
          yield* fileSystem.makeDirectory(path.join(repo, directory), { recursive: true });
          yield* fileSystem.writeFileString(path.join(repo, directory, "README.md"), directory);
        }
        yield* git(root, "init", "--quiet", repo);
        yield* git(repo, "add", ".");
        yield* git(repo, "commit", "--quiet", "-m", "init");
        yield* git(repo, "worktree", "add", "--quiet", "--detach", workspace);

        const projects = projectDirectories.map((directory) => ({
          id: directory === "src" ? sourceProject : docsProject,
          workspaceRoot: path.join(repo, directory),
        }));
        const config = yield* VcsProjectConfig.make.pipe(
          Effect.provide(Layer.mergeAll(
            ServerSettings.layerTest({
              projectSettingsOverrides: { [sourceProject]: { versionControlSystem: "jj" } },
            }),
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
              getProjectShells: () => Effect.succeed(projects),
            } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
          )),
        );
        return yield* config.resolveKind({ cwd: path.join(workspace, relativeCwd) });
      }).pipe(Effect.provide(VcsProcess.layer));

    it.layer(NodeServices.layer)("resolves the project setting", (it) => {
      it.effect("uses the only nested project from the workspace root", () =>
        Effect.gen(function* () {
          assert.equal(yield* resolveInWorkspace(["src"], ""), "jj");
        }),
      );
      it.effect("uses the project that contains the mapped workspace path", () =>
        Effect.gen(function* () {
          assert.equal(yield* resolveInWorkspace(["src", "docs"], "src"), "jj");
        }),
      );
      it.effect("falls back to the environment when nested projects are ambiguous", () =>
        Effect.gen(function* () {
          assert.equal(yield* resolveInWorkspace(["src", "docs"], ""), "git");
        }),
      );
    });
  });
});
