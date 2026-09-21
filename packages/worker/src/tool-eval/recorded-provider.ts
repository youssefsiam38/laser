/**
 * The recorded half of the harness: an OpenAI-compatible provider on
 * 127.0.0.1 that answers each request of a run with the fixture's next
 * recorded response.
 *
 * It exists so a fixture runs against the real engine, the real driver and
 * the real tool registrations without a network and without a model: the
 * engine sends the requests it would really send — the whole system prompt,
 * every tool schema, the whole transcript — and the answers are the ones a
 * model gave when the fixture was recorded. Everything a measure reads (the
 * request sizes, the argument validation, the tool errors, the narrowing) is
 * therefore the product's own behaviour and not a mock of it.
 *
 * A profile changes one thing here: the model id the answers are attributed
 * to, so a run can be grouped by profile the way the report groups it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RecordedStep } from "./fixture.js";

/** One request as it reached the provider, kept for the budget measure. */
export interface RecordedRequest {
  /** The raw JSON body, which is what actually costs context. */
  bytes: number;
  /** The tool names offered on this request. */
  tools: string[];
  model: string;
}

export interface RecordedProvider {
  url: string;
  requests: RecordedRequest[];
  /** Responses asked for beyond the end of the recording. Zero in a passing run. */
  overruns: number;
  close(): Promise<void>;
}

export interface RecordedProviderOptions {
  /** The model id the answers claim to come from — the profile's own model. */
  model: string;
  /** The recorded responses, in order. */
  steps: RecordedStep[];
  /**
   * Called just before each answer is written, with its index, so the runner
   * can fill in an id it could only learn from an earlier result.
   */
  resolve?: (step: RecordedStep, index: number) => RecordedStep;
}

interface ProviderRequestBody {
  messages?: unknown[];
  tools?: Array<{ function?: { name?: string } }>;
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

/** The estimate's one constant, so a caller counting bytes can use it without building a string. */
export const CHARACTERS_PER_TOKEN = 4;

/** A rough, stable token estimate: four characters to a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARACTERS_PER_TOKEN);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the provider. It answers `/chat/completions` and nothing else; a
 * request past the end of the recording is answered with a final message and
 * counted, so an unexpected extra turn shows up as a failure rather than a
 * hang.
 */
export async function startRecordedProvider(options: RecordedProviderOptions): Promise<RecordedProvider> {
  const requests: RecordedRequest[] = [];
  let overruns = 0;
  let completions = 0;

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      void (async () => {
        if (!request.url?.endsWith("/chat/completions")) {
          response.writeHead(404).end();
          return;
        }
        const parsed = JSON.parse(body) as ProviderRequestBody;
        const index = requests.length;
        requests.push({
          bytes: body.length,
          tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "").filter((name) => name.length > 0),
          model: options.model,
        });
        const recorded = options.steps[index];
        const step: RecordedStep = recorded === undefined
          ? { text: "There is no recorded response for this turn." }
          : (options.resolve?.(recorded, index) ?? recorded);
        if (recorded === undefined) overruns += 1;
        if (step.delayMs !== undefined && step.delayMs > 0) await sleep(step.delayMs);

        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const base = { id: `eval-${String(++completions)}`, object: "chat.completion.chunk", created: 1, model: options.model };
        response.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
        if ("text" in step) {
          response.write(sse({ ...base, choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }] }));
          response.write(sse({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: usageOf(body, step.text),
          }));
        } else {
          const id = step.toolCall.id ?? `call_${String(completions)}`;
          const args = JSON.stringify(step.toolCall.args);
          response.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: step.toolCall.name, arguments: "" } }] }, finish_reason: null }] }));
          response.write(sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] }));
          response.write(sse({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: usageOf(body, `${step.toolCall.name}${args}`),
          }));
        }
        response.write("data: [DONE]\n\n");
        response.end();
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    get overruns() {
      return overruns;
    },
    close: () => closeServer(server),
  };
}

/**
 * The usage a provider would report for this exchange, estimated the same way
 * for every profile so two profiles are comparable. A real provider's own
 * numbers are used in a live run; here there is no model to ask.
 */
function usageOf(requestBody: string, answer: string): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const prompt = estimateTokens(requestBody);
  const completion = estimateTokens(answer);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
