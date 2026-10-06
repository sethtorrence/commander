import {
  BUCKET_DESCRIPTION_EXAMPLE,
  BUCKET_DESCRIPTION_MAX,
  BUCKET_NAME_MAX,
  type Bucket,
  type BucketAction,
  type BucketChange,
  suggestsSkippingTheInbox,
} from '@commander/domain';
import { Button, cn, Input, inputVariants, Switch, toast } from '@commander/ui';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import { errorText } from '../projects/change-with-undo';
import { SettingRow, SettingsGroup } from '../settings/parts';
import { bucketsIn, useBucketList } from './buckets';

const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Settings → Buckets (#137): what to do with an email, in the User's order, each with the plain
 * description Ares sorts by. Rename and describe in place (saved when the field is left), add,
 * remove (its emails become Unsorted and its Rules go; the toast's Undo brings it all back) and
 * reorder with the arrows. Each one's Skip the inbox (#142), off unless switched on, archives mail
 * landing in it in Gmail or Outlook (suggested for Newsletters, Receipts and Junk). `shown` while
 * Settings is on screen: read again each time it comes back.
 */
export function BucketsSettings({
  no,
  shown = true,
  itemStore = window.commander.itemStore,
}: {
  no: string;
  shown?: boolean;
  itemStore?: ItemStoreClient;
}) {
  const client = useMemo(() => bucketsIn(itemStore), [itemStore]);
  const { buckets, loaded, reload } = useBucketList(client);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) void reload();
    wasShown.current = shown;
  }, [shown, reload]);

  // Makes a change and reads the list again. Resolves with the change, or null when it was refused.
  const change = async (action: BucketAction): Promise<BucketChange | null> => {
    try {
      const done = await client.change(action);
      await reload();
      return done;
    } catch (reason) {
      toast(errorText(reason));
      await reload();
      return null;
    }
  };

  // Skip the inbox: what it does, said once it is on.
  const skip = async (bucket: Bucket, on: boolean) => {
    const done = await change({ type: 'update', bucketId: bucket.id, bucket: { skipInbox: on } });
    if (!done || !on) return;
    toast(
      `${bucket.name} now skips the inbox. Mail you sort into it is archived at once; mail a Rule or Ares sorts into it is offered for archiving (Settings → Autonomy decides).`,
      { duration: 10_000 },
    );
  };

  const remove = async (bucket: Bucket) => {
    const done = await change({ type: 'delete', bucketId: bucket.id });
    if (!done) return;
    const rules = done.rules.length ? ` and ${plural(done.rules.length, 'Rule')} removed` : '';
    toast(
      `Removed ${bucket.name}. Its ${plural(done.unsorted.length, 'email')} ${done.unsorted.length === 1 ? 'is' : 'are'} Unsorted${rules}`,
      {
        duration: 12_000,
        action: {
          label: 'Undo',
          onClick: () =>
            void change({ type: 'restore', bucketId: bucket.id, unsorted: done.unsorted, rules: done.rules }),
        },
      },
    );
  };

  return (
    <SettingsGroup
      no={no}
      title="Buckets"
      note={`${pad(buckets.length)} Buckets · Ares sorts by the description`}
    >
      <p className="m-0 border-b border-line2 py-3 pr-6 pl-13 text-note leading-[19px] text-muted">
        Every email sits in one Bucket, or is Unsorted, whatever its Project. Ares sorts mail by each Bucket’s
        description, so say plainly what belongs, as {BUCKET_DESCRIPTION_EXAMPLE.name} does: “
        {BUCKET_DESCRIPTION_EXAMPLE.description}” Bucket Rules (Settings → Rules) sort before he does, and
        your own sorting beats both. Buckets stay in Commander: mail is archived in Gmail or Outlook only for
        a Bucket you set to skip the inbox, and Bucket labels appear there only for an Account you set to
        mirror them (Settings → Accounts).
      </p>
      {buckets.length ? (
        <ol aria-label="Buckets" className="m-0 list-none p-0">
          {buckets.map((bucket, index) => (
            <BucketRow
              key={bucket.id}
              bucket={bucket}
              index={index}
              last={index === buckets.length - 1}
              onChange={(action) => void change(action)}
              onSkip={(on) => void skip(bucket, on)}
              onRemove={() => void remove(bucket)}
            />
          ))}
        </ol>
      ) : (
        loaded && (
          <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
            No Buckets. Every email is Unsorted.
          </p>
        )
      )}
      <NewBucket onAdd={(bucket) => change({ type: 'create', bucket })} />
    </SettingsGroup>
  );
}

