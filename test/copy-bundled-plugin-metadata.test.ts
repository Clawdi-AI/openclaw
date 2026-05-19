import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../scripts/copy-bundled-plugin-metadata.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeFileText(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
}

describe("bundled plugin metadata copy", () => {
  it("rewrites channel state probes to bundled package-local js files", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-copy-bundled-plugin-metadata-");
    const packageDir = join(repoDir, "extensions", "discord");
    mkdirSync(packageDir, { recursive: true });
    writeJsonFile(join(repoDir, "package.json"), { name: "openclaw", version: "2026.5.18" });
    writeJsonFile(join(packageDir, "openclaw.plugin.json"), {
      id: "discord",
      channels: ["discord"],
    });
    writeJsonFile(join(packageDir, "package.json"), {
      name: "@openclaw/discord",
      version: "2026.5.18",
      type: "module",
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        channel: {
          id: "discord",
          configuredState: {
            env: { allOf: ["DISCORD_BOT_TOKEN"] },
            specifier: "./configured-state",
            exportName: "hasDiscordConfiguredState",
          },
          persistedAuthState: {
            specifier: "./auth-presence",
            exportName: "hasDiscordAuthState",
          },
        },
      },
    });
    writeFileText(join(packageDir, "index.ts"), "export {};\n");
    writeFileText(join(packageDir, "setup-entry.ts"), "export {};\n");
    writeFileText(join(packageDir, "configured-state.ts"), "export {};\n");
    writeFileText(join(packageDir, "auth-presence.ts"), "export {};\n");

    copyBundledPluginMetadata({ cwd: repoDir });

    const bundledPackageJson = JSON.parse(
      readFileSync(join(repoDir, "dist", "extensions", "discord", "package.json"), "utf8"),
    );
    expect(bundledPackageJson.openclaw.extensions).toEqual(["./index.js"]);
    expect(bundledPackageJson.openclaw.setupEntry).toBe("./setup-entry.js");
    expect(bundledPackageJson.openclaw.channel.configuredState.specifier).toBe(
      "./configured-state.js",
    );
    expect(bundledPackageJson.openclaw.channel.persistedAuthState.specifier).toBe(
      "./auth-presence.js",
    );
  });
});
