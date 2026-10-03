// Answers the window's Item store requests, relayed by the main process. Requests are validated
// again here because the Core is the database's only writer, and every action is recorded as the User's.
import { type ActivityEntry, type CoreItemStoreReply, itemStoreRequest } from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from './item-store';

const envelope = z.object({ type: z.literal('item-store-request'), id: z.number().int().positive() });

function answer(store: ItemStore, raw: unknown): CoreItemStoreReply['response'] {
  const parsed = itemStoreRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Malformed Item store request: ${parsed.error.message}` };
  const request = parsed.data;
  try {
    switch (request.op) {
      case 'query':
        return { ok: true, result: store.query(request.query) };
      case 'get':
        return { ok: true, result: store.get(request.itemId) };
      case 'activity':
        return { ok: true, result: store.activity(request.query) };
      case 'record':
        return { ok: true, result: store.record(request.action, { by: { kind: 'user' }, why: request.why }) };
      case 'projects':
        return { ok: true, result: store.projects(request.query) };
      case 'change-project':
        return { ok: true, result: store.changeProject(request.action) };
      case 'record-all':
        return {
          ok: true,
          result: store.recordAll(request.actions, { by: { kind: 'user' }, why: request.why }),
        };
      case 'daily-note':
        return {
          ok: true,
          result: store.ensureDailyNote(
            request.day,
            { by: { kind: 'user' } },
            { fromTemplate: request.fromTemplate },
          ),
        };
      case 'daily-notes':
        return { ok: true, result: store.dailyNotes(request.query) };
      case 'blocks':
        return { ok: true, result: store.blocks(request.dailyNoteIds) };
      case 'daily-template':
        return { ok: true, result: store.dailyTemplate() };
      case 'save-daily-template':
        return { ok: true, result: store.saveDailyTemplate(request.template) };
      case 'block-todos':
        return { ok: true, result: store.blockTodos(request.query) };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// The Items a recorded change touched (each changed Item, and both ends of a Link), in order, once each.
function changedItems(response: CoreItemStoreReply['response']): string[] {
  if (!response.ok) return [];
  const result = response.result;
  const entries = (Array.isArray(result) ? result : [result]) as ActivityEntry[];
  return [
    ...new Set(
      entries.flatMap((entry) => (entry.otherItemId ? [entry.itemId, entry.otherItemId] : [entry.itemId])),
    ),
  ];
}

/**
 * Returns the reply to send back, or null when the message is not an Item store request. After a
 * change is recorded, `onChanged` is told which Items it touched, so open views can catch up.
 */
export function answerItemStoreRequest(
  store: ItemStore,
  message: unknown,
  onChanged?: (itemIds: string[]) => void,
): CoreItemStoreReply | null {
  const parsed = envelope.safeParse(message);
  if (!parsed.success) return null;
  const { request } = message as { request?: unknown };
  const response = answer(store, request);
  const op = (request as { op?: unknown }).op;
  if (onChanged && (op === 'record' || op === 'record-all')) {
    const ids = changedItems(response);
    if (ids.length) onChanged(ids);
  }
  return { type: 'item-store-reply', id: parsed.data.id, response };
}
