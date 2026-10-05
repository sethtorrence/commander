import type {
  Bucket,
  RefileCandidate,
  ResortCandidate,
  Rule,
  RuleAction,
  RuleChange,
  RuleDraft,
} from '@commander/domain';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  toast,
} from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { BucketChip } from '../buckets/BucketChip';
import { bucketName } from '../buckets/buckets';
import { ItemBadge } from '../projects/badges';
import { errorText } from '../projects/change-with-undo';
import { useProjects } from '../projects/context';
import { type Editing, RuleEditor } from './RuleEditor';
import { type RulesClient, ruleText } from './rules';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Workspace names by Account, from Settings → Accounts, when the window can ask for them. */
function useAccountNames(): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const accounts = typeof window === 'undefined' ? undefined : window.commander?.accounts;
    if (!accounts) return;
    let current = true;
    accounts({ op: 'list' }).then(
      ({ state }) => current && setNames(new Map(state.accounts.map((a) => [a.id, a.name]))),
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);
  return names;
}

export interface RuleFlow {
  /** The Rules in their order; empty until loaded. */
  rules: Rule[];
  /** The Buckets Rules can sort email into (#137), for how a Bucket Rule reads. */
  buckets: Bucket[];
  loaded: boolean;
  reload: () => Promise<void>;
  /**
   * Opens the editor on a Rule, or on a new one (filing into `projectId` to start with, or from a
   * draft with a place to go: a Rule Ares suggested).
   */
  edit: (
    rule: Rule | null,
    projectId?: string,
    start?: Pick<Editing, 'draft' | 'position' | 'onSaved' | 'bucketId'>,
  ) => void;
  /** Moves a Rule to a place in the list, then offers to re-file what that moves. */
  move: (rule: Rule, position: number) => Promise<void>;
  /** Deletes a Rule, leaving its Items where they are; the toast's Undo brings it back. */
  remove: (rule: Rule) => Promise<void>;
  /** The editor and the re-file offer, to render once. */
  ui: ReactNode;
}

/**
 * Everything around changing Rules, shared by Settings → Rules and a Project page's Mapping Rules:
 * the list, the editor (with the overlap question), and after a change, "Also re-file 42 existing
 * items?" (or, for a Bucket Rule, "Also re-sort 42 existing emails?") with its preview; accepting
 * re-files (or re-sorts) them as one change, which one Undo reverts.
 * `onChanged` runs after anything that may have moved Items.
 */
