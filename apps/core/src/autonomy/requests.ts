// Answers the gate's requests, relayed by the main process: the window's (settings, Ares's
// activity, accepting and undoing) and, only when the Core runs with --test-hooks, the end-to-end
// tests' (registering actions and proposing as Ares's jobs would). Validated again here.
import { AUTONOMY_MESSAGES, autonomyRequest, autonomyTestRequest } from '@commander/domain';
import { z } from 'zod';
import type { Gate } from './gate';

type Response = { ok: true; result: unknown } | { ok: false; error: string };
export type AutonomyReply = {
  type: (typeof AUTONOMY_MESSAGES)[keyof typeof AUTONOMY_MESSAGES]['reply'];
  id: number;
  response: Response;
};

const envelope = z.object({
  type: z.enum([AUTONOMY_MESSAGES.window.request, AUTONOMY_MESSAGES.test.request]),
  id: z.number().int().positive(),
});

function attempt(run: () => unknown): Response {
  try {
    return { ok: true, result: run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function answerWindow(gate: Gate, raw: unknown): Response {
  const parsed = autonomyRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Malformed autonomy request: ${parsed.error.message}` };
  const request = parsed.data;
  return attempt(() => {
    switch (request.op) {
      case 'settings':
        return { settings: gate.settings(), actions: gate.actions() };
      case 'set-level':
        return { settings: gate.setLevel(request.target, request.level), actions: gate.actions() };
      case 'activity':
        return gate.activity(request.query);
      case 'accept':
        return gate.accept(request.proposalId);
      case 'dismiss':
        return gate.dismiss(request.proposalId);
      case 'accept-all':
        return gate.acceptAll(request.proposalIds);
      case 'undo':
        return gate.undo(request.proposalId);
    }
  });
}

function answerTests(gate: Gate, raw: unknown): Response {
  const parsed = autonomyTestRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Malformed test request: ${parsed.error.message}` };
  const request = parsed.data;
  return attempt(() => {
    if (request.op === 'propose') return gate.propose(request.proposal);
    gate.registerAction(request.action);
    return null;
  });
}

// Returns the reply to send back, or null when the message is not for the gate.
export function answerAutonomyRequest(
  gate: Gate,
  message: unknown,
  { testHooks }: { testHooks: boolean },
): AutonomyReply | null {
  const parsed = envelope.safeParse(message);
  if (!parsed.success) return null;
  const { request } = message as { request?: unknown };
  const { id, type } = parsed.data;
  if (type === AUTONOMY_MESSAGES.window.request) {
    return { type: AUTONOMY_MESSAGES.window.reply, id, response: answerWindow(gate, request) };
  }
  const response: Response = testHooks
    ? answerTests(gate, request)
    : { ok: false, error: 'Test hooks are off' };
  return { type: AUTONOMY_MESSAGES.test.reply, id, response };
}
