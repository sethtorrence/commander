import { describe, expect, it } from 'vitest';
import { calendarOnByDefault, type EventDetail, eventDetail, eventRuleFields } from './calendar';
import type { Item } from './items';
import { describeRule, RULE_FIELDS, RULE_SOURCES, ruleCondition, ruleMatches } from './rules';

const detail: EventDetail = {
  kind: 'event',
  calendar: { id: 'c_standups@group.calendar.google.com', name: 'Titanlink Standups', colour: '#33b679' },
  accountEmail: 'alex@gmail.test',
  start: { at: Date.UTC(2026, 9, 5, 9), timeZone: 'Europe/London', date: null },
  end: { at: Date.UTC(2026, 9, 5, 9, 30), timeZone: 'Europe/London', date: null },
  allDay: false,
  location: null,
  description: null,
  organiser: { email: 'Dana@Titanlink.test', name: 'Dana Ruiz', self: false },
  attendees: [
    {
      email: 'alex@gmail.test',
      name: null,
      self: true,
      response: 'accepted',
      organiser: false,
      optional: false,
      resource: false,
    },
    {
      email: 'room-4@resource.calendar.google.com',
      name: 'Room 4',
      self: false,
      response: 'accepted',
      organiser: false,
      optional: false,
      resource: true,
    },
  ],
  myResponse: 'accepted',
  meetingUrl: null,
  busy: true,
  private: false,
  seriesId: 'standup',
  webUrl: null,
  createdByCommander: null,
};

const event: Pick<Item, 'kind' | 'source' | 'account' | 'title' | 'detail'> = {
  kind: 'event',
  source: 'google-calendar',
  account: 'google:104512345678901234567',
  title: 'TL standup',
  detail,
};

describe('calendar Rule fields', () => {
  const fields = new Map(eventRuleFields('google-calendar').map((field) => [field.id, field]));

  it('reads the calendar, organiser, attendees (people only), title and Account of an event', () => {
    expect(fields.get('google-calendar.calendar')?.read(event)).toEqual([
      { value: 'c_standups@group.calendar.google.com', label: 'Titanlink Standups' },
    ]);
    expect(fields.get('google-calendar.organiser')?.read(event)).toEqual([
      { value: 'dana@titanlink.test', label: 'Dana Ruiz' },
    ]);
    expect(fields.get('google-calendar.attendee')?.read(event)).toEqual([
      { value: 'alex@gmail.test', label: 'alex@gmail.test' },
    ]);
    expect(fields.get('google-calendar.title')?.read(event)).toEqual([
      { value: 'TL standup', label: 'TL standup' },
    ]);
    expect(fields.get('google-calendar.account')?.read(event)).toEqual([
      { value: 'google:104512345678901234567', label: 'alex@gmail.test' },
    ]);
  });

  it('reads the events of every calendar Source alike, and nothing from other Items', () => {
    const outlook = { ...event, source: 'outlook-calendar' as const, account: 'outlook:t:u' };
    const outlookFields = new Map(eventRuleFields('outlook-calendar').map((field) => [field.id, field]));
    for (const name of ['calendar', 'organiser', 'attendee', 'title', 'account']) {
      expect(outlookFields.get(`outlook-calendar.${name}`)?.read(outlook)).toEqual(
        fields.get(`google-calendar.${name}`)?.read(outlook),
      );
      expect(fields.get(`google-calendar.${name}`)?.read(outlook)).not.toEqual([]);
    }
    const issue = { ...event, kind: 'linear-issue' as const, source: 'linear' as const, detail: null };
    expect(fields.get('google-calendar.title')?.read(issue)).toEqual([]);
  });

  it('are registered for both calendar Sources, and one Rule files Google and Outlook events alike', () => {
    expect(RULE_FIELDS.has('outlook-calendar.organiser')).toBe(true);
    expect(RULE_FIELDS.has('google-calendar.organiser')).toBe(true);
    const when = {
      join: 'and' as const,
      terms: [
        ruleCondition.parse({
          field: 'google-calendar.organiser',
          op: 'is',
          value: 'dana@titanlink.test',
          label: 'Dana Ruiz',
        }),
      ],
    };
    const outlook = { ...event, source: 'outlook-calendar' as const, account: 'outlook:t:u' };
    expect(ruleMatches(when, event)).toBe(true);
    expect(ruleMatches(when, outlook)).toBe(true);
    // The editor offers the calendar fields once.
    expect(
      RULE_SOURCES.filter((each) => each.fields.some((field) => field.id.includes('calendar.'))),
    ).toEqual([expect.objectContaining({ name: 'Calendar' })]);
  });

  it('are registered for Rules: “calendar is Titanlink Standups” matches its events', () => {
    const condition = ruleCondition.parse({
      field: 'google-calendar.calendar',
      op: 'is',
      value: 'c_standups@group.calendar.google.com',
      label: 'Titanlink Standups',
    });
    const when = { join: 'and' as const, terms: [condition] };
    expect(ruleMatches(when, event)).toBe(true);
    expect(
      ruleMatches(when, { ...event, detail: { ...detail, calendar: { ...detail.calendar, id: 'x' } } }),
    ).toBe(false);
    expect(describeRule(when)).toBe('calendar is Titanlink Standups');
  });
});

describe('calendars on by default', () => {
  it('turns on the primary calendar and those the User owns, not subscribed ones', () => {
    expect(calendarOnByDefault({ primary: true, accessRole: 'owner' })).toBe(true);
    expect(calendarOnByDefault({ primary: false, accessRole: 'owner' })).toBe(true);
    expect(calendarOnByDefault({ primary: false, accessRole: 'reader' })).toBe(false);
    expect(calendarOnByDefault({ primary: false, accessRole: 'writer' })).toBe(false);
  });
});

describe('the event detail', () => {
  it('validates an all-day event, its end day exclusive', () => {
    const allDay = {
      ...detail,
      allDay: true,
      start: { at: Date.UTC(2026, 9, 12), timeZone: null, date: '2026-10-12' },
      end: { at: Date.UTC(2026, 9, 13), timeZone: null, date: '2026-10-13' },
    };
    expect(eventDetail.parse(allDay)).toEqual(allDay);
  });
});
