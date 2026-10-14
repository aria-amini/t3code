import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsDriverKind, type VcsDriverKind as VcsDriverKindType } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
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
    readonly isJjAvailable: Effect.Effect<boolean>;
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
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const isJjAvailable = yield* Effect.cached(
    vcsProcess
      .run({
        operation: "VcsProjectConfig.jjVersion",
        command: "jj",
        args: ["--version"],
        cwd: ".",
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
  );

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

  // The nearest repository root decides, so a plain Git repository nested inside a colocated jj
  // repository stays Git. An explicit vcs.json choice is resolved before this detection.
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
    return (yield* hasColocatedJj(input.cwd)) && (yield* isJjAvailable) ? "jj" : "auto";
  });

  return VcsProjectConfig.of({
    isJjAvailable,
    resolveKind,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make);
