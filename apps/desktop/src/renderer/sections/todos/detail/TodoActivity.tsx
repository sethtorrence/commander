import type { ActivityEntry } from '@commander/domain';
import { useProjects } from '../../../projects/context';
import { describeEntry } from '../todos';
import { whenShort } from '../when';
import { PanePart } from './parts';

/** The Todo's activity log in plain words, newest first: who changed it, and when. */
export function TodoActivity({ entries }: { entries: ActivityEntry[] }) {
  // Archived Projects too, so an old filing still names its Project.
  const { projects, archived } = useProjects();
  const named = [...projects, ...archived];
  return (
    <PanePart label="Activity" count={entries.length}>
      <ol className="m-0 list-none border border-line p-0">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] text-note leading-[18px] last:border-b-0"
          >
            <span className="text-text">{describeEntry(entry, entries, named)}</span>
            <time
              dateTime={new Date(entry.at).toISOString()}
              className="font-mono text-label-lg leading-[18px] whitespace-nowrap text-muted tabular-nums"
            >
              {whenShort(entry.at)}
            </time>
          </li>
        ))}
      </ol>
    </PanePart>
  );
}
