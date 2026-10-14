import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsDriverKind, type VcsDriverKind as VcsDriverKindType } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsProcess from "./VcsProcess.ts";

const ProjectVcsConfig = Schema.Struct({
  vcs: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(VcsDriverKind),
    }),
  ),
  vcsKind: Schema.optional(VcsDriverKind),
});
const ProjectVcsConfigJson = fromLenientJson(ProjectVcsConfig);
const decodeProjectVcsConfigJson = Schema.decodeUnknownEffect(ProjectVcsConfigJson);

type ProjectVcsConfigFile = typeof ProjectVcsConfig.Type;

export interface VcsProjectConfigResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKindType | "auto";
}

export class VcsProjectConfigError extends Schema.TaggedError<VcsProjectConfigError>()(
  "VcsProjectConfigError",
  {
    operation: Schema.Literals(["inspect", "read", "decode"]),
    cwd: Schema.String,
    configPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} VCS project config at ${this.configPath}.`;
  }
}

export class VcsProjectConfig extends Context.Service<
  VcsProjectConfig,
  {
    readonly resolveKind: (
      input: VcsProjectConfigResolveInput,
    ) => Effect.Effect<VcsDriverKindType | "auto">;
  }
>()("t3/vcs/VcsProjectConfig") {}

function configuredKind(config: ProjectVcsConfigFile): VcsDriverKindType | "auto" {
  return config.vcs?.kind ?? config.vcsKind ?? "auto";
}

const logVcsProjectConfigError = (error: VcsProjectConfigError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      cwd: error.cwd,
      configPath: error.configPath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const projectionQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery.ProjectionSnapshotQuery);
  const vcsProcess = yield* Effect.serviceOption(VcsProcess.VcsProcess);

  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".t3code", "vcs.json");
      const exists = yield* fileSystem.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProjectConfigError({
              operation: "inspect",
              cwd,
              configPath: candidate,
              cause,
            }),
        ),
        Effect.catchTags({
          VcsProjectConfigError: (error) => logVcsProjectConfigError(error).pipe(Effect.as(false)),
        }),
      );
      if (exists) {
        return Option.some(candidate);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  // A colocated jj repository (`.jj` beside `.git`) means jj, whatever the saved setting says; the
  // nearest repository root decides, so a plain git repository nested inside one stays git.
  const hasColocatedJj = Effect.fn("VcsProjectConfig.hasColocatedJj")(function* (cwd: string) {
    const exists = (candidate: string) =>
      fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    let current = path.resolve(cwd);
    while (true) {
      const [jj, git] = yield* Effect.all([
        exists(path.join(current, ".jj")),
        exists(path.join(current, ".git")),
      ]);
      if (jj || git) return jj && git;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  });

  const readConfiguredKind = Effect.fn("VcsProjectConfig.readConfiguredKind")(function* (
    cwd: string,
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "read",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeProjectVcsConfigJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "decode",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    return configuredKind(parsed);
  });

  const resolveKind: VcsProjectConfig["Service"]["resolveKind"] = Effect.fn(
    "VcsProjectConfig.resolveKind",
  )(function* (input) {
    if (input.requestedKind !== undefined && input.requestedKind !== "auto") {
      return input.requestedKind;
    }

    const configured = yield* findConfigPath(input.cwd).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed("auto" as const),
          onSome: (configPath) => readConfiguredKind(input.cwd, configPath),
        }),
      ),
      Effect.catchTags({
        VcsProjectConfigError: (error) =>
          logVcsProjectConfigError(error).pipe(Effect.as("auto" as const)),
      }),
    );
    if (configured !== "auto") return configured;
    if (yield* hasColocatedJj(input.cwd)) return "jj";
    if (Option.isNone(settingsService)) return configured;
    const settings = yield* settingsService.value.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings) return "auto";
    const cwd = path.resolve(input.cwd);
    let checkoutCwd = cwd;
    if (Option.isSome(vcsProcess)) {
      const result = yield* vcsProcess.value.run({
        operation: "VcsProjectConfig.checkoutRoots", command: "git", cwd: input.cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
        allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 16_000,
      }).pipe(Effect.orElseSucceed(() => null));
      const [commonDir, workspaceRoot] = result?.exitCode === 0 ? result.stdout.trim().split("\n") : [];
      // Thread workspaces live outside the main checkout, so project roots only match after mapping.
      if (commonDir && workspaceRoot) {
        checkoutCwd = path.join(path.dirname(commonDir), path.relative(workspaceRoot, cwd));
      }
    }
    const projects = Option.isSome(projectionQuery)
      ? yield* projectionQuery.value.getProjectShells().pipe(Effect.orElseSucceed(() => []))
      : [];
    const isWithin = (child: string, parent: string) =>
      child === parent || child.startsWith(parent + path.sep);
    const containing = projects.filter((entry) => {
      const root = path.resolve(entry.workspaceRoot);
      return isWithin(cwd, root) || isWithin(checkoutCwd, root);
    }).sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
    // A workspace root above nested projects belongs to a project only when exactly one candidate exists.
    const nested = projects.filter((entry) => isWithin(path.resolve(entry.workspaceRoot), checkoutCwd));
    const project = containing[0] ?? (nested.length === 1 ? nested[0] : undefined);
    return resolveProjectSettings(settings, project?.id ?? null).settings.versionControlSystem;
  });

  return VcsProjectConfig.of({
    resolveKind,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make);
