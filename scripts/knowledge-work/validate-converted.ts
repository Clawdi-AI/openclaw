import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePlaceholders } from "./placeholders.js";

export type ValidateConvertedOptions = {
  skillsDir: string;
  prefixes: string[];
  connectorsPath: string;
};

export type ValidateConvertedResult = {
  violations: string[];
  scannedSkills: number;
  scannedFiles: number;
};

type ConnectorsFile = {
  connectors?: Record<string, unknown>;
};

const CANONICAL_PLACEHOLDER_PATTERN = /~~[a-z0-9][a-z0-9-]*/g;
const CANONICAL_PLACEHOLDER_TOKEN_PATTERN = /^~~[a-z0-9][a-z0-9-]*$/;
const STALE_CONNECTORS_NOTE_PATTERN = /CONNECTORS\.md/i;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function parsePrefixes(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}

function readConnectorKeys(connectorsPath: string): Set<string> {
  const parsed = JSON.parse(fs.readFileSync(connectorsPath, "utf-8")) as ConnectorsFile;
  return new Set(Object.keys(parsed.connectors ?? {}));
}

function listSkillDirectories(skillsDir: string, prefixes: string[]): string[] {
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const prefixMarkers = prefixes.map((prefix) => `${prefix}-`);
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => prefixMarkers.some((marker) => name.startsWith(marker)))
    .toSorted((a, b) => a.localeCompare(b));
}

export function validateConvertedSkills(opts: ValidateConvertedOptions): ValidateConvertedResult {
  const { skillsDir, prefixes, connectorsPath } = opts;
  const violationSet = new Set<string>();

  if (prefixes.length === 0) {
    violationSet.add("No prefixes specified.");
  }
  if (!fs.existsSync(skillsDir)) {
    violationSet.add(`Skills directory does not exist: ${skillsDir}`);
  }
  if (!fs.existsSync(connectorsPath)) {
    violationSet.add(`Connectors file does not exist: ${connectorsPath}`);
  }
  if (violationSet.size > 0) {
    return { violations: [...violationSet], scannedSkills: 0, scannedFiles: 0 };
  }

  const connectorKeys = readConnectorKeys(connectorsPath);
  const skillNames = listSkillDirectories(skillsDir, prefixes);
  let scannedFiles = 0;

  for (const skillName of skillNames) {
    const skillMdPath = path.join(skillsDir, skillName, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      violationSet.add(`${skillName}: missing SKILL.md`);
      continue;
    }

    scannedFiles += 1;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    if (STALE_CONNECTORS_NOTE_PATTERN.test(content)) {
      violationSet.add(`${skillName}: stale CONNECTORS.md reference remains`);
    }

    const normalized = normalizePlaceholders(content);
    if (normalized.text !== content) {
      violationSet.add(
        `${skillName}: contains non-canonical placeholder aliases (run converter normalization)`,
      );
    }

    for (const unknown of [...normalized.unknownPlaceholders].toSorted((a, b) =>
      a.localeCompare(b),
    )) {
      if (!CANONICAL_PLACEHOLDER_TOKEN_PATTERN.test(unknown)) {
        violationSet.add(`${skillName}: contains non-canonical placeholder token ${unknown}`);
      }
    }

    let canonicalScanText = normalized.text;
    for (const unknown of normalized.unknownPlaceholders) {
      if (CANONICAL_PLACEHOLDER_TOKEN_PATTERN.test(unknown)) {
        continue;
      }
      canonicalScanText = canonicalScanText.replaceAll(unknown, " ");
    }

    const placeholders = new Set(canonicalScanText.match(CANONICAL_PLACEHOLDER_PATTERN) ?? []);
    for (const placeholder of [...placeholders].toSorted((a, b) => a.localeCompare(b))) {
      if (!connectorKeys.has(placeholder)) {
        violationSet.add(`${skillName}: placeholder ${placeholder} missing from connectors map`);
      }
    }
  }

  return {
    violations: [...violationSet],
    scannedSkills: skillNames.length,
    scannedFiles,
  };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].includes("validate-converted");

if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  const skillsDir = args["skills-dir"] ?? "skills";
  const prefixes = parsePrefixes(args.prefixes);
  const connectorsPath = args.connectors ?? "extensions/work-connectors/connectors.json";

  const result = validateConvertedSkills({ skillsDir, prefixes, connectorsPath });
  if (result.violations.length > 0) {
    console.error(
      `Validation failed (${result.violations.length} issue${result.violations.length === 1 ? "" : "s"}):`,
    );
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Validation passed: scanned ${result.scannedFiles} SKILL.md files.`);
}
