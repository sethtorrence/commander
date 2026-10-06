import { BUCKET_DESCRIPTION_MAX, BUCKET_NAME_MAX, type QueuedAbout } from '@commander/domain';
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  inputVariants,
  toast,
} from '@commander/ui';
import { useEffect, useMemo, useState } from 'react';
import { bucketsIn } from '../buckets/buckets';
import type { ItemStoreClient } from '../item-store/client';
import { errorText } from '../projects/change-with-undo';

export type NewBucketSuggestion = {
  about: Extract<QueuedAbout, { kind: 'bucket-suggestion' }>;
  queuedId: number;
  // A fresh one each time the User accepts, so accepting again reopens the dialog.
  at: number;
};

/**
 * Accepting a Bucket Ares suggests (#141) in the Update: Add Bucket opens it, its name and description
 * filled in and editable, to add at the end of the list. Nothing is added until the User saves it;
 * once it is, the line is done. Cancelled, the line stays queued.
 */
export function SuggestedNewBucket({
  suggestion,
  itemStore = window.commander.itemStore,
  onSaved,
}: {
  suggestion: NewBucketSuggestion;
  itemStore?: ItemStoreClient;
  onSaved: (queuedId: number) => void;
}) {
  const client = useMemo(() => bucketsIn(itemStore), [itemStore]);
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(suggestion.about.name);
  const [description, setDescription] = useState(suggestion.about.description);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens afresh for each acceptance (`at`)
  useEffect(() => {
    setOpen(true);
    setName(suggestion.about.name);
    setDescription(suggestion.about.description);
  }, [suggestion.at]);

  const add = async () => {
    if (!name.trim()) return;
    try {
      const done = await client.change({
        type: 'create',
        bucket: { name: name.trim(), description: description.trim() },
      });
      setOpen(false);
      onSaved(suggestion.queuedId);
      toast(`Added the Bucket ${done.bucket?.name ?? name.trim()}`);
    } catch (reason) {
      toast(errorText(reason));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[min(520px,calc(100vw-48px))]">
        <DialogHeader partNumber="BKT-NEW">
          <DialogTitle>Add a Bucket</DialogTitle>
        </DialogHeader>
        <DialogDescription className="px-5 pt-3 text-note text-muted">
          Ares suggests this Bucket. Ares sorts by the description, so say plainly what belongs in it.
        </DialogDescription>
        <DialogBody className="flex flex-col gap-2">
          <Input
            aria-label="Bucket name"
            value={name}
            maxLength={BUCKET_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            className="font-semibold"
          />
          <textarea
            aria-label="Bucket description"
            rows={3}
            value={description}
            maxLength={BUCKET_DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
            className={cn(inputVariants(), 'h-auto resize-y py-1.5 leading-[1.45]')}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void add()}>
            Add Bucket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