export function useRuleFlow(client: RulesClient, onChanged?: () => void): RuleFlow {
  const { projects, archived } = useProjects();
  const everyProject = [...projects, ...archived];
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [offer, setOffer] = useState<RefileCandidate[] | null>(null);
  const [resortOffer, setResortOffer] = useState<ResortCandidate[] | null>(null);
  const accountNames = useAccountNames();
  const text = (rule: Pick<Rule, 'when' | 'target'>) => ruleText(rule, everyProject, buckets);

  const reload = useCallback(
    () =>
      Promise.all([client.list(), client.buckets()]).then(
        ([found, sorted]) => {
          setRules(found);
          setBuckets(sorted);
        },
        (reason: unknown) => {
          toast(errorText(reason));
        },
      ),
    [client],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  // Makes a change, reloads, and offers to re-file what it moves. Resolves with the change, or with
  // the reason it was refused.
  const apply = async (action: RuleAction): Promise<RuleChange | string> => {
    let change: RuleChange;
    try {
      change = await client.change(action);
    } catch (reason) {
      return errorText(reason);
    }
    await reload();
    if (change.refile.length) setOffer(change.refile);
    if (change.resort.length) setResortOffer(change.resort);
    return change;
  };
  const offers = (change: RuleChange) => change.refile.length + change.resort.length > 0;

  const save = async (rule: RuleDraft, position: number | undefined): Promise<string | null> => {
    const action: RuleAction = editing?.rule
      ? { type: 'update', ruleId: editing.rule.id, rule, position }
      : { type: 'create', rule, position };
    const done = await apply(action);
    if (typeof done === 'string') return done;
    editing?.onSaved?.();
    setEditing(null);
    if (!offers(done)) toast(editing?.rule ? 'Rule saved' : 'Rule created');
    return null;
  };

  const move = async (rule: Rule, position: number) => {
    const done = await apply({ type: 'move', ruleId: rule.id, position });
    if (typeof done === 'string') toast(done);
    else if (!offers(done)) toast(`Moved ${text(rule)} to ${position + 1}`);
  };

  const remove = async (rule: Rule) => {
    const done = await apply({ type: 'delete', ruleId: rule.id });
    if (typeof done === 'string') return void toast(done);
    toast(`Rule deleted: ${text(rule)}. Its Items stay where they are`, {
      action: {
        label: 'Undo',
        onClick: () =>
          apply({ type: 'restore', ruleId: rule.id }).then((undone) => {
            if (typeof undone === 'string') toast(undone);
          }),
      },
    });
  };

  const accept = async (candidates: RefileCandidate[]) => {
    setOffer(null);
    let entries: Awaited<ReturnType<RulesClient['refile']>>;
    try {
      entries = await client.refile(candidates.map((candidate) => candidate.item.id));
    } catch (reason) {
      return void toast(errorText(reason));
    }
    onChanged?.();
    // Longer than most toasts: it is the one way back from re-filing many Items at once.
    toast(`Re-filed ${plural(entries.length, 'item')}`, {
      duration: 12_000,
      action: {
        label: 'Undo',
        onClick: () =>
          client.undoRefile(entries.map((entry) => entry.id)).then(
            (undone) => {
              onChanged?.();
              toast(`Re-filing undone: ${plural(undone.length, 'item')} back where they were`);
            },
            (reason: unknown) => toast(errorText(reason)),
          ),
      },
    });
  };

  const acceptResort = async (candidates: ResortCandidate[]) => {
    setResortOffer(null);
    let entries: Awaited<ReturnType<RulesClient['resort']>>;
    try {
      entries = await client.resort(candidates.map((candidate) => candidate.item.id));
    } catch (reason) {
      return void toast(errorText(reason));
    }
    onChanged?.();
    toast(`Re-sorted ${plural(entries.length, 'email')}`, {
      duration: 12_000,
      action: {
        label: 'Undo',
        onClick: () =>
          client.undoResort(entries.map((entry) => entry.id)).then(
            (undone) => {
              onChanged?.();
              toast(`Re-sorting undone: ${plural(undone.length, 'email')} back where they were`);
            },
            (reason: unknown) => toast(errorText(reason)),
          ),
      },
    });
  };

  return {
    rules: rules ?? [],
    buckets,
    loaded: rules !== null,
    reload,
    edit: (rule, projectId, start) => setEditing({ rule, projectId, ...start }),
    move,
    remove,
    ui: (
      <>
        <RuleEditor
          editing={editing}
          rules={rules ?? []}
          client={client}
          accountNames={accountNames}
          onClose={() => setEditing(null)}
          onSave={save}
        />
        <RefileOffer
          candidates={offer}
          onAccept={accept}
          onDecline={() => {
            setOffer(null);
            toast('Nothing re-filed. Rules file new Items as they arrive');
          }}
        />
        <ResortOffer
          candidates={resortOffer}
          buckets={buckets}
          onAccept={acceptResort}
          onDecline={() => {
            setResortOffer(null);
            toast('Nothing re-sorted. Rules sort new emails as they arrive');
          }}
        />
      </>
    ),
  };
}

/** "Also re-file 42 existing items?", with each Item's current and new Badge. */
function RefileOffer({
  candidates,
  onAccept,
  onDecline,
}: {
  candidates: RefileCandidate[] | null;
  onAccept: (candidates: RefileCandidate[]) => void;
  onDecline: () => void;
}) {
  const count = candidates?.length ?? 0;
  return (
    <Dialog open={candidates !== null} onOpenChange={(open) => !open && onDecline()}>
      {candidates && (
        <DialogContent aria-describedby={undefined} className="w-[min(640px,calc(100vw-48px))]">
          <DialogHeader partNumber="RFL">
            <DialogTitle>Re-file existing items</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogHeading>Also re-file {plural(count, 'existing item')}?</DialogHeading>
            <DialogDescription>
              The Rules now file {count === 1 ? 'this Item' : 'these Items'} elsewhere. Items you filed by
              hand are never changed. One Undo puts them all back.
            </DialogDescription>
            <ul
              aria-label="Re-file preview"
              className="mt-3.5 mb-0 max-h-[min(46vh,420px)] list-none overflow-auto border border-line p-0"
            >
              {candidates.map((candidate) => (
                <li
                  key={candidate.item.id}
                  className="flex items-center gap-2.5 border-b border-line2 px-2.5 py-1.5 text-note leading-[18px] last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-text">{candidate.item.title}</span>
                  <ItemBadge filing={candidate.from} />
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                  <ItemBadge filing={candidate.to} />
                </li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onDecline}>Not now</Button>
            <Button variant="primary" onClick={() => onAccept(candidates)}>
              Re-file {plural(count, 'item')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Also re-sort 42 existing emails?", with each email's current and new Bucket (#137). */
function ResortOffer({
  candidates,
  buckets,
  onAccept,
  onDecline,
}: {
  candidates: ResortCandidate[] | null;
  buckets: readonly Bucket[];
  onAccept: (candidates: ResortCandidate[]) => void;
  onDecline: () => void;
}) {
  const count = candidates?.length ?? 0;
  return (
    <Dialog open={candidates !== null} onOpenChange={(open) => !open && onDecline()}>
      {candidates && (
        <DialogContent aria-describedby={undefined} className="w-[min(640px,calc(100vw-48px))]">
          <DialogHeader partNumber="RSR">
            <DialogTitle>Re-sort existing emails</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogHeading>Also re-sort {plural(count, 'existing email')}?</DialogHeading>
            <DialogDescription>
              The Rules now sort {count === 1 ? 'this email' : 'these emails'} into another Bucket. Emails you
              sorted by hand are never changed. One Undo puts them all back.
            </DialogDescription>
            <ul
              aria-label="Re-sort preview"
              className="mt-3.5 mb-0 max-h-[min(46vh,420px)] list-none overflow-auto border border-line p-0"
            >
              {candidates.map((candidate) => (
                <li
                  key={candidate.item.id}
                  className="flex items-center gap-2.5 border-b border-line2 px-2.5 py-1.5 text-note leading-[18px] last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-text">{candidate.item.title}</span>
                  <BucketChip>{bucketName(buckets, candidate.from?.bucketId)}</BucketChip>
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                  <BucketChip>{bucketName(buckets, candidate.to.bucketId)}</BucketChip>
                </li>
              ))}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onDecline}>Not now</Button>
            <Button variant="primary" onClick={() => onAccept(candidates)}>
              Re-sort {plural(count, 'email')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