function BucketRow({
  bucket,
  index,
  last,
  onChange,
  onSkip,
  onRemove,
}: {
  bucket: Bucket;
  index: number;
  last: boolean;
  onChange: (action: BucketAction) => void;
  onSkip: (on: boolean) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(bucket.name);
  const [description, setDescription] = useState(bucket.description);
  // The list read again (a refused rename, an Undo) shows what the Item store holds.
  useEffect(() => setName(bucket.name), [bucket.name]);
  useEffect(() => setDescription(bucket.description), [bucket.description]);

  const saveName = () => {
    const next = name.trim();
    if (!next) return setName(bucket.name);
    if (next !== bucket.name) onChange({ type: 'update', bucketId: bucket.id, bucket: { name: next } });
  };
  const saveDescription = () => {
    if (description.trim() !== bucket.description)
      onChange({ type: 'update', bucketId: bucket.id, bucket: { description: description.trim() } });
  };
  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      event.stopPropagation();
      setName(bucket.name);
    }
  };

  return (
    <li
      data-testid="bucket"
      className="relative grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_auto] items-start gap-4 border-b border-line2 py-2.5 pr-6 pl-13"
    >
      <span className="absolute top-3.5 left-0 w-10 text-center font-mono text-label font-medium text-faint">
        {pad(index + 1)}
      </span>
      <Input
        aria-label={`Name of ${bucket.name}`}
        value={name}
        maxLength={BUCKET_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        onBlur={saveName}
        onKeyDown={onNameKey}
        className="font-semibold"
      />
      <div className="flex min-w-0 flex-col gap-2">
        <textarea
          aria-label={`Description of ${bucket.name}`}
          rows={2}
          value={description}
          maxLength={BUCKET_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={saveDescription}
          className={cn(inputVariants(), 'h-auto resize-y py-1.5 leading-[1.45]')}
        />
        <span className="flex items-center gap-2.5 text-note text-muted">
          <Switch
            aria-label={`${bucket.name} skips the inbox`}
            checked={bucket.skipInbox}
            onCheckedChange={onSkip}
          />
          <span className="text-ink">Skip the inbox</span>
          <span>
            {bucket.skipInbox
              ? 'Archived in Gmail or Outlook as it lands here'
              : suggestsSkippingTheInbox(bucket.id)
                ? 'Suggested: keeps this mail out of your inbox'
                : 'Off'}
          </span>
        </span>
      </div>
      <span className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Move ${bucket.name} up`}
          disabled={index === 0}
          onClick={() => onChange({ type: 'move', bucketId: bucket.id, position: index - 1 })}
        >
          ↑
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Move ${bucket.name} down`}
          disabled={last}
          onClick={() => onChange({ type: 'move', bucketId: bucket.id, position: index + 1 })}
        >
          ↓
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Remove ${bucket.name}`} onClick={onRemove}>
          Remove
        </Button>
      </span>
    </li>
  );
}

function NewBucket({
  onAdd,
}: {
  onAdd: (bucket: { name: string; description: string }) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const add = async () => {
    if (!name.trim()) return;
    if (await onAdd({ name: name.trim(), description: description.trim() })) {
      setName('');
      setDescription('');
    }
  };
  return (
    <SettingRow
      label="New Bucket"
      description="A name, and what belongs in it in a sentence or two: Ares sorts by what you write."
    >
      <div className="flex flex-col gap-2">
        <Input
          aria-label="New Bucket name"
          placeholder="Name"
          value={name}
          maxLength={BUCKET_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void add()}
          className="max-w-[260px]"
        />
        <textarea
          aria-label="New Bucket description"
          placeholder="What belongs in it"
          rows={2}
          value={description}
          maxLength={BUCKET_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          className={cn(inputVariants(), 'h-auto resize-y py-1.5 leading-[1.45]')}
        />
        <div>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void add()}>
            Add Bucket
          </Button>
        </div>
      </div>
    </SettingRow>
  );
}
