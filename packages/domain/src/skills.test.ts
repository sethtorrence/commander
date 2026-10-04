import { describe, expect, it } from 'vitest';
import { createSkillRegistry, UPDATE_SKILL } from './skills';

describe('the Skill registry', () => {
  it('runs a registered Skill by name and lists what each one is for', async () => {
    const skills = createSkillRegistry();
    skills.register({ ...UPDATE_SKILL, run: async () => 'Nothing new since you last asked.' });

    expect(skills.list()).toEqual([{ name: 'update', description: UPDATE_SKILL.description }]);
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
