import { type ConversationSkill, skillTitle } from '@commander/domain';
import { useEffect, useState } from 'react';
import { SettingsGroup } from '../../settings/parts';
import type { ConversationsClient } from './conversations';

/*
  What Ares can do (#192, decision #24): every Skill he has, from the Skill registry in the Core, so a
  Skill added later shows here by itself. Each with a plain line saying what it does and how to ask
  for it in a Conversation; one a Conversation can't use yet says where it is used instead.
*/

const pad = (n: number) => String(n).padStart(2, '0');
const metaClass = 'font-mono text-label leading-none font-medium uppercase tracking-label text-muted';

export function WhatAresCanDo({
  client,
  shown,
  no = 'A5',
}: {
  client: ConversationsClient;
  shown: boolean;
  no?: string;
}) {
  const [skills, setSkills] = useState<ConversationSkill[] | null>(null);

  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'skills' }).then(
      (list) => current && setSkills(list),
      () => current && setSkills([]),
    );
    return () => {
      current = false;
    };
  }, [client, shown]);

  return (
    <SettingsGroup
      no={no}
      title="What Ares can do"
      note={skills ? `${pad(skills.length)} Skills` : undefined}
      data-testid="what-ares-can-do"
    >
      {skills === null ? (
        <p className="m-0 py-3 pr-5 pl-13 text-note text-muted">Loading…</p>
      ) : !skills.length ? (
        <p className="m-0 py-3 pr-5 pl-13 text-note text-muted">Ares has no Skills yet.</p>
      ) : (
        <ul className="m-0 list-none p-0" aria-label="Ares’s Skills">
          {skills.map((skill) => (
            <li
              key={skill.name}
              aria-label={skillTitle(skill)}
              data-testid="ares-skill"
              className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 border-b border-line2 py-2.5 pr-5 pl-13"
            >
              <span className="text-row font-semibold text-ink">{skillTitle(skill)}</span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-note text-text">{skill.summary ?? skill.description}</span>
                {skill.inConversations ? (
                  skill.example && (
                    <span className="text-note text-muted" data-testid="ares-skill-example">
                      Ask: “{skill.example}”
                    </span>
                  )
                ) : (
                  <span className={metaClass}>Not in Conversations yet: used where it lives</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
