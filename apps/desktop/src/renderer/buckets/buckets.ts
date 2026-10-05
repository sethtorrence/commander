import { type Bucket, type BucketAction, type BucketChange, NEEDS_REPLY, UNSORTED } from '@commander/domain';
import { useCallback, useEffect, useState } from 'react';
import type { ItemStoreClient } from '../item-store/client';

/*
  The renderer's view of Buckets (#137): the User's list in the Item store and changing it. Settings
  → Buckets, the Email Section (its Bucket strip and the `v` picker) and the Rule editor read it here.
*/

export interface BucketsClient {
  /** The User's Buckets in their order. */
  list(): Promise<Bucket[]>;
  /** Renames, describes, adds, removes, reorders or restores a Bucket. */
  change(action: BucketAction): Promise<BucketChange>;
}

export function bucketsIn(itemStore: ItemStoreClient): BucketsClient {
  return {
    list: () => itemStore({ op: 'buckets' }),
    change: (action) => itemStore({ op: 'change-bucket', action }),
  };
}

/** The Buckets, read once and again on `reload`; empty until read. */
export function useBucketList(client: BucketsClient): {
  buckets: Bucket[];
  loaded: boolean;
  reload: () => Promise<void>;
} {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const reload = useCallback(
    () =>
      client.list().then(
        (found) => setBuckets(found),
        () => {},
      ),
    [client],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { buckets: buckets ?? [], loaded: buckets !== null, reload };
}

/** The Email Section's order: Needs reply first, then the User's order. (Unsorted comes last.) */
export const stripOrder = (buckets: readonly Bucket[]): Bucket[] => [
  ...buckets.filter((bucket) => bucket.id === NEEDS_REPLY),
  ...buckets.filter((bucket) => bucket.id !== NEEDS_REPLY),
];

/** How a Bucket (or Unsorted, null) reads. A Bucket since removed reads as Unsorted. */
export const bucketName = (buckets: readonly Bucket[], bucketId: string | null | undefined) =>
  (bucketId && buckets.find((bucket) => bucket.id === bucketId)?.name) || 'Unsorted';

export { UNSORTED };
