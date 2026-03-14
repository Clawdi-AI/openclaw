import { Type } from "@sinclair/typebox";

export type WorkflowSpec = {
  toolName: string;
  label: string;
  commandName: string;
  description: string;
  argHint?: string;
  primarySkill: string;
  skillNames: string[];
  requiredInputs: string[];
  deliverables: string[];
  notes?: string[];
  targetOptional?: boolean;
};

type WorkflowParams = {
  target?: string;
  context?: string;
};

function readOptionalString(
  params: Record<string, unknown>,
  key: keyof WorkflowParams,
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildWorkflowText(
  spec: WorkflowSpec,
  params: WorkflowParams,
  status: "needs_input" | "ready",
): string {
  const lines: string[] = [];
  lines.push(`${spec.label}`);
  lines.push(`Mapped from source command ${spec.commandName}`);
  lines.push(spec.description);
  lines.push("");

  if (status === "needs_input") {
    lines.push(`Missing required input: ${spec.requiredInputs.join(", ")}`);
    if (spec.argHint) {
      lines.push(`Original argument hint: ${spec.argHint}`);
    }
    lines.push("");
  } else if (params.target) {
    lines.push(`Target: ${params.target}`);
    if (params.context) {
      lines.push(`Context: ${params.context}`);
    }
    lines.push("");
  }

  lines.push(`Primary skill: ${spec.primarySkill}`);
  lines.push("Skills to use:");
  for (const skillName of spec.skillNames) {
    lines.push(`- ${skillName}`);
  }
  lines.push("");
  lines.push("Expected deliverables:");
  for (const deliverable of spec.deliverables) {
    lines.push(`- ${deliverable}`);
  }

  if (spec.notes && spec.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of spec.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

export function createWorkflowTool(spec: WorkflowSpec) {
  return {
    name: spec.toolName,
    label: spec.label,
    description: spec.description,
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({
          description:
            spec.argHint && spec.argHint.trim()
              ? `Primary subject for ${spec.commandName} ${spec.argHint}`.trim()
              : `Primary subject for ${spec.commandName}`,
        }),
      ),
      context: Type.Optional(
        Type.String({
          description: "Optional extra context such as audience, scope, or output constraints.",
        }),
      ),
    }),

    async execute(_id: string, rawParams: Record<string, unknown>) {
      const params: WorkflowParams = {
        target: readOptionalString(rawParams, "target"),
        context: readOptionalString(rawParams, "context"),
      };
      const needsInput = !spec.targetOptional && !params.target;
      const status = needsInput ? "needs_input" : "ready";
      const details = {
        status,
        commandName: spec.commandName,
        target: params.target,
        context: params.context,
        primarySkill: spec.primarySkill,
        skillNames: spec.skillNames,
        requiredInputs: spec.requiredInputs,
        deliverables: spec.deliverables,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: buildWorkflowText(spec, params, status),
          },
        ],
        details,
      };
    },
  };
}
