import { isCommandFlagEnabled } from "../config/commands.js";
import type { OpenClawConfig } from "../config/config.js";

export function buildHelpMessage(cfg?: OpenClawConfig): string {
  const lines = ["ℹ️ Help", ""];

  lines.push("Session");
  lines.push("  /new  |  /reset  |  /compact [instructions]  |  /stop");
  lines.push("");

  const optionParts = ["/think <level>", "/model <id>", "/fast on|off", "/verbose on|off"];
  if (isCommandFlagEnabled(cfg, "config")) {
    optionParts.push("/config");
  }
  if (isCommandFlagEnabled(cfg, "debug")) {
    optionParts.push("/debug");
  }
  lines.push("Options");
  lines.push(`  ${optionParts.join("  |  ")}`);
  lines.push("");

  lines.push("Status");
  lines.push("  /status  |  /whoami  |  /context");
  lines.push("");

  lines.push("Skills");
  lines.push("  /skill <name> [input]");

  lines.push("");
  lines.push("More: /commands for full list");

  return lines.join("\n");
}
