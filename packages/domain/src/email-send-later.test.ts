import { describe, expect, it } from 'vitest';
import {
  heldByFor,
  localDateTime,
  missedSendText,
  PERSONAL_MICROSOFT_TENANT,
  recipientsWord,
  scheduledLine,
  sendLaterChoices,
  sendLaterProblem,
  sendLaterTime,
} from './email-send-later';

// Send later's words and times (#139). Every time is local, built with local dates, so these read the
// same in any time zone (the suite runs under TZ=UTC, America/Denver and Etc/GMT-12) and at any hour,
// just after midnight included.

const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const sam = { name: 'Sam Rivera', address: 'sam@contoso.test' };
const bare = { name: null, address: 'ops@acme.test' };

describe('who holds a scheduled message', () => {
  it('Microsoft for an Outlook work Account, Commander for Gmail and personal Outlook.com', () => {
    expect(heldByFor('outlook:3f6a1c2e-0000-4000-8000-00000000c0de:u-sam')).toBe('microsoft');
    expect(heldByFor(`outlook:${PERSONAL_MICROSOFT_TENANT}:u-sam`)).toBe('commander');
    expect(heldByFor('google:sam@gmail.test')).toBe('commander');
    expect(heldByFor('outlook')).toBe('commander');
  });
});

describe('the Send later menu', () => {
  it('offers Later today, Tomorrow morning and Monday morning on a weekday morning', () => {
    // Tuesday 6 October, 10:00.
    expect(sendLaterChoices(local(6, 10))).toEqual([
      { label: 'Later today', at: local(6, 18) },
      { label: 'Tomorrow morning', at: local(7, 8) },
      { label: 'Monday morning', at: local(12, 8) },
    ]);
  });

  it('just after midnight, “later today” and “tomorrow” are the new day’s', () => {
    // Wednesday 7 October, 00:05.
    expect(sendLaterChoices(local(7, 0, 5))).toEqual([
      { label: 'Later today', at: local(7, 18) },
      { label: 'Tomorrow morning', at: local(8, 8) },
      { label: 'Monday morning', at: local(12, 8) },
    ]);
  });

  it('leaves out Later today from 17:00, and on a Monday offers next Monday', () => {
    // Monday 5 October, 17:30.
    expect(sendLaterChoices(local(5, 17, 30))).toEqual([
      { label: 'Tomorrow morning', at: local(6, 8) },
      { label: 'Monday morning', at: local(12, 8) },
    ]);
  });

  it('leaves out Monday morning on a Sunday, when it is tomorrow morning', () => {
    // Sunday 11 October, 09:00.
    expect(sendLaterChoices(local(11, 9)).map((choice) => choice.label)).toEqual([
      'Later today',
      'Tomorrow morning',
    ]);
  });

  it('takes a time later than now and within a year', () => {
    const now = local(6, 10);
    expect(sendLaterProblem(now + 60_000, now)).toBeNull();
    expect(sendLaterProblem(now, now)).toBe('Pick a time later than now.');
    expect(sendLaterProblem(Number.NaN, now)).toBe('Pick a time later than now.');
    expect(sendLaterProblem(now + 400 * 86_400_000, now)).toBe('Pick a time within the next year.');
  });

  it('fills the date and time field in local time', () => {
    expect(localDateTime(local(7, 8, 5))).toBe('2026-10-07T08:05');
  });
});

describe('how a time reads', () => {
  const now = local(6, 23, 30);

  it('today, tomorrow, yesterday, or the day and date', () => {
    expect(sendLaterTime(local(6, 23, 45), now)).toBe('today 23:45');
    expect(sendLaterTime(local(7, 0, 15), now)).toBe('tomorrow 00:15');
    expect(sendLaterTime(local(5, 9), now)).toBe('yesterday 09:00');
    expect(sendLaterTime(local(12, 8), now)).toBe('Mon 12 Oct 08:00');
    expect(sendLaterTime(new Date(2027, 0, 4, 8).getTime(), now)).toBe('Mon 4 Jan 2027 08:00');
  });

  it('how a scheduled message stands', () => {
    expect(scheduledLine({ state: 'waiting', sendAt: local(7, 8), error: null }, now)).toBe(
      'Sends from Commander',
    );
    expect(scheduledLine({ state: 'held', sendAt: local(7, 8), error: null }, now)).toBe('Held by Microsoft');
    expect(scheduledLine({ state: 'missed', sendAt: local(6, 9), error: null }, now)).toBe(
      'Missed: it was due today 09:00, while Commander wasn’t running',
    );
    expect(scheduledLine({ state: 'failed', sendAt: local(7, 8), error: 'No such recipient.' }, now)).toBe(
      'Microsoft didn’t take it: No such recipient.',
    );
  });
});

describe('the missed send’s question', () => {
  it('names who it was to and when it was due, as the Update asks it', () => {
    const now = local(6, 11);
    expect(missedSendText({ to: [dana], subject: 'Venue options', dueAt: local(6, 9) }, now)).toBe(
      'Your email to Dana (“Venue options”) was due at 09:00. Send it now?',
    );
    expect(missedSendText({ to: [dana, sam], subject: '', dueAt: local(5, 9) }, now)).toBe(
      'Your email to Dana and Sam was due yesterday at 09:00. Send it now?',
    );
  });

  it('just after midnight, a time due late last night was yesterday’s', () => {
    expect(missedSendText({ to: [bare], subject: 'Report', dueAt: local(6, 23, 50) }, local(7, 0, 5))).toBe(
      'Your email to ops@acme.test (“Report”) was due yesterday at 23:50. Send it now?',
    );
  });

  it('a few recipients by first name, more counted', () => {
    expect(recipientsWord([dana])).toBe('Dana');
    expect(recipientsWord([dana, sam, bare])).toBe('Dana and 2 others');
    expect(recipientsWord([])).toBe('no one');
  });
});
