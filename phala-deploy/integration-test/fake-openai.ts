import http from "node:http";
import { closeHttpServer, getFreePort, readJsonBody, waitForCondition } from "./test-utils.js";

export type FakeOpenAiFunctionCallOutput = {
  callId: string;
  output: string;
};

export type FakeOpenAiRequest = {
  raw: Record<string, unknown>;
  lastUserText: string;
  inputItems: unknown[];
  functionCallOutputs: FakeOpenAiFunctionCallOutput[];
  allFunctionCallOutputs: FakeOpenAiFunctionCallOutput[];
  turn: number;
};

export type FakeOpenAiResponseItem =
  | {
      kind: "message";
      text: string;
      id?: string;
    }
  | {
      kind: "function_call";
      name: string;
      args: Record<string, unknown> | string;
      callId?: string;
      id?: string;
    };

export type FakeOpenAiResponsePlan = FakeOpenAiResponseItem | FakeOpenAiResponseItem[] | string;

export type FakeOpenAiScriptContext = {
  request: FakeOpenAiRequest;
  toolOutputs: FakeOpenAiFunctionCallOutput[];
};

export type FakeOpenAiScriptStep =
  | {
      type: "tool_call";
      name: string;
      callId?: string;
      id?: string;
      args:
        | Record<string, unknown>
        | string
        | ((context: FakeOpenAiScriptContext) => Record<string, unknown> | string);
    }
  | {
      type: "final_text";
      id?: string;
      text: string | ((context: FakeOpenAiScriptContext) => string);
    };

export function textResponsePlan(text: string, id?: string): FakeOpenAiResponseItem {
  return { kind: "message", text, id };
}

export function functionCallResponsePlan(params: {
  name: string;
  args: Record<string, unknown> | string;
  callId?: string;
  id?: string;
}): FakeOpenAiResponseItem {
  return {
    kind: "function_call",
    name: params.name,
    args: params.args,
    callId: params.callId,
    id: params.id,
  };
}

export function getFunctionCallOutput(
  outputs: FakeOpenAiFunctionCallOutput[],
  callId: string,
): string | undefined {
  return outputs.find((entry) => entry.callId === callId)?.output;
}

export function createSequentialResponseScript(
  steps: FakeOpenAiScriptStep[],
): (request: FakeOpenAiRequest) => FakeOpenAiResponsePlan {
  return (request) => {
    const context = {
      request,
      toolOutputs: request.allFunctionCallOutputs,
    } satisfies FakeOpenAiScriptContext;
    const step = steps[context.toolOutputs.length];
    if (!step) {
      throw new Error(
        `sequential OpenAI script exhausted at turn ${request.turn} with ${context.toolOutputs.length} tool outputs`,
      );
    }
    if (step.type === "final_text") {
      const text = typeof step.text === "function" ? step.text(context) : step.text;
      return textResponsePlan(text, step.id);
    }
    const args = typeof step.args === "function" ? step.args(context) : step.args;
    return functionCallResponsePlan({
      name: step.name,
      args,
      callId: step.callId,
      id: step.id,
    });
  };
}

function mergeFunctionCallOutputs(
  requests: FakeOpenAiRequest[],
  outputs: FakeOpenAiFunctionCallOutput[],
): FakeOpenAiFunctionCallOutput[] {
  const merged = new Map<string, FakeOpenAiFunctionCallOutput>();
  for (const request of requests) {
    for (const output of request.allFunctionCallOutputs ?? request.functionCallOutputs) {
      merged.set(output.callId, output);
    }
  }
  for (const output of outputs) {
    merged.set(output.callId, output);
  }
  return [...merged.values()];
}

function extractLastUserTextFromArray(input: unknown[]): string {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.role !== "user") {
      continue;
    }
    const content = record.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const part = entry as Record<string, unknown>;
        const typedText =
          part.type === "input_text" || part.type === "output_text" ? part.text : undefined;
        return typeof typedText === "string" ? [typedText] : [];
      })
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function extractLastUserText(raw: Record<string, unknown>): string {
  const input = raw.input;
  if (typeof input === "string" && input.trim()) {
    return input.trim();
  }
  if (Array.isArray(input)) {
    return extractLastUserTextFromArray(input);
  }
  return "";
}

function extractFunctionCallOutputs(raw: Record<string, unknown>): FakeOpenAiFunctionCallOutput[] {
  const input = Array.isArray(raw.input) ? raw.input : [];
  const outputs: FakeOpenAiFunctionCallOutput[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call_output") {
      continue;
    }
    const callId = typeof record.call_id === "string" ? record.call_id : "";
    const output = typeof record.output === "string" ? record.output : "";
    if (!callId) {
      continue;
    }
    outputs.push({ callId, output });
  }
  return outputs;
}

