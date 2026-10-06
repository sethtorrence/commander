// Update lines about Ares's own work (#70, #121, #130, #186): the month's cost-cap warning, a meeting's
// prep that's ready, and his GitHub summary. Their numbers and times are Commander's own.
import { isGitHubSummary, type MeetingPrepDetail } from '@commander/domain';
import type { LineKind } from './types';
import { clock, dayWord, nextMonthStart, oneLine, plural } from './words';

const money = (usd: number) => `$${usd.toFixed(2)}`;
const share = ({ spentUsd, capUsd }: { spentUsd: number; capUsd: number }) =>
  `${Math.round((spentUsd / capUsd) * 100)}%`;
// The month after `month` (YYYY-MM) begins: "1 November".
const monthAfter = (month: string) => {
  const [year, number] = month.split('-').map(Number);
  return nextMonthStart(new Date(year as number, (number as number) - 1, 15).getTime());
};

export const capLines: LineKind<'cap-warning'> = {
  name: 'this month’s model spend',
  template: ({ about }) =>
    `This month’s model spend is ${money(about.spentUsd)}, ${share(about)} of your ${money(about.capUsd)} cap. At the cap, my deeper work waits until ${monthAfter(about.month)}; raise the cap in Settings if you’d rather it didn’t.`,
  facts: ({ about }) => [
    `Spent on Ares's model this month: ${money(about.spentUsd)}`,
    `The User's monthly cap: ${money(about.capUsd)}`,
    `Share of the cap used: ${share(about)}`,
    `At the cap, Ares's deeper work (like writing Updates in his own words) waits until ${monthAfter(about.month)}.`,
    'What to do: nothing, unless the User wants to raise the cap in Settings.',
  ],
  row: () => null,
  guidance: `This month's model spend: say how much, against which cap, what happens at the cap and until when, and that there's nothing to do unless the User wants to raise it.
Good: "I’ve used $8.12 of your $10.00 cap this month. At the cap, my deeper work waits until 1 November."
Bad: "You’re approaching your usage limit." (How close? What happens then?)`,
};

const PARTS: [keyof MeetingPrepDetail, string][] = [
  ['about', 'what it’s about'],
  ['lastTime', 'what was said last time'],
  ['open', 'what’s open with the people in it'],
  ['raise', 'what’s worth raising'],
];
const GENERIC = ['what it’s about', 'what was said last time', 'what’s worth raising'];

function listedParts(parts: readonly string[]) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}

export const prepLines: LineKind<'meeting-prep'> = {
  name: 'a meeting’s prep that’s ready',
  template({ about }, context) {
    const prep = context.item(about.prepId);
    const detail = prep?.detail?.kind === 'meeting-prep' ? prep.detail : null;
    const parts = detail
      ? PARTS.filter(([key]) => {
          const value = detail[key];
          return Array.isArray(value) ? value.length > 0 : !!value;
        }).map(([, words]) => words)
      : GENERIC;
    return `Prep for “${oneLine(about.title)}” at ${clock(about.startsAt)} ${dayWord(about.startsAt, context.now)} is ready${parts.length ? `: ${listedParts(parts)}` : ''}. Have a look before it starts.`;
  },
  facts: ({ about }, context) => [
    `Starts: ${clock(about.startsAt)} ${dayWord(about.startsAt, context.now)}`,
    'What it is: Ares’s short homework for the meeting (what it’s about, what was said last time, what’s open with the people in it, what’s worth raising), shown under its Meeting chip.',
    'What to do: read it before the meeting. The line goes once the meeting ends.',
  ],
  row: ({ about }, itemId, context) =>
    itemId === about.eventId
      ? { state: `${clock(about.startsAt)} ${dayWord(about.startsAt, context.now)}`, actions: ['open'] }
      : null,
  guidance: `A meeting's prep that's ready: name the meeting and when it starts, say the prep is ready, and to have a look before it starts.
Good: "Prep for “1:1 with Priya” at 15:00 today is ready. Have a look before you go in."
Bad: "Your briefing is available." (For which meeting? When?)`,
};

export const summaryLines: LineKind<'github-summary'> = {
  name: 'Ares’s GitHub summary',
  template({ about, itemIds }, context) {
    const summary = context.item(itemIds[0] ?? about.summaryId);
    if (!isGitHubSummary(summary)) return `${about.label}: ${about.lead}`;
    const [fire, ...more] = summary.detail.onFire;
    if (fire) {
      const rest = more.length ? `, and ${plural(more.length, 'more thing', 'more things')}` : '';
      return `${about.label}: something is on fire. ${oneLine(fire).replace(/[.]$/, '')}${rest}. Open it to see what broke.`;
    }
    const { shipped, started, stuck } = summary.detail.counts;
    const counts = [
      ...(shipped ? [`${shipped} shipped`] : []),
      ...(started ? [`${started} started`] : []),
      ...(stuck ? [`${stuck} stuck`] : []),
    ];
    const what = counts.length ? listedParts(counts) : 'a quiet stretch, nothing shipped';
    return `${about.label}: ${what}, and nothing on fire. Nothing needs you; open it when you want the detail.`;
  },
  facts: ({ about }) => [`Covers: ${about.label}`],
  row: ({ about }, itemId) =>
    itemId === about.summaryId
      ? { state: about.onFire ? 'Something on fire' : 'Nothing on fire', actions: ['open'] }
      : null,
  // What's on fire, and "nothing on fire", are Commander's to say (ADR 0004): kept in its own words.
  apart: true,
  guidance: '',
};
