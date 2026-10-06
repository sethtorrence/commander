// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import { Toaster } from '@commander/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../item-store/client';
import { openTestItemStore } from '../item-store/test-item-store';
import { SuggestedNewBucket } from './SuggestedNewBucket';

// Accepting a Bucket Ares suggests (#141): the dialog opens with his name and description, editable;
// nothing is added until the User saves it.

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
});

afterEach(() => {
  cleanup();
  close();
});

const suggestion = {
  about: {
    kind: 'bucket-suggestion' as const,
    name: 'Investors',
    description: 'Updates and questions from our investors',
    reason: 'You moved three investor emails',
  },
  queuedId: 7,
  at: 1,
};

describe('a Bucket Ares suggests', () => {
  it('opens filled in, adds nothing until saved, and adds it as edited', async () => {
    const onSaved = vi.fn();
    render(
      <>
        <SuggestedNewBucket suggestion={suggestion} itemStore={client} onSaved={onSaved} />
        <Toaster />
      </>,
    );
    const name = (await screen.findByRole('textbox', { name: 'Bucket name' })) as HTMLInputElement;
    expect(name.value).toBe('Investors');
    expect((screen.getByRole('textbox', { name: 'Bucket description' }) as HTMLTextAreaElement).value).toBe(
      'Updates and questions from our investors',
    );
    expect(store.buckets().map((bucket) => bucket.name)).not.toContain('Investors');

    fireEvent.change(name, { target: { value: 'Investor mail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Bucket' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(7));
    expect(store.buckets().at(-1)).toMatchObject({
      name: 'Investor mail',
      description: 'Updates and questions from our investors',
    });
  });

  it('Cancel adds nothing', async () => {
    const onSaved = vi.fn();
    render(<SuggestedNewBucket suggestion={suggestion} itemStore={client} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(store.buckets()).toHaveLength(7);
  });
});
