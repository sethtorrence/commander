// What each kind of Update line knows how to do (#186). Every line answers four things in Ares's
// voice: what it is (named: the Item's title and Source), what happened, why it matters to the User,
// and what to do next (or plainly "nothing to do"). A kind is one entry in the registry (index.ts),
// so a new producer adds its kind there and nothing else in the Update has to change.
import type {
  Item,
  ProposalRecord,
  QueuedAbout,
  QueuedKind,
  QueuedLine,
  UpdateRowAction,
} from '@commander/domain';

/** What a kind may read about the Items of a line. */
export type LineContext = {
  item(itemId: string): Item | null;
  proposal(id: number): ProposalRecord | null;
  // The suggestions made on an Item, newest first.
  proposalsOn(itemId: string): ProposalRecord[];
  // A Project's code ("TX"), by its id.
  projectCode(projectId: string): string | null;
  // A Bucket's name ("Receipts"), by its id (#141).
  bucketName?(bucketId: string): string | null;
  // The warning standing on an Item: what in it read like an instruction (word for word, when
  // known), or null when it isn't marked.
  warning(itemId: string): { quote: string | null } | null;
  // The open Linear Todo backing an issue, if any: what Tick ticks.
  todoOf(issueId: string): string | null;
  // Who the User is in an Account (their Teams user id), when known.
  me(account: string): string | null;
  now: number;
};

export type KindLine<K extends QueuedKind> = Pick<QueuedLine, 'itemIds'> & {
  about: Extract<QueuedAbout, { kind: K }>;
};

/** How one Item of a line stands: its row in the panel, and what its data block says of it. */
export type RowFacts = {
  // A few words on where it stands ("Reassigned to Priya Patel").
  state: string;
  // What in it read like an instruction to Ares, word for word (shown in the row, never sent).
  quote?: string | null;
  // Where Reply opens it (a Chat's message waiting on the User).
  focus?: string | null;
  actions: UpdateRowAction[];
  // More it is worth knowing, for its data block only ("Ares's reason: …").
  more?: string[];
  // What became of it, once it was dealt with ("Not an instruction", "Accepted").
  settled?: string | null;
};

export type LineKind<K extends QueuedKind> = {
  // What the line is about, in a few words, for its data block's label ("Linear issues off your list").
  name: string;
  // The plain sentence, from the Items' own data alone: what it is, what happened, why it matters,
  // what to do. What the User sees when the model is off or fails, so it must stand on its own.
  template(line: KindLine<K>, context: LineContext): string;
  // What Commander knows of the line in its own words, never outside words (its data block).
  facts(line: KindLine<K>, context: LineContext): string[];
  // How one of its Items stands; null when it isn't one of them any more (dismissed from the line).
  row(line: KindLine<K>, itemId: string, context: LineContext): RowFacts | null;
  // The line without one of its Items (dismissed from the Update), or null when none would be left.
  without?(
    about: Extract<QueuedAbout, { kind: K }>,
    itemId: string,
    context: LineContext,
  ): QueuedAbout | null;
  // What a good line of this kind says, with a good and a bad example, for the prompt.
  guidance: string;
  // Lines kept out of "Put Updates together": worded alongside (a busy Chat), or Commander's to say.
  apart?: boolean;
};

export type LineKinds = { [K in QueuedKind]: LineKind<K> };
