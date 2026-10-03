// A fake OpenAI-compatible chat completions server, for tests. Tests never call Z.ai: they queue
// recorded-style replies here and read back the requests the adapter sent.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  // The parsed JSON body.
  body: Record<string, unknown>;
};

export type FakeReply = {
  status?: number;
  headers?: Record<string, string>;
  // A JSON body.
  json?: unknown;
  // Server-sent events: each chunk is sent as a `data:` line, followed by `data: [DONE]`.
  sse?: unknown[];
  // Never answer (for timeouts).
  hang?: boolean;
};

export type FakeUsage = { prompt: number; completion: number; cached?: number };

// A chat completion in the shape Z.ai returns it, thinking included.
export function chatCompletion(content: string, usage: FakeUsage = { prompt: 20, completion: 10 }) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1_791_000_000,
    model: 'glm-5.3-flash',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content, reasoning_content: 'Thinking it over.' },
      },
    ],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
      prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
    },
  };
}

// The chunks of a streamed chat completion: one per token, then a usage-only chunk.
export function streamedCompletion(tokens: string[], usage: FakeUsage = { prompt: 20, completion: 10 }) {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    model: 'glm-5.3-flash',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    chunk({ role: 'assistant', reasoning_content: 'Thinking.' }),
    ...tokens.map((token) => chunk({ content: token })),
    chunk({}, 'stop'),
    {
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model: 'glm-5.3-flash',
      choices: [],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
      },
    },
  ];
}

export type FakeOpenAIServer = {
  // e.g. http://127.0.0.1:41234/v4 — what a tier's base URL is set to.
  baseUrl: string;
  requests: FakeRequest[];
  // Queues replies, answered in order; once the queue is empty, every request gets a plain reply.
  reply(...replies: FakeReply[]): void;
  close(): Promise<void>;
};

function send(res: ServerResponse, reply: FakeReply) {
  if (reply.hang) return;
  if (reply.sse) {
    res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream', ...reply.headers });
    for (const chunk of reply.sse) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
  res.end(JSON.stringify(reply.json ?? {}));
}

export async function startFakeOpenAIServer(): Promise<FakeOpenAIServer> {
  const queue: FakeReply[] = [];
  const requests: FakeRequest[] = [];
  const open = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (part: string) => {
      text += part;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { unparsable: text };
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      open.add(res);
      res.on('close', () => open.delete(res));
      send(res, queue.shift() ?? { json: chatCompletion('Hello from the fake server.') });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v4`,
    requests,
    reply: (...replies) => queue.push(...replies),
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
      }),
  };
}
