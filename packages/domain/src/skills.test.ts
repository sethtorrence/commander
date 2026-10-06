import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSkillRegistry,
  FIND_SKILL,
  findInput,
  SkillInputError,
  skillTitle,
  UPDATE_SKILL,
} from './skills';
import { SUMMARISE_SKILL, summariseInput } from './teams-ares';

describe('the Skill registry', () => {
  it('runs a registered Skill by name and lists what each one is for', async () => {
    const skills = createSkillRegistry();
    skills.register({ ...UPDATE_SKILL, run: async () => 'Nothing new since you last asked.' });

    expect(skills.list()).toEqual([
      {
        name: 'update',
        title: 'Update',
        description: UPDATE_SKILL.description,
        summary: UPDATE_SKILL.summary,
        example: 'Anything I should know?',
      },
    ]);
    expect(skills.has('update')).toBe(true);
    expect(await skills.run('update', undefined)).toBe('Nothing new since you last asked.');
  });

  it('refuses a second Skill with the same name, and one it doesn’t know', async () => {
    const skills = createSkillRegistry();
    skills.register({ ...UPDATE_SKILL, run: async () => null });
    expect(() => skills.register({ ...UPDATE_SKILL, run: async () => null })).toThrow(/already/);
    await expect(skills.run('summarise', undefined)).rejects.toThrow(/no Skill called “summarise”/);
  });

  it('describes the Update so a Conversation can tell when the User is asking for one', () => {
    expect(UPDATE_SKILL.description).toMatch(/what did I miss/i);
  });
});

describe('Skills that take input (#192)', () => {
  const echo = {
    name: 'echo',
    description: 'Says it back.',
    input: { schema: z.object({ words: z.string().min(1) }), describe: '{"words": what to say}' },
    run: async ({ words }: { words: string }) => words,
  };

  it('hand a Skill the input it needs, checked first, and list what it needs', async () => {
    const skills = createSkillRegistry();
    skills.register(echo);
    expect(await skills.run('echo', { words: 'hello' })).toBe('hello');
    expect(skills.list()).toEqual([
      { name: 'echo', description: 'Says it back.', needs: '{"words": what to say}' },
    ]);
  });

  it('refuse input that doesn’t fit, without running the Skill', async () => {
    const skills = createSkillRegistry();
    let ran = false;
    skills.register({
      ...echo,
      run: async () => {
        ran = true;
        return '';
      },
    });
    await expect(skills.run('echo', { words: '' })).rejects.toThrow(SkillInputError);
    await expect(skills.run('echo', undefined)).rejects.toThrow(/Echo needs \{"words": what to say\}/);
    expect(ran).toBe(false);
  });

  it('still run a Skill that needs nothing, or checks its own, with whatever its callers give it', async () => {
    const skills = createSkillRegistry();
    const given: unknown[] = [];
    skills.register({
      name: 'draft',
      description: 'Drafts.',
      run: async (input: unknown) => given.push(input),
    });
    await skills.run('draft', { itemId: 'chat-1' });
    await skills.run('draft', { itemId: 'email-1', instruction: 'say yes' });
    expect(given).toEqual([{ itemId: 'chat-1' }, { itemId: 'email-1', instruction: 'say yes' }]);
  });

  it('name a Skill by its title, or its name with a capital', () => {
    expect(skillTitle(FIND_SKILL)).toBe('Find');
    expect(skillTitle({ name: 'schedule' })).toBe('Schedule');
  });

  it('Find needs something to look for', () => {
    expect(findInput.safeParse({ query: 'acme redlines' }).success).toBe(true);
    expect(findInput.safeParse({ when: 'today' }).success).toBe(true);
    expect(findInput.safeParse({}).success).toBe(false);
    expect(findInput.safeParse({ when: 'someday' }).success).toBe(false);
  });

  it('Summarise takes a Chat and a range, as before, or the words naming what to sum up', () => {
    expect(summariseInput.safeParse({ itemId: 'chat-1', range: 'today' }).success).toBe(true);
    expect(summariseInput.safeParse({ target: 'Titanlink', range: 'sprint' }).success).toBe(true);
    expect(summariseInput.safeParse({ target: 'acme/api' }).success).toBe(true);
    expect(summariseInput.safeParse({ target: '' }).success).toBe(false);
    expect(SUMMARISE_SKILL.description).toMatch(/Project/);
  });
});
