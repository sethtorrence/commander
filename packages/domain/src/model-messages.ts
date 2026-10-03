import { z } from 'zod';
import {
  type ModelErrorKind,
  type ModelSettings,
  type ModelTestResult,
  modelErrorKind,
  modelSettings,
  modelTestResult,
  type UsageSummary,
  usageSummary,
} from './models';

const requestId = z.number().int().positive();

// What Settings → Ares may ask of the Core, relayed by the main process and validated on both sides.
// API keys never travel this way: the window hands a key to the main process only (see ipc.ts).
export const modelsRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('settings') }),
  z.object({ op: z.literal('save-settings'), settings: modelSettings }),
  // A one-line Quick call, to show the key and settings work.
  z.object({ op: z.literal('test') }),
  z.object({ op: z.literal('usage') }),
]);
export type ModelsRequest = z.input<typeof modelsRequest>;
export type ModelsOp = ModelsRequest['op'];

export type ModelsResults = {
  settings: ModelSettings;
  'save-settings': ModelSettings;
  test: ModelTestResult;
  usage: UsageSummary;
};

export const modelsResult = {
  settings: modelSettings,
  'save-settings': modelSettings,
  test: modelTestResult,
  usage: usageSummary,
} satisfies Record<ModelsOp, z.ZodType>;

const failure = z.object({ ok: z.literal(false), error: z.string(), kind: modelErrorKind.optional() });

export type ModelsResponse<Op extends ModelsOp = ModelsOp> =
  | { ok: true; result: ModelsResults[Op] }
  | { ok: false; error: string; kind?: ModelErrorKind };

// Main process → Core.
export const coreModelsRequest = z.object({
  type: z.literal('models-request'),
  id: requestId,
  request: modelsRequest,
});
export type CoreModelsRequest = z.input<typeof coreModelsRequest>;

// Core → main process. The result is checked against the request's op by whoever asked.
export const coreModelsReply = z.object({
  type: z.literal('models-reply'),
  id: requestId,
  response: z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), result: z.unknown() }), failure]),
});
export type CoreModelsReply = z.infer<typeof coreModelsReply>;
