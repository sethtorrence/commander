import {
  type Bucket,
  type EmailDetail,
  type EmailThread,
  type EmailThreadSummary,
  type Item,
  type ThreadAction,
  threadBucketOf,
} from '@commander/domain';
import { Button, cn, Kbd, toast } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { BucketChip } from '../../buckets/BucketChip';
import { bucketName } from '../../buckets/buckets';
import type { ItemChanges } from '../../item-store/changes';
import { BadgePicker } from '../../projects/BadgePicker';
import { ItemBadge, waitingSuggestion } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { Composer, type SentMessage } from './compose/Composer';
import { OutboxNote } from './compose/ComposeViews';
import type { ComposeClient } from './compose/compose';
import type { EmailWriting } from './compose/use-compose';
import { BucketPicker } from './EmailBuckets';
import { SnoozePicker } from './EmailOrganising';
import type { EmailAccountSummary, EmailClient } from './email';
import { emailTodoDraft } from './email-todo';
import { MakeTodoDialog } from './MakeTodo';
import { actionToast, loadMarkRead, markReadDelay } from './organising';
import type { EmailReaderClient } from './reader';
import { SuggestedReplyCard } from './SuggestedReply';
import { ThreadReader } from './ThreadReader';
import { pickerTarget } from './thread-view';
import {
  atEnd,
  back,
  currentThread,
  decide,
  nextBucket,
  OUTCOME_LABELS,
  skip,
  startWalk,
  type TriageOutcome,
  type TriageWalk,
  triagePosition,
  triageSummary,
  undecide,
} from './triage';
import { actOnThread, bucketCountsOf, threadId } from './use-email';

/*
  Triage (#140): one Bucket at a time, one thread at a time, full width, with one key per decision.
  Each decision acts at once (through the same changes as the Email Section's keys), shows its toast
  with Undo, and moves on; Ctrl+Z undoes the last one and goes back to its thread. The reply is the
  composer from #138, written below the thread; once it is sent (or closed), Triage moves on. At the
  end: what was done, and the next Bucket with threads, following the User's order. Esc leaves,
  back to where the User was in the Email Section.
*/

const caps = 'font-mono text-label leading-none font-semibold uppercase tracking-caps';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The keys along the bottom, as the legend shows them.
const LEGEND: [string[], string][] = [
  [['R'], 'Reply'],
  [['⇧R'], 'Reply all'],
  [['E'], 'Archive'],
  [['Z'], 'Snooze'],
  [['T'], 'Todo'],
  [['V'], 'Bucket'],
  [['B'], 'Project'],
  [['J', 'Space'], 'Skip'],
  [['K'], 'Back'],
  [['Ctrl', 'Z'], 'Undo'],
  [['Esc'], 'Leave'],
];

function Legend() {
  return (
    <ul
      aria-label="Triage keys"
      className={cn(
        'm-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-sheet px-10 py-2 text-muted',
        caps,
        '[&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label',
      )}
    >
      {LEGEND.map(([keys, label]) => (
        <li key={label} className="flex items-center gap-1.5 whitespace-nowrap">
          {keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}{' '}
          {label}
        </li>
      ))}
    </ul>
  );
}

// A decision that can be undone: whose thread, what it was before (going back to a decided thread
// and deciding again), and how to take it back.
type Decision = { id: number; threadId: string; before: TriageOutcome | null; undo: () => Promise<void> };

type Picking = 'snooze' | 'bucket' | 'project' | 'todo' | null;

