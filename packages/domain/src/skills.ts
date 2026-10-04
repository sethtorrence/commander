// Skills: the named abilities Ares can use, on request or when he judges they are wanted (Update,
// Find, Summarise, Draft, Schedule). Each has a name, a description (what a Conversation's model
// reads to decide whether the User is asking for it) and a way to run. The Update is the first; the
// Core registers it, and `U`, the header button, the tray, the palette and, later, Conversations all
// run it through the registry.

export type Skill<Input = void, Output = unknown> = {
  name: string;
  description: string;
  run(input: Input): Promise<Output>;
};

export type SkillInfo = { name: string; description: string };

export type SkillRegistry = {
  register<Input, Output>(skill: Skill<Input, Output>): void;
  list(): SkillInfo[];
  run(name: string, input: unknown): Promise<unknown>;
};

export function createSkillRegistry(): SkillRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: each Skill has its own input and output
  const skills = new Map<string, Skill<any, unknown>>();
  return {
    register(skill) {
      if (skills.has(skill.name)) throw new Error(`There is already a Skill called “${skill.name}”`);
      skills.set(skill.name, skill);
    },
    list: () => [...skills.values()].map(({ name, description }) => ({ name, description })),
    async run(name, input) {
      const skill = skills.get(name);
      if (!skill) throw new Error(`Ares has no Skill called “${name}”`);
      return skill.run(input);
    },
  };
}

// The Update: everything Ares has queued since the User last asked.
export const UPDATE_SKILL: SkillInfo = {
  name: 'update',
  description:
    'Give the User their Update: everything Ares has queued for them since they last asked, grouped by what needs them. Use it when they ask for an update, or say anything that amounts to one ("anything I should know?", "what did I miss?", "catch me up").',
};