function normalizeResponseItems(
  plan: FakeOpenAiResponsePlan,
  turn: number,
): FakeOpenAiResponseItem[] {
  if (typeof plan === "string") {
    return [textResponsePlan(plan, `msg_${turn}_1`)];
  }
  const items = Array.isArray(plan) ? plan : [plan];
  return items;
}

function buildMessageEvents(item: Extract<FakeOpenAiResponseItem, { kind: "message" }>) {
  const id = item.id ?? `msg_${Date.now()}`;
  const completedItem = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: item.text, annotations: [] }],
  };
  return {
    events: [
      {
        type: "response.output_item.added",
        item: {
          type: "message",
          id,
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      { type: "response.output_text.delta", delta: item.text },
      { type: "response.output_text.done", text: item.text },
      { type: "response.output_item.done", item: completedItem },
    ],
    output: completedItem,
  };
}

function buildFunctionCallEvents(
  item: Extract<FakeOpenAiResponseItem, { kind: "function_call" }>,
  index: number,
) {
  const id = item.id ?? `fc_${index}`;
  const callId = item.callId ?? `call_${index}`;
  const args = typeof item.args === "string" ? item.args : JSON.stringify(item.args);
  const completedItem = {
    type: "function_call",
    id,
    call_id: callId,
    name: item.name,
    arguments: args,
  };
  return {
    events: [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id,
          call_id: callId,
          name: item.name,
          arguments: "",
        },
      },
      { type: "response.function_call_arguments.delta", delta: args },
      { type: "response.output_item.done", item: completedItem },
    ],
    output: completedItem,
  };
}

function buildSseResponse(plan: FakeOpenAiResponsePlan, turn: number): string {
  const items = normalizeResponseItems(plan, turn);
  const events: unknown[] = [];
  const output: unknown[] = [];

  items.forEach((item, index) => {
    const built =
      item.kind === "function_call"
        ? buildFunctionCallEvents(item, index + 1)
        : buildMessageEvents(item);
    events.push(...built.events);
    output.push(built.output);
  });

  events.push({
    type: "response.completed",
    response: {
      status: "completed",
      output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });

  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

export class FakeOpenAiResponsesServer {
  readonly requests: FakeOpenAiRequest[] = [];

  private constructor(
    readonly server: http.Server,
    readonly url: string,
    readonly baseUrl: string,
    private readonly responder: (request: FakeOpenAiRequest) => FakeOpenAiResponsePlan,
  ) {}

  static async start(params?: {
    responder?: (request: FakeOpenAiRequest) => FakeOpenAiResponsePlan;
  }): Promise<FakeOpenAiResponsesServer> {
    const responder =
      params?.responder ?? ((request: FakeOpenAiRequest) => `E2E reply: ${request.lastUserText}`);
    const port = await getFreePort();
    let instance: FakeOpenAiResponsesServer;
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end();
        return;
      }

      const raw = await readJsonBody(req);
      const inputItems = Array.isArray(raw.input) ? raw.input : [];
      const request = {
        raw,
        lastUserText: extractLastUserText(raw),
        inputItems,
        functionCallOutputs: extractFunctionCallOutputs(raw),
        allFunctionCallOutputs: mergeFunctionCallOutputs(
          instance?.requests ?? [],
          extractFunctionCallOutputs(raw),
        ),
        turn: instance.requests.length + 1,
      } satisfies FakeOpenAiRequest;
      instance.requests.push(request);

      const sse = buildSseResponse(responder(request), request.turn);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(sse);
    });
    await new Promise<void>((resolveServer, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolveServer();
      });
    });
    const url = `http://127.0.0.1:${port}`;
    instance = new FakeOpenAiResponsesServer(server, url, `${url}/v1`, responder);
    return instance;
  }

  async waitForRequest(
    predicate: (request: FakeOpenAiRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeOpenAiRequest> {
    return await waitForCondition(
      () => this.requests.find(predicate),
      timeoutMs,
      "timed out waiting for fake OpenAI request",
    );
  }

  async waitForRequestCount(count: number, timeoutMs = 10_000): Promise<FakeOpenAiRequest[]> {
    await waitForCondition(
      () => (this.requests.length >= count ? this.requests : undefined),
      timeoutMs,
      `timed out waiting for ${count} fake OpenAI requests`,
    );
    return this.requests.slice();
  }

  async close(): Promise<void> {
    await closeHttpServer(this.server);
  }
}
