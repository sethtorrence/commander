import { z } from 'zod';
import { blockStyle } from './items';

// The daily template: the Blocks each new day's Daily Note starts with, edited in Settings → Notes.
// A setting, not Items: its Blocks are copied into a new day as fresh Items with their own ids, never
// linked back, so editing the template only changes days made afterwards.

export const templateBlock = z.object({
  // The Block's id within the template only; a day's copy gets a new id.
  id: z.string().min(1),
  // The template Block it nests under, or null at the top.
  parentId: z.string().min(1).nullable(),
  // A fractional index among its siblings, as a Block's position is.
  position: z.string().min(1),
  text: z.string(),
  folded: z.boolean(),
  // How its line looks, as a Block's style (#239); a plain line when absent.
  style: blockStyle.optional(),
});
export type TemplateBlock = z.infer<typeof templateBlock>;

export const dailyTemplate = z.object({
  blocks: z
    .array(templateBlock)
    .max(500)
    .refine((blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length, {
      error: 'Each Block of the daily template needs its own id',
    }),
});
export type DailyTemplate = z.infer<typeof dailyTemplate>;

// Until the User edits it: the five sections of the day, as top-level subheadings (`##`, #239).
export const defaultDailyTemplate: DailyTemplate = {
  blocks: ['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening'].map((text, i) => ({
    id: `default-${text.toLowerCase()}`,
    parentId: null,
    position: `a${i}`,
    text,
    folded: false,
    style: 'heading-2',
  })),
};
