// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain CI utility: direct path I/O and progress output without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

// pnpm deploy resolves `catalog:` deps into node_modules but leaves the
// protocol in the emitted manifest (pnpm/pnpm#8996), so tarballs packed from
// a deploy dir fail `npm install` with `Unsupported URL Type "catalog:"`.
// Rewrite runtime dependency specs against the workspace catalog before packing.
const WorkspaceCatalog = Schema.Struct({
	catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const dependencyFields = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

const deployDir = process.argv[2];
if (deployDir === undefined) {
	console.error("usage: node scripts/rewrite-runtime-manifest.ts <deploy-dir>");
	process.exit(1);
}

try {
	const repoRoot = NodePath.resolve(import.meta.dirname, "..");
	const workspaceYaml = await NodeFSP.readFile(
		NodePath.join(repoRoot, "pnpm-workspace.yaml"),
		"utf8",
	);
	const workspace = await Effect.runPromise(
		Schema.decodeEffect(fromYaml(WorkspaceCatalog))(workspaceYaml),
	);
	const catalog = workspace.catalog ?? {};

	const manifestPath = NodePath.join(deployDir, "package.json");
	const manifest: {
		name?: string;
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	} = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
	const workspacePackage = manifest.name ?? deployDir;

	let changed = 0;
	for (const field of dependencyFields) {
		const deps = manifest[field];
		if (deps === undefined) {
			continue;
		}
		const resolved = resolveCatalogDependencies(
			deps,
			catalog,
			workspacePackage,
		);
		for (const [name, spec] of Object.entries(deps)) {
			if (resolved[name] !== spec) {
				console.log(`${field}: ${name}: ${spec} -> ${resolved[name]}`);
				changed += 1;
			}
		}
		manifest[field] = resolved;
	}

	if (changed === 0) {
		console.log("runtime manifest has no catalog: specs; nothing to rewrite");
		process.exit(0);
	}
	await NodeFSP.writeFile(
		manifestPath,
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
} catch (error) {
	console.error(
		error instanceof Error ? error.message : `failed: ${String(error)}`,
	);
	process.exit(1);
}
