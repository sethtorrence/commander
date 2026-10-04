import type { Item, Project } from '@commander/domain';
import { Badge, toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { addDays, dayKey, dayStart, isEvent } from './agenda';
import { localTimeZone, ScheduleCard, scheduleDays } from './ScheduleCard';

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = 7;

// "Today", "Tomorrow", "Mon 5 Oct"
function dayName(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return `${SHORT_DAYS[date.getUTCDay()]} ${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/**
 * A Project page's schedule (#128): the Project's events for the next 7 days, by day, each opening
 * in the Calendar Section. Read again when the page comes back into view.
 */
export function ProjectSchedule({
  project,
  itemStore,
  active,
  onOpenSection,
  now = Date.now,
}: {
  project: Project;
  itemStore: ItemStoreClient;
  active: boolean;
  onOpenSection: (sectionId: string) => void;
  now?: () => number;
}) {
  const timeZone = localTimeZone();
  const today = dayKey(now(), timeZone);
  const [events, setEvents] = useState<Item[]>([]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const from = dayStart(today, timeZone);
    const to = dayStart(addDays(today, DAYS), timeZone);
    itemStore({ op: 'events', query: { from, to, limit: 5000 } }).then(
      (found) =>
        current &&
        setEvents(found.filter((event) => isEvent(event) && event.filing?.projectId === project.id)),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [itemStore, project.id, active, today, timeZone]);
  return (
    <ScheduleCard
      label={`${project.name}: schedule`}
      title={
        <>
          <Badge size="sm" code={project.code} accent={project.accent} project={project.name} />
          Schedule · next 7 days
        </>
      }
      days={scheduleDays(events, { today, days: DAYS, timeZone }).filter(
        (day, index) => index < 2 || day.entries.length,
      )}
      dayName={(day) => dayName(day.day, today)}
      empty="No meetings."
      onOpenSection={onOpenSection}
    />
  );
}