export function Triage({
  start,
  client,
  changes,
  buckets,
  account,
  include,
  accounts,
  accountName,
  providerFor,
  reader,
  compose,
  writing,
  onSaveBeforeQuit,
  onLeave,
}: {
  /** The Bucket to walk first. */
  start: string;
  client: EmailClient;
  changes: ItemChanges;
  /** The User's Buckets, in their order. */
  buckets: readonly Bucket[];
  /** The Account switcher's choice when Triage started: all Accounts (`all`) or one. */
  account: string;
  /** The Project filter when Triage started (over each thread's latest message). */
  include: (item: Pick<Item, 'filing'>) => boolean;
  accounts: EmailAccountSummary[];
  accountName: (accountId: string) => string;
  providerFor: (thread: EmailThreadSummary | null) => 'Gmail' | 'Outlook';
  reader: EmailReaderClient;
  compose: ComposeClient;
  /** The Email Section's composer, drafts and Outbox. */
  writing: EmailWriting;
  onSaveBeforeQuit?: (save: () => Promise<void>) => () => void;
  /** Leaves Triage (Esc, Done). */
  onLeave: () => void;
}) {
  const { projectOf, settleFiling } = useProjects();
  const [bucketId, setBucketId] = useState(start);
  const [walk, setWalk] = useState<TriageWalk | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; thread: EmailThread | null } | null>(null);
  const [version, setVersion] = useState(0);
  const [picking, setPicking] = useState<Picking>(null);
  const [next, setNext] = useState<{ bucket: Bucket; threads: number } | null>(null);
  const decisions = useRef<Decision[]>([]);
  const counter = useRef(0);
  const badge = useRef<HTMLSpanElement>(null);
  const one = account === 'all' ? undefined : account;
  const name = bucketName(buckets, bucketId);

  // The Bucket's inbox threads as they are now, narrowed as the Email Section was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Account and Project filter are the ones Triage started with
  useEffect(() => {
    let live = true;
    setWalk(null);
    decisions.current = [];
    void client.threads({ ...(one ? { account: one } : {}), view: 'inbox', bucket: bucketId }).then(
      (list) => {
        if (live)
          setWalk(
            startWalk(
              bucketId,
              list.threads.filter((thread) => include(thread.latest)),
            ),
          );
      },
      (error) => toast(message(error)),
    );
    return () => {
      live = false;
    };
  }, [client, bucketId]);

  useEffect(() => changes(() => setVersion((n) => n + 1)), [changes]);

  const current = walk ? currentThread(walk) : null;
  const currentId = current ? threadId(current) : null;
  const ended = !!walk && atEnd(walk);

  // The thread shown, with its messages as they are now (read again as Items change).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `currentId` names the thread, `version` says when to read again
  useEffect(() => {
    if (!current || !currentId) return;
    let live = true;
    void client.thread(current.account, current.threadKey).then((thread) => {
      if (live) setLoaded({ id: currentId, thread });
    });
    return () => {
      live = false;
    };
  }, [client, currentId, version]);
  const thread = loaded && loaded.id === currentId ? loaded.thread : null;
  const latest = thread?.messages.at(-1)?.item ?? current?.latest ?? null;
  const summary: EmailThreadSummary | null =
    current && latest
      ? {
          ...current,
          latest,
          messageCount: thread?.messages.length ?? current.messageCount,
          itemIds: thread?.messages.map(({ item }) => item.id) ?? current.itemIds,
        }
      : null;
  const inBucket = thread
    ? threadBucketOf(thread.messages.map(({ item }) => item.detail as EmailDetail))
    : (current?.bucket?.bucketId ?? null);
  const outcome = walk && currentId ? (walk.outcomes.get(currentId) ?? null) : null;

  // Showing a thread with unread mail marks it read, as opening it does (Settings → Email).
  const unreadShown = current && current.unreadCount > 0 ? currentId : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `unreadShown` names the thread
  useEffect(() => {
    if (!unreadShown || !current) return;
    const delay = markReadDelay(loadMarkRead(window.localStorage));
    if (delay === null) return;
    const timer = setTimeout(
      () => void actOnThread(client, current, { type: 'read' }).catch(() => {}),
      delay,
    );
    return () => clearTimeout(timer);
  }, [unreadShown]);

  // At the end: the next Bucket with threads, counted as the walk was narrowed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Account and Project filter are the ones Triage started with
  useEffect(() => {
    if (!ended) return;
    let live = true;
    void client.threads({ ...(one ? { account: one } : {}), view: 'inbox', limit: 1 }).then((list) => {
      if (live) setNext(nextBucket(buckets, bucketId, bucketCountsOf(list.facets ?? [], include)));
    });
    return () => {
      live = false;
    };
  }, [client, ended, bucketId, buckets, version]);

  // A decision made for a thread: kept for Undo (unless it can't be undone), its toast, and on.
  const decided = (
    target: EmailThreadSummary,
    made: TriageOutcome,
    undo: (() => Promise<void>) | null,
    said: string | null,
  ): Decision | null => {
    const id = threadId(target);
    let decision: Decision | null = null;
    if (undo) {
      counter.current += 1;
      decision = { id: counter.current, threadId: id, before: walk?.outcomes.get(id) ?? null, undo };
      decisions.current.push(decision);
    }
    setWalk((now) => now && decide(now, made, id));
    if (said) {
      const kept = decision;
      toast(said, kept ? { action: { label: 'Undo', onClick: () => void undoDecision(kept.id) } } : {});
    }
    return decision;
  };

  // Undoes a decision (the last one unless named) and goes back to its thread.
  const undoDecision = useCallback(async (decisionId?: number) => {
    const stack = decisions.current;
    const index = decisionId === undefined ? stack.length - 1 : stack.findIndex((d) => d.id === decisionId);
    const decision = stack[index];
    if (!decision) {
      if (decisionId === undefined) toast('Nothing to undo in Triage');
      return;
    }
    decisions.current = stack.filter((_, i) => i !== index);
    try {
      await decision.undo();
    } catch (error) {
      toast(message(error));
      return;
    }
    setWalk((now) => now && undecide(now, decision.threadId, decision.before));
  }, []);

  // Archive, snooze, move: one change to the thread's messages, as in the Email Section.
  const act = async (action: ThreadAction, made: TriageOutcome) => {
    const target = summary;
    if (!target) return;
    try {
      const entries = await actOnThread(client, target, action);
      if (!entries.length) return;
      const skipping =
        action.type === 'bucket' && buckets.some((each) => each.id === action.bucketId && each.skipInbox);
      const said = actionToast(
        action,
        target.subject,
        Date.now(),
        (id) => bucketName(buckets, id),
        providerFor(target),
      );
      decided(
        target,
        made,
        () => client.undo(entries),
        skipping ? `${said} (archived: it skips the inbox)` : said,
      );
    } catch (error) {
      toast(message(error));
    }
  };

  // Set its Project (the Badge picker), as the Email Section files a thread.
  const file = async (projectId: string | null) => {
    const target = summary;
    if (!target) return;
    const subject = target.subject || '(no subject)';
    const suggestion = waitingSuggestion(target.latest);
    try {
      // Unfiled, on Ares's dashed Badge: his suggestion turned down, which can't be undone (#71).
      if (suggestion && projectId === null) {
        await settleFiling(suggestion.proposalId, null);
        decided(target, 'filed', null, `Left Unfiled: ${subject}. Ares won’t suggest it again`);
        return;
      }
      const entries = (await client.file(target.itemIds, projectId)).map((entry) => entry.id);
      if (!entries.length) return;
      const project = projectOf(projectId ? { projectId, filedBy: 'user' } : null);
      decided(
        target,
        'filed',
        () => client.undo(entries),
        project ? `Filed under ${project.code}: ${subject}` : `Unfiled: ${subject}`,
      );
    } catch (error) {
      toast(message(error));
    }
  };

  // Make it a Todo: from the thread's latest message someone else wrote, under its Project.
  const makeTodo = async (title: string) => {
    const target = summary;
    if (!target) return;
    try {
      const entries = (await client.makeTodo({ ...emailTodoDraft(target, thread?.messages), title })).map(
        (entry) => entry.id,
      );
      decided(target, 'todo', () => client.undo(entries), `Todo added: ${title}`);
    } catch (error) {
      toast(message(error));
    }
  };

  // The reply: the composer below the thread. Sent, it is a decision (Undo takes the message back
  // while it is still held, in its thread again); closed, Triage moves on.
  const replyTo = writing.composer?.state.replyToItemId ?? null;
  const replyingHere = !!replyTo && !!summary?.itemIds.includes(replyTo);
  const inline = writing.composer?.placement === 'inline' && replyingHere;
  const composing = !!writing.composer;
  const reply = (mode: 'reply' | 'reply-all') => {
    if (summary) void writing.open(mode, summary.latest.id);
  };
  const sent = (out: SentMessage) => {
    const to = out.state.replyToItemId ?? '';
    const target =
      current && summary?.itemIds.includes(to)
        ? current
        : walk?.threads.find((each) => each.itemIds.includes(to));
    if (!target) {
      writing.sent(out);
      return;
    }
    const decision = decided(
      target,
      'replied',
      async () => {
        const held = writing.outbox.find((entry) => entry.itemId === out.itemId);
        if (held && held.state !== 'held') throw new Error('That reply has already gone');
        await writing.undo(out.itemId);
      },
      null,
    );
    writing.sent(out, decision ? () => void undoDecision(decision.id) : undefined);
  };
  const closeComposer = () => {
    const here = replyingHere;
    writing.close();
    if (here) setWalk((now) => now && skip(now));
  };

  // Ares's suggested reply (#143) at the thread's end: opened, it is the reply above, and sending it
  // is the same decision.
  const [drafting, setDrafting] = useState<string | null>(null);
  const draft = async (instruction?: string) => {
    const target = summary;
    if (!target || !currentId) return;
    setDrafting(currentId);
    try {
      await client.draftReply(target.latest.id, instruction);
      setVersion((n) => n + 1);
    } catch (error) {
      toast(message(error));
    } finally {
      setDrafting(null);
    }
  };
  const suggested = thread?.suggestedReply ?? null;
  const openSuggested = async () => {
    if (suggested?.state !== 'ready') return;
    await writing.openSuggested(suggested.answering);
    setVersion((n) => n + 1);
  };
  const dismissSuggested = async () => {
    if (!suggested) return;
    try {
      await client.dismissSuggestedReply(suggested.answering);
      setVersion((n) => n + 1);
    } catch (error) {
      toast(message(error));
    }
  };

  const goNext = () => {
    if (!next) return;
    setNext(null);
    setBucketId(next.bucket.id);
  };

  const deciding = () => !!summary && !composing;
  useShortcuts([
    { keys: 'r', label: 'Reply, then on', group: 'Triage', when: deciding, run: () => reply('reply') },
    {
      keys: 'Shift+R',
      label: 'Reply all, then on',
      group: 'Triage',
      when: deciding,
      run: () => reply('reply-all'),
    },
    {
      keys: 'e',
      label: 'Archive',
      group: 'Triage',
      when: deciding,
      run: () => void act({ type: 'archive' }, 'archived'),
    },
    { keys: 'z', label: 'Snooze', group: 'Triage', when: deciding, run: () => setPicking('snooze') },
    { keys: 't', label: 'Make it a Todo', group: 'Triage', when: deciding, run: () => setPicking('todo') },
    {
      keys: 'v',
      label: 'Move to another Bucket',
      group: 'Triage',
      when: deciding,
      run: () => setPicking('bucket'),
    },
    {
      keys: 'b',
      label: 'Set its Project',
      group: 'Triage',
      when: deciding,
      run: () => setPicking('project'),
    },
    {
      keys: 'j',
      label: 'Skip',
      group: 'Triage',
      when: () => !!current && !composing,
      run: () => setWalk((now) => now && skip(now)),
    },
    {
      keys: ' ',
      label: 'Skip',
      group: 'Triage',
      when: () => !!current && !composing,
      run: () => setWalk((now) => now && skip(now)),
    },
    {
      keys: 'k',
      label: 'Back to the previous thread',
      group: 'Triage',
      when: () => !!walk && walk.at > 0 && !composing,
      run: () => setWalk((now) => now && back(now)),
    },
    { keys: 'Ctrl+z', label: 'Undo the last decision', group: 'Triage', run: () => void undoDecision() },
    {
      keys: 'Enter',
      label: 'Next Bucket (at the end)',
      group: 'Triage',
      when: () => ended && !!next && !document.activeElement?.closest('button, a[href]'),
      run: goNext,
    },
    { keys: 'Escape', label: 'Leave Triage', group: 'Triage', when: () => !composing, run: onLeave },
  ]);

  if (!walk) {
    return <p className="m-0 px-10 py-5 text-note text-faint">Reading {name}…</p>;
  }

  if (ended || !summary) {
    const { done, skipped } = triageSummary(walk);
    return (
      <TriageEnd
        title={walk.threads.length ? `${name} done` : `Nothing to triage in ${name}`}
        done={walk.threads.length ? done : null}
        skipped={skipped}
        next={next}
        onNext={goNext}
        onBack={walk.threads.length ? () => setWalk((now) => now && back(now)) : null}
        onDone={onLeave}
      />
    );
  }

  const composer = writing.composer && (
    <Composer
      key={writing.composer.state.itemId ?? writing.composer.state.replyToItemId ?? 'triage'}
      client={compose}
      initial={writing.current() ?? writing.composer.state}
      accounts={accounts}
      placement={inline ? 'inline' : 'sheet'}
      onClose={closeComposer}
      onSent={sent}
      // A reply scheduled for later (#139) leaves the thread where it is, for the next key.
      onScheduled={writing.scheduledSent}
      onState={writing.track}
      {...(onSaveBeforeQuit ? { onSaveBeforeQuit } : {})}
    />
  );

  return (
    <div data-testid="triage" className="flex flex-1 flex-col">
      <ThreadReader
        thread={thread}
        summary={summary}
        accountName={accountName}
        reader={reader}
        onClose={onLeave}
        noteFor={(item) => {
          const entry = writing.outbox.find((each) => each.itemId === item.id);
          return entry ? (
            <OutboxNote
              entry={entry}
              className="mt-3 border-t border-line2 pt-2"
              onUndo={() => void writing.undo(entry.itemId)}
              onRetry={() => void writing.retry(entry.itemId)}
            />
          ) : null;
        }}
        toolbar={
          <div
            data-testid="triage-header"
            className="flex min-w-0 flex-initial items-center gap-3 border-r border-line2 px-3.5"
          >
            <span data-testid="triage-position" className={cn(caps, 'whitespace-nowrap text-ink')}>
              {triagePosition(name, walk)}
            </span>
            <span ref={badge} className="flex flex-none">
              <ItemBadge filing={summary.latest.filing} suggestion={waitingSuggestion(summary.latest)} />
            </span>
            <BucketChip faint={inBucket === null}>{bucketName(buckets, inBucket)}</BucketChip>
            {outcome && (
              <span data-testid="triage-outcome" className={cn(caps, 'whitespace-nowrap text-muted')}>
                {OUTCOME_LABELS[outcome]}
              </span>
            )}
          </div>
        }
        footer={
          inline ? (
            composer
          ) : (
            <SuggestedReplyCard
              key={currentId ?? 'none'}
              suggestion={suggested}
              drafting={drafting === currentId}
              sources={(thread?.messages ?? []).flatMap(({ body }) => (body ? [body.text] : []))}
              onDraft={(instruction) => void draft(instruction)}
              onOpen={() => void openSuggested()}
              onDismiss={() => void dismissSuggested()}
            />
          )
        }
        legend={<Legend />}
      />
      {!inline && composer}
      {picking === 'snooze' && (
        <SnoozePicker
          thread={summary}
          now={Date.now()}
          onSnooze={(until) => {
            setPicking(null);
            void act({ type: 'snooze', until }, 'snoozed');
          }}
          onUnsnooze={() => {
            setPicking(null);
            void actOnThread(client, summary, { type: 'unsnooze' }).catch((error) => toast(message(error)));
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'bucket' && (
        <BucketPicker
          thread={{ ...summary, bucket: inBucket === null ? null : { bucketId: inBucket, sortedBy: 'user' } }}
          buckets={buckets}
          onPick={(picked) => {
            setPicking(null);
            if (picked !== inBucket) void act({ type: 'bucket', bucketId: picked }, 'moved');
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'project' && (
        <BadgePicker
          target={pickerTarget(summary)}
          anchor={badge.current}
          onClose={() => setPicking(null)}
          onPick={(projectId) => {
            setPicking(null);
            void file(projectId);
          }}
        />
      )}
      {picking === 'todo' && (
        <MakeTodoDialog
          draft={emailTodoDraft(summary, thread?.messages)}
          onClose={() => setPicking(null)}
          onMake={(title) => {
            setPicking(null);
            void makeTodo(title);
          }}
        />
      )}
    </div>
  );
}

/** The end of a Bucket: what was done, and the next Bucket with threads (Enter), or Done (Esc). */
function TriageEnd({
  title,
  done,
  skipped,
  next,
  onNext,
  onBack,
  onDone,
}: {
  title: string;
  /** "12 done: 5 replied, …", or null when there was nothing to triage. */
  done: string | null;
  skipped: number;
  next: { bucket: Bucket; threads: number } | null;
  onNext: () => void;
  /** Back to the last thread (`k`), when there was one. */
  onBack: (() => void) | null;
  onDone: () => void;
}) {
  let line: ReactNode = null;
  if (done)
    line = (
      <p data-testid="triage-summary" className="m-0 mt-3 text-[15px] text-text">
        {done}
      </p>
    );
  return (
    <section aria-label="Triage done" data-testid="triage" className="flex-1 border-t border-line px-10 py-8">
      <h2 className="m-0 font-sans text-[26px] leading-[1.15] font-bold tracking-[-.015em] text-ink font-stretch-(--stretch-wide)">
        {title}
      </h2>
      {line}
      {skipped > 0 && done && (
        <p className="m-0 mt-1 text-note text-muted">
          {skipped} skipped: still in the Bucket.{onBack ? ' K goes back to them.' : ''}
        </p>
      )}
      <div className="mt-6 flex items-center gap-2">
        {next ? (
          <Button variant="primary" size="lg" onClick={onNext}>
            Next: {next.bucket.name} ({next.threads}) <Kbd>↵</Kbd>
          </Button>
        ) : (
          <p className="m-0 mr-2 text-note text-muted">No other Bucket has mail waiting.</p>
        )}
        <Button size="lg" onClick={onDone}>
          Done <Kbd>Esc</Kbd>
        </Button>
      </div>
    </section>
  );
}
