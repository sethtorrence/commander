import { type ZodType, z } from 'zod';

// Skills: the named abilities Ares can use, on request or when he judges they are wanted (Update,
// Find, Summarise, Draft, Schedule). Each has a name, a description (what a Conversation's model
// reads to decide whether the User is asking for it), what it needs (its input, with the words that
// describe it to the model, #192) and a way to run. The Core registers them; `U`, the header button,
// the tray, the palette and Conversations all run them through the registry, and the "What Ares can
// do" page lists them from it, so a Skill added later appears there by itself.

// What a Skill needs: the shape its input must have (checked before it runs) and, for the model, the
// words saying what to give it.
export type SkillInput<Input> = { schema: ZodType<Input>; describe: string };

export type Skill<Input = void, Output = unknown> = {
  name: string;
  description: string;
  // How the "What Ares can do" page names it ("Find"); its name with a capital when absent.
  title?: string;
  // One plain line for the User on that page; the description when absent.
  summary?: string;
  // How the User might ask for it ("What did I miss?").
  example?: string;
  // What it needs. A Skill without one takes no input (the Update) or checks its own.
  input?: SkillInput<Input>;
  run(input: Input): Promise<Output>;
};

export const skillInfo = z.object({
  name: z.string().min(1),
  description: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  example: z.string().optional(),
  // What it needs, in the words the model reads; absent when it needs nothing.
  needs: z.string().optional(),
});
export type SkillInfo = z.infer<typeof skillInfo>;

/** How the User sees a Skill named: its title, or its name with a capital. */
export const skillTitle = (skill: Pick<SkillInfo, 'name' | 'title'>) =>
  skill.title ?? skill.name.charAt(0).toUpperCase() + skill.name.slice(1);

/** The input given to a Skill didn't fit what it needs: nothing ran. */
export class SkillInputError extends Error {
  override name = 'SkillInputError';
}

export type SkillRegistry = {
  register<Input, Output>(skill: Skill<Input, Output>): void;
  list(): SkillInfo[];
  has(name: string): boolean;
  // Runs a Skill by name. Its input is checked against what it needs first, when it says.
  run(name: string, input: unknown): Promise<unknown>;
};

function infoOf({
  name,
  description,
  title,
  summary,
  example,
  input,
}: Omit<Skill<unknown, unknown>, 'run' | 'input'> & { input?: { describe: string } }): SkillInfo {
  return {
    name,
    description,
    ...(title !== undefined && { title }),
    ...(summary !== undefined && { summary }),
    ...(example !== undefined && { example }),
    ...(input && { needs: input.describe }),
  };
}

export function createSkillRegistry(): SkillRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: each Skill has its own input and output
  const skills = new Map<string, Skill<any, unknown>>();
  return {
    register(skill) {
      if (skills.has(skill.name)) throw new Error(`There is already a Skill called “${skill.name}”`);
      skills.set(skill.name, skill);
    },
    list: () => [...skills.values()].map(infoOf),
    has: (name) => skills.has(name),
    async run(name, input) {
      const skill = skills.get(name);
      if (!skill) throw new Error(`Ares has no Skill called “${name}”`);
      if (!skill.input) return skill.run(input);
      const checked = skill.input.schema.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
        throw new SkillInputError(
          `${skillTitle(skill)} needs ${skill.input.describe} (${where}${issue?.message ?? 'not that'})`,
        );
      }
      return skill.run(checked.data);
    },
  };
}

// The Update: everything Ares has queued since the User last asked.
export const UPDATE_SKILL: SkillInfo = {
  name: 'update',
  title: 'Update',
  description:
    'Give the User their Update: everything Ares has queued for them since they last asked, grouped by what needs them. Use it when they ask for an update, or say anything that amounts to one ("anything I should know?", "what did I miss?", "catch me up").',
  summary: 'Everything he has queued for you since you last asked, with what to do about each.',
  example: 'Anything I should know?',
};

// What Find can narrow to, in the User's words, and the kinds of Item each means.
export const findKinds = ['email', 'event', 'todo', 'note', 'linear', 'github', 'chat'] as const;
export type FindKind = (typeof findKinds)[number];

// When, around today (the User's local calendar; weeks start on Monday).
export const findWhens = [
  'today',
  'tomorrow',
  'yesterday',
  'this-week',
  'last-week',
  'next-week',
  'this-month',
] as const;
export type FindWhen = (typeof findWhens)[number];

/** What Find is given: words to look for, and who, which Project, what kind and when to narrow to. */
export const findInput = z
  .object({
    query: z.string().trim().max(300).optional(),
    person: z.string().trim().max(120).optional(),
    project: z.string().trim().max(120).optional(),
    kinds: z.array(z.enum(findKinds)).max(findKinds.length).optional(),
    when: z.enum(findWhens).optional(),
  })
  .refine((input) => !!(input.query || input.person || input.project || input.when || input.kinds?.length), {
    message: 'say what to look for',
  });
export type FindInput = z.infer<typeof findInput>;

export const FIND_NEEDS = `{"query": the words to look for (optional), "person": a person’s name (optional), "project": a Project’s name or code (optional), "kinds": any of ${findKinds.map((kind) => `"${kind}"`).join(', ')} (optional), "when": one of ${findWhens.map((when) => `"${when}"`).join(', ')} (optional)}, with at least one of them`;

// Find (#192): looks things up across the User's own data.
export const FIND_SKILL: SkillInfo = {
  name: 'find',
  title: 'Find',
  description:
    'Look things up in what Commander holds for the User: email, calendar events, Todos, Daily Notes, Linear issues, GitHub pull requests and issues, Teams Chats and posts, the People they work with, what Ares has learned about them, and the Updates he gave them before. Searches by words and by meaning, can narrow by person, Project, kind and time, and reads what it finds. Use it for any question about the User’s own world ("find the email about the Acme redlines", "what did Priya ship this week?", "what’s on today?").',
  summary:
    'Looks things up across your email, calendar, notes, Todos, issues, Chats, People and past Updates.',
  example: 'Find the email about the Acme redlines',
};
