import { type Bucket, type EmailThreadSummary, UNSORTED } from '@commander/domain';
import {
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Kbd,
} from '@commander/ui';
import type { KeyboardEvent } from 'react';
import { stripOrder } from '../../buckets/buckets';

/*
  The Email Section's Buckets (#137): the Bucket strip under the sheet header, which narrows the list
  to one Bucket (or Unsorted) with each one's count and starts Triage (#140), and the Bucket picker
  (`v`), which moves the selected thread. Buckets are Commander's own: nothing here reaches Gmail.
*/

const caps = 'font-mono text-label leading-none font-semibold uppercase tracking-caps';

/**
 * All, then Needs reply, the User's other Buckets in their order, and Unsorted, each with its count
 * (the listed view's threads under the Project filter). Choosing one narrows the list; All shows
 * every Bucket. At the end, Triage (#140) walks the chosen Bucket, Needs reply unless one is chosen.
 */
export function BucketStrip({
  buckets,
  counts,
  bucket,
  onBucket,
  triage,
}: {
  buckets: readonly Bucket[];
  counts: ReadonlyMap<string, number>;
  bucket: string | null;
  onBucket: (bucket: string | null) => void;
  /** The Bucket Triage would walk, and starting it; absent, no Triage button (no email Account). */
  triage?: { name: string; onStart: () => void } | undefined;
}) {
  const choices: { id: string | null; name: string; key: string }[] = [
    { id: null, name: 'All', key: 'all' },
    ...stripOrder(buckets).map((each) => ({ id: each.id, name: each.name, key: each.id })),
    { id: UNSORTED, name: 'Unsorted', key: UNSORTED },
  ];
  return (
    <div className="flex h-[34px] flex-none items-stretch overflow-x-auto border-b border-line">
      <span className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-[8px] leading-none font-semibold tracking-caps text-faint">
        BKT
      </span>
      <div role="tablist" aria-label="Bucket" className="flex min-w-0 items-stretch">
        {choices.map((choice) => {
          const on = choice.id === bucket;
          const count = counts.get(choice.key) ?? 0;
          return (
            <button
              key={choice.key}
              type="button"
              role="tab"
              aria-selected={on}
              data-bucket={choice.key}
              onClick={() => onBucket(choice.id)}
              className={cn(
                'flex flex-none cursor-pointer items-center gap-2 border-0 border-r border-line2 px-3.5 whitespace-nowrap',
                caps,
                on ? 'bg-ink text-sheet' : 'bg-transparent text-ink hover:bg-raise',
                choice.id === UNSORTED && !on && 'text-muted',
              )}
            >
              {choice.name}
              {count > 0 && <b className={on ? 'text-sheet' : 'text-muted'}>{count}</b>}
            </button>
          );
        })}
      </div>
      {triage && (
        <button
          type="button"
          onClick={triage.onStart}
          aria-keyshortcuts="Shift+T"
          className={cn(
            'ml-auto flex flex-none cursor-pointer items-center gap-2 border-0 border-l border-line bg-transparent px-4 whitespace-nowrap text-ink hover:bg-raise',
            caps,
          )}
        >
          Triage {triage.name} <Kbd>⇧T</Kbd>
        </button>
      )}
    </div>
  );
}

/**
 * The Bucket picker (`v`): every Bucket, Needs reply first, then Unsorted; a click or its number
 * (0 for Unsorted) moves the whole thread there, as the User's choice.
 */
export function BucketPicker({
  thread,
  buckets,
  onPick,
  onClose,
}: {
  thread: EmailThreadSummary;
  buckets: readonly Bucket[];
  onPick: (bucketId: string | null) => void;
  onClose: () => void;
}) {
  const current = thread.bucket?.bucketId ?? null;
  const choices = [
    ...stripOrder(buckets).map((each, index) => ({
      id: each.id as string | null,
      name: each.name,
      key: index < 9 ? String(index + 1) : null,
    })),
    { id: null, name: 'Unsorted', key: '0' },
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const choice = choices.find((each) => each.key === event.key);
    if (!choice || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    onPick(choice.id);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(420px,calc(100vw-48px))]" onKeyDown={onKeyDown}>
        <DialogHeader partNumber="EML-V">
          <DialogTitle>Move to a Bucket</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">Which Bucket {thread.subject} goes in</DialogDescription>
        <DialogBody>
          <div role="listbox" aria-label="Buckets" className="m-0 flex flex-col p-0">
            {choices.map((choice) => {
              const on = choice.id === current;
              return (
                <button
                  key={choice.id ?? UNSORTED}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => onPick(choice.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 border-0 border-b border-line2 bg-transparent px-1 py-2 text-left text-row text-ink hover:bg-raise',
                    on && 'font-semibold',
                  )}
                >
                  {choice.key ? <Kbd>{choice.key}</Kbd> : <span className="w-[17px]" />}
                  <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                  {on && <span className={cn(caps, 'text-muted')}>Now</span>}
                </button>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
