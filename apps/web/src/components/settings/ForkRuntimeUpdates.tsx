import { useState } from "react";
import type { EnvironmentId, ServerConfig, ServerForkUpdates } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ServerUpdateAction } from "../ServerUpdateAction";
import {
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../../versionSkew";

export function ForkRuntimeUpdates({
  environmentId,
  config,
  disabled = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig;
  readonly disabled?: boolean;
}) {
  const check = useAtomCommand(serverEnvironment.checkForkUpdates, { reportFailure: false });
  const [checking, setChecking] = useState(false);
  const [releases, setReleases] = useState<ServerForkUpdates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentVersion = config.environment.serverVersion;
  const latest = releases?.forkVersions[0];
  const targetVersion = latest && compareSemverVersions(latest, currentVersion) > 0 ? latest : null;

  async function checkReleases() {
    setChecking(true);
    setError(null);
    try {
      const result = await check({ environmentId, input: {} });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      setReleases(result.value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check releases. Try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={disabled || checking}
          onClick={() => void checkReleases()}
        >
          {checking ? "Checking releases…" : "Check fork updates"}
        </Button>
        {targetVersion && !disabled ? (
          <ServerUpdateAction
            environmentId={environmentId}
            serverLabel={`${config.environment.label} server`}
            selfUpdate={resolveServerSelfUpdateCapability(config)}
            desktopAppUpdate={supportsDesktopAppUpdate(config)}
            threadContinuation={supportsServerUpdateThreadContinuation(config)}
            targetVersion={targetVersion}
            label={`Update to ${targetVersion}`}
          />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {releases ? (
        <div aria-live="polite" className="space-y-2 text-muted-foreground">
          <p>
            {targetVersion
              ? `Fork ${targetVersion} is available.`
              : releases.forkVersions.length
                ? "Your fork runtime is up to date."
                : "No fork builds are available for this server’s platform."}
          </p>
          {releases.forkVersions.length ? (
            <details>
              <summary className="cursor-pointer">
                Available fork versions ({releases.forkVersions.length})
              </summary>
              <ul className="mt-1 space-y-1">
                {releases.forkVersions.map((version) => (
                  <li key={version}>
                    {version}
                    {version === currentVersion ? " · Installed" : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {releases.upstreamVersion ? (
            <p>
              <a
                className="underline underline-offset-2"
                href={`https://github.com/pingdotgg/t3code/releases/tag/v${releases.upstreamVersion}`}
                target="_blank"
                rel="noreferrer"
              >
                Upstream {releases.upstreamVersion} is available.
              </a>{" "}
              Installed fork base: {currentVersion.split("-", 1)[0]}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
