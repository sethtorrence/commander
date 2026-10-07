// The Update line about changes that didn't reach a Source (#206): "2 changes didn't reach Linear:
// moving ENG-418 to In Review and archiving “Invoice 42”. …", one line per Account and Source, with
// Retry. Each change is said in the words kept with the line (the domain's outgoing-words.ts, from the
// change's own data), and each Item is a row with where its changes stand now. Facts about the User's
// own changes, so the line stays in Commander's words and is never sent to "Put Updates together".
import { changePhrase, type QueuedAbout, SOURCE_NAME_OF } from '@commander/domain';
import type { LineContext, LineKind } from './types';
import { cut, labelOf, listed, plural } from './words';

type About = Extract<QueuedAbout, { kind: 'couldnt-sync' }>;

// An Item by its short name: ENG-418, or its title.
function shortName(itemId: string, context: LineContext): string {
  const item = context.item(itemId);
  if (!item) return 'an Item no longer in Commander';
  return labelOf(item) ?? `“${cut(item.title, 60) || 'Untitled'}”`;
}

// The Source as the User knows the Account: "Linear (Acme)".
const whereOf = (about: About) => `${SOURCE_NAME_OF[about.source]}${about.name ? ` (${about.name})` : ''}`;

export const couldntSyncLines: LineKind<'couldnt-sync'> = {
  name: 'changes that didn’t reach a Source',
  template({ about }, context) {
    const source = SOURCE_NAME_OF[about.source];
    const said = about.changes.map((change) => changePhrase(change, shortName(change.itemId, context)));
    const one = about.changes.length === 1;
    const [it, they] = one ? ['It', 'it'] : ['They', 'them'];
    const what = one
      ? `A change you made didn’t reach ${whereOf(about)}: ${said[0]}.`
      : `${plural(about.changes.length, 'change')} you made didn’t reach ${whereOf(about)}: ${listed(said)}.`;
    const held = about.heldAfterRestore
      ? ` ${one ? 'It was' : 'They were'} held after a restore and may already be in ${source}, so check there before you retry.`
      : ` ${it} ${one ? 'stays' : 'stay'} as you made ${they} in Commander until ${one ? 'it goes' : 'they go'} through.`;
    return `${what}${held} Retry ${they}, or discard ${they} in Settings → Accounts to go back to what ${source} has.`;
  },
  facts: ({ about }) => [
    `What it is: changes the User made in Commander that ${SOURCE_NAME_OF[about.source]} refused, or that failed five times, so they stopped (Couldn’t sync).`,
    `How many: ${about.changes.length}`,
    ...(about.heldAfterRestore
      ? ['They were held after a restore: they may already have reached the Source before it.']
      : []),
    'What to do: Retry, or Discard in Settings → Accounts, which puts the Item back as the Source has it. The line clears once they go through or are discarded.',
  ],
  row({ about }, itemId, context) {
    const changes = about.changes.filter((change) => change.itemId === itemId);
    const standing = changes.map((change) => ({ change, status: context.change?.(change.id) ?? null }));
    const queued = standing.filter((each) => each.status !== null);
    if (!queued.length) return null;
    const failed = queued.filter((each) => each.status === 'failed');
    const whats = (list: typeof queued) => list.map((each) => each.change.what).join('; ');
    return failed.length
      ? { state: `Couldn’t sync: ${whats(failed)}`, actions: ['open', 'retry'] }
      : { state: `Trying again: ${whats(queued)}`, actions: ['open'] };
  },
  without(about, itemId) {
    const changes = about.changes.filter((change) => change.itemId !== itemId);
    return changes.length ? { ...about, changes } : null;
  },
  apart: true,
  guidance: '',
};
