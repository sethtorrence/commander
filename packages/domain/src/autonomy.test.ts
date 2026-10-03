import { describe, expect, it } from 'vitest';
import { type AutonomySettings, DEFAULT_AUTONOMY, type DecisionInput, decide } from './autonomy';

const sure = 0.9;
const unsure = 0.5;

function proposal(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    actionKind: 'organise',
    action: 'suggest-todos',
    section: 'notes',
    confidence: sure,
    chained: false,
    ...overrides,
  };
}

function settings(overrides: Partial<AutonomySettings> = {}): AutonomySettings {
  return {
    everywhere: { ...DEFAULT_AUTONOMY.everywhere, ...overrides.everywhere },
    sections: overrides.sections ?? {},
    actions: overrides.actions ?? {},
  };
}

describe('decide, with the default Autonomy settings', () => {
  it('does Organise on its own when sure, and asks when not', () => {
    expect(decide(proposal({ confidence: sure }))).toBe('auto');
    expect(decide(proposal({ confidence: unsure }))).toBe('ask');
  });

  it('asks before Tidy your Sources and Act for you, however sure', () => {
    expect(decide(proposal({ actionKind: 'tidy-sources', confidence: 1 }))).toBe('ask');
    expect(decide(proposal({ actionKind: 'act-for-you', confidence: 1 }))).toBe('ask');
  });

  it('never deletes: Delete is Off', () => {
    expect(decide(proposal({ actionKind: 'delete', confidence: 1 }))).toBe('off');
  });
});

describe('decide, at each Autonomy level', () => {
  const at = (level: AutonomySettings['everywhere']['organise'], confidence = sure) =>
    decide(
      proposal({ confidence }),
      settings({ everywhere: { ...DEFAULT_AUTONOMY.everywhere, organise: level } }),
    );

  it('Off drops the proposal, however sure', () => {
    expect(at('off', 1)).toBe('off');
  });

  it('Ask always asks, however sure', () => {
    expect(at('ask', 1)).toBe('ask');
  });

  it('Auto when sure acts at the confidence bar (0.8) and above, and asks below it', () => {
    expect(at('auto-when-sure', 0.8)).toBe('auto');
    expect(at('auto-when-sure', 1)).toBe('auto');
    expect(at('auto-when-sure', 0.79)).toBe('ask');
    expect(at('auto-when-sure', 0)).toBe('ask');
  });

  it('Auto acts whatever the confidence', () => {
    expect(at('auto', 0)).toBe('auto');
  });
});

describe('decide, combining settings', () => {
  it('a Section override beats Everywhere, only in that Section', () => {
    const chosen = settings({ sections: { email: { 'tidy-sources': 'auto' } } });
    expect(decide(proposal({ actionKind: 'tidy-sources', section: 'email' }), chosen)).toBe('auto');
    expect(decide(proposal({ actionKind: 'tidy-sources', section: 'linear' }), chosen)).toBe('ask');
  });

  it('a Section override for one Action kind leaves the other kinds alone', () => {
    const chosen = settings({ sections: { notes: { 'tidy-sources': 'auto' } } });
    expect(decide(proposal({ section: 'notes', confidence: unsure }), chosen)).toBe('ask');
  });

  it('a Section override can lower the level as well as raise it', () => {
    const chosen = settings({ sections: { notes: { organise: 'off' } } });
    expect(decide(proposal({ section: 'notes' }), chosen)).toBe('off');
    expect(decide(proposal({ section: 'todos' }), chosen)).toBe('auto');
  });

  it('a per-action override beats both the Section override and Everywhere', () => {
    const chosen = settings({
      everywhere: { ...DEFAULT_AUTONOMY.everywhere, organise: 'auto' },
      sections: { notes: { organise: 'auto' } },
      actions: { 'suggest-todos': 'ask' },
    });
    expect(decide(proposal({ section: 'notes' }), chosen)).toBe('ask');
    expect(decide(proposal({ section: 'notes', action: 'file-into-projects' }), chosen)).toBe('auto');
  });

  it('a proposal in no one Section follows the per-action override, else Everywhere', () => {
    const chosen = settings({ sections: { notes: { organise: 'off' } } });
    expect(decide(proposal({ section: null }), chosen)).toBe('auto');
    expect(decide(proposal({ section: null }), { ...chosen, actions: { 'suggest-todos': 'off' } })).toBe(
      'off',
    );
  });
});

describe('decide, enforcing the hard limits whatever the settings say', () => {
  const everything = (level: 'auto' | 'auto-when-sure') =>
    settings({
      everywhere: { organise: level, 'tidy-sources': level, 'act-for-you': level, delete: level },
      sections: { email: { 'act-for-you': level, delete: level } },
      actions: { 'send-reply': level, 'delete-mail': level },
    });

  it('Act for you never goes above Ask, from Everywhere, a Section or a per-action override', () => {
    for (const level of ['auto', 'auto-when-sure'] as const) {
      const chosen = everything(level);
      expect(decide(proposal({ actionKind: 'act-for-you', section: 'linear', confidence: 1 }), chosen)).toBe(
        'ask',
      );
      expect(decide(proposal({ actionKind: 'act-for-you', section: 'email', confidence: 1 }), chosen)).toBe(
        'ask',
      );
      expect(
        decide(proposal({ actionKind: 'act-for-you', action: 'send-reply', confidence: 1 }), chosen),
      ).toBe('ask');
    }
  });

  it('Delete never goes above Ask either', () => {
    for (const level of ['auto', 'auto-when-sure'] as const) {
      const chosen = everything(level);
      expect(decide(proposal({ actionKind: 'delete', section: 'email', confidence: 1 }), chosen)).toBe('ask');
      expect(decide(proposal({ actionKind: 'delete', action: 'delete-mail', confidence: 1 }), chosen)).toBe(
        'ask',
      );
    }
  });

  it('a capped kind can still be turned Off', () => {
    const chosen = settings({ everywhere: { ...DEFAULT_AUTONOMY.everywhere, 'act-for-you': 'off' } });
    expect(decide(proposal({ actionKind: 'act-for-you' }), chosen)).toBe('off');
  });
});

describe('decide, for chained proposals', () => {
  const auto = settings({
    everywhere: { organise: 'auto', 'tidy-sources': 'auto', 'act-for-you': 'ask', delete: 'ask' },
  });

  it('always asks, even at Auto and fully sure', () => {
    expect(decide(proposal({ chained: true, confidence: 1 }), auto)).toBe('ask');
    expect(decide(proposal({ actionKind: 'tidy-sources', chained: true, confidence: 1 }), auto)).toBe('ask');
    expect(decide(proposal({ chained: true }), settings())).toBe('ask');
  });

  it('asks even when a Section or per-action override says Auto', () => {
    const overridden = settings({
      sections: { notes: { organise: 'auto' } },
      actions: { 'suggest-todos': 'auto' },
    });
    expect(decide(proposal({ chained: true, confidence: 1 }), overridden)).toBe('ask');
  });

  it('stays dropped when its kind is Off: a chain never switches on what the User turned off', () => {
    expect(decide(proposal({ actionKind: 'delete', chained: true }))).toBe('off');
    const off = settings({ everywhere: { ...DEFAULT_AUTONOMY.everywhere, organise: 'off' } });
    expect(decide(proposal({ chained: true }), off)).toBe('off');
  });
});
