import { describe, expect, it } from 'vitest';
import { blockLinksIn, blockLinkToken, labelBlockLinks, meetingChipEventId } from './block-links';

const LT = '0b6c5f7e-2f9a-4b8e-9d1c-3a4b5c6d7e8f';
const SYNC = '5e1d1a2b-7c3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('[[ link tokens in a Block’s text', () => {
  it('writes a day as its date and a Project by its id', () => {
    expect(blockLinkToken({ type: 'day', day: '2026-10-03' })).toBe('[[2026-10-03]]');
    expect(blockLinkToken({ type: 'project', projectId: LT })).toBe(`[[project:${LT}]]`);
  });

  it('finds every token with where it sits, in order', () => {
    const text = `Call with Dana [[2026-10-01]] about [[project:${LT}]].`;
    expect(blockLinksIn(text)).toEqual([
      { target: { type: 'day', day: '2026-10-01' }, start: 15, end: 29 },
      { target: { type: 'project', projectId: LT }, start: 36, end: 36 + 12 + LT.length },
    ]);
  });

  it('leaves alone what is not a token: other brackets, impossible dates, an open [[', () => {
    expect(blockLinksIn('[[Q4 planning]] [[2026-02-30]] [[2026-10-0 [[ [x] **bold**')).toEqual([]);
  });

  it('survives Markdown around it', () => {
    expect(blockLinksIn('**see [[2026-10-01]]** and `code`')).toEqual([
      { target: { type: 'day', day: '2026-10-01' }, start: 6, end: 20 },
    ]);
  });

  it('labels each token for plain text (the Markdown copy, titles)', () => {
    const text = `Ask about [[project:${LT}]] on [[2026-10-05]]`;
    const label = (target: Parameters<Parameters<typeof labelBlockLinks>[1]>[0]) =>
      target.type === 'day' ? `[[${target.day}]]` : '[[Longtail]]';
    expect(labelBlockLinks(text, label)).toBe('Ask about [[Longtail]] on [[2026-10-05]]');
  });

  it('writes a calendar event by its Item id, and finds it among the others', () => {
    expect(blockLinkToken({ type: 'event', eventId: SYNC })).toBe(`[[event:${SYNC}]]`);
    expect(blockLinksIn(`Prep for [[event:${SYNC}]] on [[2026-10-03]]`)).toEqual([
      { target: { type: 'event', eventId: SYNC }, start: 9, end: 9 + 10 + SYNC.length },
      {
        target: { type: 'day', day: '2026-10-03' },
        start: 9 + 10 + SYNC.length + 4,
        end: 9 + 10 + SYNC.length + 18,
      },
    ]);
  });
});

describe('meeting chips', () => {
  it('a Block that starts with an event link is about that meeting', () => {
    expect(meetingChipEventId(`[[event:${SYNC}]]`)).toBe(SYNC);
    expect(meetingChipEventId(`  [[event:${SYNC}]] agenda`)).toBe(SYNC);
    expect(meetingChipEventId(`Prep for [[event:${SYNC}]]`)).toBeNull();
    expect(meetingChipEventId(`[[project:${LT}]]`)).toBeNull();
    expect(meetingChipEventId('')).toBeNull();
  });
});
