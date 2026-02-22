#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FileGroupConfig = {
  id: string;
  label: string;
  globs: string[];
};

type ScorecardConfig = {
  id: string;
  label: string;
  excludeFromDenominator?: string[];
  gapStatuses?: string[];
  weights: Record<string, number>;
  checks: Record<string, string>;
};

type MetricsConfig = {
  defaultRef: string;
  groups: FileGroupConfig[];
  scorecards?: ScorecardConfig[];
};

type NumstatEntry = {
  file: string;
  ins: number;
  del: number;
};

type GroupResult = {
  id: string;
  label: string;
  files: number;
  ins: number;
  del: number;
};

type ScorecardResult = {
  id: string;
  label: string;
  score: number;
  weightedPoints: number;
  total: number;
  applicable: number;
  excluded: number;
  counts: Record<string, number>;
  gaps: string[];
};

type MetricsResult = {
  ref: string;
  commit: string;
  groups: GroupResult[];
  ungrouped: { files: number; ins: number; del: number };
  totals: { files: number; ins: number; del: number; complexityLines: number };
  patch: { files: number; ins: number; del: number; lines: number };
  newFiles: { files: number; ins: number };
  scorecards: ScorecardResult[];
};

type CliArgs = {
  ref?: string;
  commit: string;
  compare?: string;
  json: boolean;
  help: boolean;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "patch-metrics.config.json");

function git(args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function readConfig() {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as MetricsConfig;
  if (!parsed.defaultRef || !Array.isArray(parsed.groups)) {
    throw new Error(`Invalid config at ${configPath}`);
  }
  return parsed;
}

function globToRegex(glob: string) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (glob[i] === "/") {
        i++;
      }
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (".()[]{}+^$|\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function parseNumstat(ref: string, commit: string): NumstatEntry[] {
  const raw = git(["diff", "--numstat", `${ref}...${commit}`]);
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) {
        throw new Error(`Unexpected numstat line: ${line}`);
      }
      const insRaw = parts[0];
      const delRaw = parts[1];
      const file = parts.slice(2).join("\t");
      return {
        file,
        ins: insRaw === "-" ? 0 : Number(insRaw),
        del: delRaw === "-" ? 0 : Number(delRaw),
      };
    });
}

function diffFilterSet(ref: string, commit: string, filter: string) {
  const raw = git(["diff", `--diff-filter=${filter}`, "--name-only", `${ref}...${commit}`]);
  if (!raw) {
    return new Set<string>();
  }
  return new Set(raw.split("\n").filter(Boolean));
}

function computeScorecard(scorecard: ScorecardConfig): ScorecardResult {
  const checks = Object.entries(scorecard.checks);
  const excluded = new Set(scorecard.excludeFromDenominator ?? []);
  const configuredGapStatuses = scorecard.gapStatuses;
  const gapStatuses = configuredGapStatuses ? new Set(configuredGapStatuses) : null;

  const counts: Record<string, number> = {};
  const gaps: string[] = [];
  let applicable = 0;
  let weightedPoints = 0;

  for (const [checkId, status] of checks) {
    counts[status] = (counts[status] ?? 0) + 1;
    if (!excluded.has(status)) {
      applicable += 1;
      weightedPoints += scorecard.weights[status] ?? 0;
    }
    const isGap = gapStatuses
      ? gapStatuses.has(status)
      : !excluded.has(status) && (scorecard.weights[status] ?? 0) < 1;
    if (isGap) {
      gaps.push(checkId);
    }
  }

  const total = checks.length;
  const excludedCount = total - applicable;
  const score = applicable > 0 ? (weightedPoints / applicable) * 100 : 0;
  return {
    id: scorecard.id,
    label: scorecard.label,
    score,
    weightedPoints,
    total,
    applicable,
    excluded: excludedCount,
    counts,
    gaps,
  };
}

