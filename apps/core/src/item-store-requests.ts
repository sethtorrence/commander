// Answers the window's Item store requests, relayed by the main process. Requests are validated
// again here because the Core is the database's only writer, and every action is recorded as the User's.
import {
  type ActivityEntry,
  type ChatSettingChange,
  type CoreItemStoreReply,
  decide,
  itemStoreRequest,
  type SummaryWriterState,
  WRITE_GITHUB_SUMMARY,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from './item-store';

const envelope = z.object({ type: z.literal('item-store-request'), id: z.number().int().positive() });

// How Ares's GitHub summary writing stands (#121): his job's last run, and whether it may run at all.
export function summaryWriter(store: ItemStore): SummaryWriterState {
  const job = store.agent.job(WRITE_GITHUB_SUMMARY);
  const off =
    decide(
      {
        action: WRITE_GITHUB_SUMMARY,
        actionKind: 'organise',
        section: 'github',
        confidence: 1,
        chained: false,
      },
      store.autonomy.settings(),
    ) === 'off';
  return {
    enabled: job.enabled,
    off,
    lastRunAt: job.lastRunAt,
    lastOutcome: job.lastOutcome,
    lastProblem: job.lastProblem,
  };
}

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
      case 'save-attachment':
        return { ok: true, result: store.saveAttachment(request.bytes) };
      case 'rules':
        return { ok: true, result: store.rules() };
      case 'change-rule':
        return { ok: true, result: store.changeRule(request.action) };
      case 'preview-rule':
        return { ok: true, result: store.previewRule(request.request) };
      case 'rule-values':
        return { ok: true, result: store.ruleValues() };
      case 'refile':
        return { ok: true, result: store.refile(request.itemIds) };
      case 'buckets':
        return { ok: true, result: store.buckets() };
      case 'change-bucket':
        return { ok: true, result: store.changeBucket(request.action) };
      case 'resort':
        return { ok: true, result: store.resort(request.itemIds) };
      case 'undo-resort':
        return { ok: true, result: store.undoResort(request.entryIds) };
      case 'bucket-mirroring':
        return { ok: true, result: store.bucketMirror.list() };
      case 'set-bucket-mirroring':
        return { ok: true, result: store.bucketMirror.set(request.change) };
      case 'undo-refile':
        return { ok: true, result: store.undoRefile(request.entryIds) };
      case 'search':
        return { ok: true, result: store.search.query(request.query) };
      case 'outgoing':
        return { ok: true, result: store.outgoing.list(request.query) };
      case 'retry-outgoing':
        return { ok: true, result: store.outgoing.retry(request.itemId) };
      case 'source-catalog':
        return { ok: true, result: store.syncState.catalog(request.account) };
      case 'daily-note-projects':
        return { ok: true, result: store.dailyNoteProjects() };
      case 'project-blocks':
        return { ok: true, result: store.projectBlocks(request.projectId) };
      case 'mentions':
        return { ok: true, result: store.mentions(request.query) };
      case 'send-to-linear':
        return { ok: true, result: store.sendToLinear(request.draft, { by: { kind: 'user' } }) };
      case 'linear-send-prefill':
        return {
          ok: true,
          result: store.linearSendPrefill({ from: request.from, projectId: request.projectId }),
        };
      case 'block-issues':
        return { ok: true, result: store.blockIssues(request.dailyNoteIds) };
      case 'dashboard':
        return { ok: true, result: store.dashboard.state() };
      case 'save-dashboard-clears':
        return { ok: true, result: store.dashboard.saveClears(request.clears) };
      case 'chat-settings':
        return { ok: true, result: store.chatSettings.list(request.account) };
      case 'change-chat-setting':
        return { ok: true, result: store.chatSettings.change(request.action, { by: { kind: 'user' } }) };
      case 'channel-choices':
        return { ok: true, result: store.channelSettings.choices() };
      case 'change-channel-setting':
        return { ok: true, result: store.channelSettings.change(request.action, { by: { kind: 'user' } }) };
      case 'clear-chat-waiting':
        return { ok: true, result: store.chatWaiting.clearByUser(request.itemId, { by: { kind: 'user' } }) };
      case 'events':
        return { ok: true, result: store.events(request.query) };
      case 'calendars':
        return { ok: true, result: store.calendars.list() };
      case 'calendar-settings':
        return { ok: true, result: store.calendarSettings.read() };
      case 'save-calendar-settings':
        return { ok: true, result: store.calendarSettings.save(request.settings) };
      case 'meeting-preps':
        return { ok: true, result: store.meetingPreps(request.eventIds) };
      case 'github-oversight':
        return {
          ok: true,
          result: store.githubOversight.summary({
            range: request.range,
            ...(request.projectId !== undefined && { projectId: request.projectId }),
          }),
        };
      case 'github-summaries':
        return {
          ok: true,
          result: {
            summaries: store.githubSummaries.list({
              ...(request.cadences && { cadences: request.cadences }),
              ...(request.limit && { limit: request.limit }),
            }),
            writer: summaryWriter(store),
          },
        };
      case 'github-summary-seen':
        return { ok: true, result: store.githubSummaries.markSeen(request.itemId) };
      case 'github-people': {
        // Each Person's week (#122), with Ares's latest paragraph about them.
        const paragraphs = store.githubSummaries.paragraphs();
        const weeks = store.githubOversight.people({
          range: request.range,
          ...(request.projectId !== undefined && { projectId: request.projectId }),
          ...(request.personId !== undefined && { personId: request.personId }),
        });
        return {
          ok: true,
          result: {
            range: request.range,
            cards: weeks.map((week) => ({
              ...week,
              paragraph: (week.personId && paragraphs.get(week.personId)) || null,
            })),
            writer: summaryWriter(store),
          },
        };
      }
      case 'github-oversight-settings':
        return { ok: true, result: store.githubOversight.settings() };
      case 'save-github-oversight-settings':
        return { ok: true, result: store.githubOversight.saveSettings(request.settings) };
      case 'people':
        return { ok: true, result: store.people.list() };
      case 'change-people':
        return { ok: true, result: store.people.change(request.action) };
      case 'invitations':
        return { ok: true, result: store.invitations() };
      case 'focus-settings':
        return { ok: true, result: store.focusSettings.read() };
      case 'save-focus-settings':
        return { ok: true, result: store.focusSettings.save(request.settings) };
      case 'scheduling-settings':
        return { ok: true, result: store.schedulingSettings.read() };
      case 'save-scheduling-settings':
        return { ok: true, result: store.schedulingSettings.save(request.settings) };
      case 'create-meeting':
        return { ok: true, result: store.createEvent(request.draft, { by: { kind: 'user' } }) };
      case 'find-time':
        // Answered by the scheduler (../scheduling), which asks the providers first.
        return { ok: false, error: 'Find time isn’t running' };
      case 'set-calendar-enabled':
        return {
          ok: true,
          result: store.setCalendarOn(
            { account: request.account, calendarId: request.calendarId, on: request.on },
            { by: { kind: 'user' } },
          ),
        };
      case 'email-threads':
        return { ok: true, result: store.emailThreads(request.query) };
      case 'email-thread':
        return { ok: true, result: store.emailThread(request.account, request.threadKey) };
      case 'email-views':
        return { ok: true, result: store.emailViews(request.query) };
      case 'email-search':
        return { ok: true, result: store.emailSearch(request.query) };
      case 'email-labels':
        return { ok: true, result: store.emailLabels(request.account) };
      case 'email-sorting':
        return { ok: true, result: store.emailSorting.progress() };
      case 'memories':
        return { ok: true, result: store.memory.list(request.query) };
      case 'change-memory':
        return { ok: true, result: store.memory.change(request.action) };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// The Items a recorded change touched, in order, once each: each changed Item, both ends of a Link,
// and the Items re-filed along with it (the Blocks under a re-filed Block, the Todos that follow them),
// which are in the activity log after the last entry before the change. A change to a Chat's setting
// touches its Chat.
function changedItems(store: ItemStore, response: CoreItemStoreReply['response'], since: number): string[] {
  if (!response.ok) return [];
  const result = response.result;
  if (isChatSettingChange(result)) return result.itemId ? [result.itemId] : [];
  // A change that isn't an entry (removing a Bucket) is told by the entries it logged alongside.
  const entries = ((Array.isArray(result) ? result : [result]) as ActivityEntry[]).filter(
    (entry) => typeof entry?.itemId === 'string',
  );
  const alongside = store.activity({ after: since, limit: 1000 }).reverse();
  return [
    ...new Set(
      [...entries, ...alongside].flatMap((entry) =>
        entry.otherItemId ? [entry.itemId, entry.otherItemId] : [entry.itemId],
      ),
    ),
  ];
}

const isChatSettingChange = (result: unknown): result is ChatSettingChange =>
  typeof result === 'object' && result !== null && 'setting' in result && 'itemId' in result;

// The requests that change Items, after which `onChanged` hears which.
// Re-filing by Rules changes Items too: views catch up, and Ares's overruled suggestions go. So do
// re-sorting by Rules and removing a Bucket (its emails become Unsorted).
const CHANGES = new Set([
  'record',
  'record-all',
  'send-to-linear',
  'create-meeting',
  'change-chat-setting',
  'change-channel-setting',
  'clear-chat-waiting',
  'refile',
  'undo-refile',
  'resort',
  'undo-resort',
  'change-bucket',
]);

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
  const op = (request as { op?: unknown } | undefined)?.op;
  const records = onChanged && typeof op === 'string' && CHANGES.has(op);
  const since = records ? (store.activity({ limit: 1 })[0]?.id ?? 0) : 0;
  const response = answer(store, request);
  if (onChanged && records) {
    const ids = changedItems(store, response, since);
    if (ids.length) onChanged(ids);
  }
  return { type: 'item-store-reply', id: parsed.data.id, response };
}
