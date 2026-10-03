import { ares } from './ares';
import { calendar } from './calendar';
import { dashboard } from './dashboard';
import { email } from './email';
import { github } from './github';
import { linear } from './linear';
import { notes } from './notes';
import type { SectionDefinition } from './section';
import { todos } from './todos';

/**
 * The notebook tabs, in order. A Section's place here is its tab number and its number key (1–9).
 * To add a Section (Teams follows in its milestone): make sections/<id>/index.tsx exporting a
 * SectionDefinition, and add it here.
 */
export const SECTIONS: readonly SectionDefinition[] = [
  dashboard,
  notes,
  todos,
  linear,
  email,
  calendar,
  github,
  ares,
];

export type { SectionDefinition } from './section';