function computeMetrics(config: MetricsConfig, ref: string, commit: string): MetricsResult {
  const stats = parseNumstat(ref, commit);
  const modified = diffFilterSet(ref, commit, "M");
  const added = diffFilterSet(ref, commit, "A");

  const groupedStats = config.groups.map((group) => ({
    id: group.id,
    label: group.label,
    regexes: group.globs.map((glob) => globToRegex(glob)),
    files: 0,
    ins: 0,
    del: 0,
  }));

  const ungrouped = { files: 0, ins: 0, del: 0 };
  let patchFiles = 0;
  let patchIns = 0;
  let patchDel = 0;
  let newFiles = 0;
  let newIns = 0;

  for (const entry of stats) {
    const match = groupedStats.find((group) =>
      group.regexes.some((regex) => regex.test(entry.file)),
    );
    if (match) {
      match.files += 1;
      match.ins += entry.ins;
      match.del += entry.del;
    } else {
      ungrouped.files += 1;
      ungrouped.ins += entry.ins;
      ungrouped.del += entry.del;
    }

    if (modified.has(entry.file)) {
      patchFiles += 1;
      patchIns += entry.ins;
      patchDel += entry.del;
    }
    if (added.has(entry.file)) {
      newFiles += 1;
      newIns += entry.ins;
    }
  }

  const totalIns = stats.reduce((sum, entry) => sum + entry.ins, 0);
  const totalDel = stats.reduce((sum, entry) => sum + entry.del, 0);
  const scorecards = (config.scorecards ?? []).map((scorecard) => computeScorecard(scorecard));

  return {
    ref,
    commit,
    groups: groupedStats.map(({ id, label, files, ins, del }) => ({ id, label, files, ins, del })),
    ungrouped,
    totals: {
      files: stats.length,
      ins: totalIns,
      del: totalDel,
      complexityLines: totalIns + totalDel,
    },
    patch: {
      files: patchFiles,
      ins: patchIns,
      del: patchDel,
      lines: patchIns + patchDel,
    },
    newFiles: {
      files: newFiles,
      ins: newIns,
    },
    scorecards,
  };
}

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function renderHuman(metrics: MetricsResult) {
  const lines: string[] = [];
  lines.push(`Patch Metrics: ${metrics.commit} vs ${metrics.ref}`);
  lines.push("");

  const rows = [
    ...metrics.groups.map((group) => ({
      label: group.label,
      files: group.files,
      ins: group.ins,
      del: group.del,
    })),
    {
      label: "(ungrouped)",
      files: metrics.ungrouped.files,
      ins: metrics.ungrouped.ins,
      del: metrics.ungrouped.del,
    },
  ];
  const labelWidth = Math.max(24, ...rows.map((row) => row.label.length));
  const numWidth = 12;
  const header = `  ${"Group".padEnd(labelWidth)}  ${"Files".padStart(7)}  ${"Insertions".padStart(numWidth)}  ${"Deletions".padStart(numWidth)}`;
  const sep = `  ${"\u2500".repeat(labelWidth + 7 + numWidth * 2 + 6)}`;

  lines.push(header);
  lines.push(sep);
  for (const row of rows) {
    const ins = row.ins > 0 ? `+${fmt(row.ins)}` : "-";
    const del = row.del > 0 ? `-${fmt(row.del)}` : "-";
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${String(row.files).padStart(7)}  ${ins.padStart(numWidth)}  ${del.padStart(numWidth)}`,
    );
  }
  lines.push(sep);
  const totalIns = metrics.totals.ins > 0 ? `+${fmt(metrics.totals.ins)}` : "-";
  const totalDel = metrics.totals.del > 0 ? `-${fmt(metrics.totals.del)}` : "-";
  lines.push(
    `  ${"Total".padEnd(labelWidth)}  ${String(metrics.totals.files).padStart(7)}  ${totalIns.padStart(numWidth)}  ${totalDel.padStart(numWidth)}`,
  );
  lines.push("");

  lines.push(
    `  Patch size (modified only):  ${metrics.patch.files} files, +${fmt(metrics.patch.ins)} / -${fmt(metrics.patch.del)} (${fmt(metrics.patch.lines)} lines)`,
  );
  lines.push(
    `  New files:                   ${metrics.newFiles.files} files, +${fmt(metrics.newFiles.ins)}`,
  );
  lines.push(`  Complexity:                  ${fmt(metrics.totals.complexityLines)} lines`);
  lines.push("");

  for (const scorecard of metrics.scorecards) {
    const countText = Object.entries(scorecard.counts)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    lines.push(
      `  ${scorecard.label}: ${scorecard.score.toFixed(1)}% (${countText}; ${scorecard.applicable}/${scorecard.total} applicable)`,
    );
    if (scorecard.gaps.length > 0) {
      lines.push(`  ${scorecard.label} gaps: ${scorecard.gaps.join(", ")}`);
    }
    lines.push("");
  }

  console.log(lines.join("\n"));
}

function readGroupLines(metrics: MetricsResult, groupId: string) {
  const group = metrics.groups.find((entry) => entry.id === groupId);
  if (!group) {
    return 0;
  }
  return group.ins + group.del;
}

function renderCompare(base: MetricsResult, pr: MetricsResult, baseName: string) {
  const groupRows = pr.groups.map((prGroup) => ({
    label: `${prGroup.label} (lines)`,
    baseValue: readGroupLines(base, prGroup.id),
    prValue: prGroup.ins + prGroup.del,
  }));
  const metricWidth = Math.max(
    30,
    ...[
      "Patch size (lines)",
      "Complexity (lines)",
      ...groupRows.map((row) => row.label),
      ...pr.scorecards.map((scorecard) => scorecard.label),
    ].map((label) => label.length),
  );

  const lines: string[] = [];
  lines.push(`Patch Metrics: PR (${pr.commit}) vs base (${baseName}) — ref ${pr.ref}`);
  lines.push("");

  const numWidth = 12;
  const header = `  ${"Metric".padEnd(metricWidth)}  ${"Base".padStart(numWidth)}  ${"PR".padStart(numWidth)}  ${"Delta".padStart(numWidth)}`;
  const sep = `  ${"\u2500".repeat(metricWidth + numWidth * 3 + 6)}`;
  lines.push(header);
  lines.push(sep);

  const addNumberRow = (label: string, baseValue: number, prValue: number, suffix = "") => {
    const delta = prValue - baseValue;
    const deltaText = `${delta >= 0 ? "+" : ""}${fmt(delta)}${suffix}`;
    lines.push(
      `  ${label.padEnd(metricWidth)}  ${fmt(baseValue).padStart(numWidth)}  ${fmt(prValue).padStart(numWidth)}  ${deltaText.padStart(numWidth)}`,
    );
  };

  addNumberRow("Patch size (lines)", base.patch.lines, pr.patch.lines);
  addNumberRow("Complexity (lines)", base.totals.complexityLines, pr.totals.complexityLines);
  for (const row of groupRows) {
    addNumberRow(row.label, row.baseValue, row.prValue);
  }

  for (const prScorecard of pr.scorecards) {
    const baseScorecard = base.scorecards.find((entry) => entry.id === prScorecard.id);
    if (!baseScorecard) {
      continue;
    }
    const delta = prScorecard.score - baseScorecard.score;
    const deltaText = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`;
    lines.push(
      `  ${prScorecard.label.padEnd(metricWidth)}  ${`${baseScorecard.score.toFixed(1)}%`.padStart(numWidth)}  ${`${prScorecard.score.toFixed(1)}%`.padStart(numWidth)}  ${deltaText.padStart(numWidth)}`,
    );
  }

  lines.push("");
  console.log(lines.join("\n"));
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    commit: "HEAD",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--ref") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --ref");
      }
      result.ref = value;
      i += 1;
      continue;
    }
    if (arg === "--commit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --commit");
      }
      result.commit = value;
      i += 1;
      continue;
    }
    if (arg === "--compare") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --compare");
      }
      result.compare = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function printUsage() {
  console.log(
    [
      "Usage: bun scripts/patch-metrics.ts [options]",
      "",
      "Options:",
      "  --ref <ref>       Reference ref/tag (default from patch-metrics.config.json)",
      "  --commit <ref>    Commit/ref to evaluate (default: HEAD)",
      "  --compare <ref>   Compare PR metrics with another commit/ref",
      "  --json            Output machine-readable JSON",
      "  -h, --help        Show this help",
    ].join("\n"),
  );
}

async function main() {
  const config = readConfig();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const ref = args.ref ?? config.defaultRef;
  if (args.compare) {
    const prMetrics = computeMetrics(config, ref, args.commit);
    const baseMetrics = computeMetrics(config, ref, args.compare);
    if (args.json) {
      console.log(JSON.stringify({ base: baseMetrics, pr: prMetrics }, null, 2));
      return;
    }
    renderCompare(baseMetrics, prMetrics, args.compare);
    return;
  }

  const metrics = computeMetrics(config, ref, args.commit);
  if (args.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }
  renderHuman(metrics);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
