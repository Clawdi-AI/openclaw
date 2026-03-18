import * as fs from "node:fs";
import * as path from "node:path";
import { convertPlugin } from "../convert-knowledge-work.js";

export type ImportManifestEntry = {
  sourceDir: string;
  prefix: string;
  emoji: string;
  enabled: boolean;
};

export type ImportManifest = {
  plugins: ImportManifestEntry[];
};

export type ImportKnowledgeWorkOptions = {
  manifestPath: string;
  outputDir: string;
  onlyPrefixes: string[];
  dryRun: boolean;
};

export type ImportPluginResult = {
  prefix: string;
  sourceDir: string;
  enabled: boolean;
  selected: boolean;
  skillsWritten: number;
  commandsWritten: number;
  warnings: string[];
};

export type ImportKnowledgeWorkResult = {
  dryRun: boolean;
  outputDir: string;
  pluginsProcessed: number;
  pluginsSkipped: number;
  skillsWritten: number;
  commandsWritten: number;
  warnings: string[];
  pluginResults: ImportPluginResult[];
};

function parseArgs(argv: string[]): { values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      flags.add(key);
    }
  }

  return { values, flags };
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveFromManifest(manifestPath: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(path.dirname(manifestPath), targetPath);
}

function readImportManifest(manifestPath: string): ImportManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Partial<ImportManifest>;
  const plugins = raw.plugins ?? [];
  if (!Array.isArray(plugins)) {
    throw new Error(`Manifest "plugins" must be an array: ${manifestPath}`);
  }

  for (const [index, plugin] of plugins.entries()) {
    if (!plugin || typeof plugin !== "object") {
      throw new Error(`Manifest plugin entry at index ${index} is not an object.`);
    }

    const entry = plugin as Partial<ImportManifestEntry>;
    if (!entry.sourceDir || !entry.prefix || !entry.emoji || typeof entry.enabled !== "boolean") {
      throw new Error(
        `Manifest plugin entry at index ${index} must include sourceDir, prefix, emoji, enabled.`,
      );
    }
  }

  return { plugins: plugins };
}

export function importKnowledgeWorkFromManifest(
  options: ImportKnowledgeWorkOptions,
): ImportKnowledgeWorkResult {
  const manifestPath = path.resolve(options.manifestPath);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = readImportManifest(manifestPath);
  const outputDir = path.resolve(options.outputDir);
  const onlySet = new Set(options.onlyPrefixes);
  const warnings: string[] = [];
  const pluginResults: ImportPluginResult[] = [];
  let skillsWritten = 0;
  let commandsWritten = 0;
  let pluginsProcessed = 0;
  let pluginsSkipped = 0;

  for (const plugin of manifest.plugins) {
    const resolvedSourceDir = resolveFromManifest(manifestPath, plugin.sourceDir);
    const selectedByPrefix = onlySet.size === 0 || onlySet.has(plugin.prefix);
    const selected = plugin.enabled && selectedByPrefix;
    if (!selected) {
      pluginsSkipped += 1;
      pluginResults.push({
        prefix: plugin.prefix,
        sourceDir: resolvedSourceDir,
        enabled: plugin.enabled,
        selected: false,
        skillsWritten: 0,
        commandsWritten: 0,
        warnings: [],
      });
      continue;
    }

    if (!fs.existsSync(resolvedSourceDir)) {
      throw new Error(`Source plugin directory not found: ${resolvedSourceDir}`);
    }

    pluginsProcessed += 1;
    const result = convertPlugin({
      inputDir: resolvedSourceDir,
      outputDir,
      prefix: plugin.prefix,
      emoji: plugin.emoji,
      dryRun: options.dryRun,
    });

    skillsWritten += result.skillsWritten.length;
    commandsWritten += result.commandsWritten.length;
    const prefixedWarnings = result.warnings.map((warning) => `[${plugin.prefix}] ${warning}`);
    warnings.push(...prefixedWarnings);

    pluginResults.push({
      prefix: plugin.prefix,
      sourceDir: resolvedSourceDir,
      enabled: plugin.enabled,
      selected: true,
      skillsWritten: result.skillsWritten.length,
      commandsWritten: result.commandsWritten.length,
      warnings: prefixedWarnings,
    });
  }

  return {
    dryRun: options.dryRun,
    outputDir,
    pluginsProcessed,
    pluginsSkipped,
    skillsWritten,
    commandsWritten,
    warnings,
    pluginResults,
  };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].includes("import-knowledge-work");

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.values.manifest ?? "scripts/knowledge-work/import-manifest.json";
  const outputDir = args.values.output ?? "skills";
  const onlyPrefixes = parseCsv(args.values.only);
  const dryRun = args.flags.has("dry-run");

  const result = importKnowledgeWorkFromManifest({
    manifestPath,
    outputDir,
    onlyPrefixes,
    dryRun,
  });

  console.log(`Knowledge-work import summary${result.dryRun ? " (dry-run)" : ""}:`);
  console.log(`  Plugins processed: ${result.pluginsProcessed}`);
  console.log(`  Plugins skipped: ${result.pluginsSkipped}`);
  console.log(`  Skills converted: ${result.skillsWritten}`);
  console.log(`  Commands converted: ${result.commandsWritten}`);

  for (const plugin of result.pluginResults) {
    const status = plugin.selected ? "processed" : "skipped";
    console.log(
      `  - ${plugin.prefix}: ${status} (skills=${plugin.skillsWritten}, commands=${plugin.commandsWritten})`,
    );
  }

  if (result.warnings.length > 0) {
    console.log("  Warnings:");
    for (const warning of result.warnings) {
      console.log(`    - ${warning}`);
    }
  }

  const validatePrefixes = result.pluginResults
    .filter((plugin) => plugin.selected)
    .map((plugin) => plugin.prefix)
    .join(",");
  console.log(
    `Next: bun scripts/knowledge-work/validate-converted.ts --skills-dir ${outputDir} --prefixes ${validatePrefixes} --connectors extensions/work-connectors/connectors.json`,
  );
}
