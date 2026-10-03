// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShortcutRegistry } from './registry';

// Presses a key the way the browser reports it, on the focused element (or the body).
function press(
  registry: ReturnType<typeof createShortcutRegistry>,
  key: string,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return { handled: registry.handle(event), event };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the shortcut registry', () => {
  it('runs a registered key when it is pressed', () => {
    const registry = createShortcutRegistry();
    const run = vi.fn();
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run });

    const { handled, event } = press(registry, '3');

    expect(run).toHaveBeenCalledOnce();
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  // `data-focus` marks where the caret is (jsdom only focuses contenteditable with a tabindex).
  it.each([
    ['a text input', '<input data-focus type="text">'],
    ['a search input', '<input data-focus type="search">'],
    ['a textarea', '<textarea data-focus></textarea>'],
    ['a select', '<select data-focus><option>One</option></select>'],
    ['a contenteditable editor', '<div data-focus contenteditable="true" tabindex="0"></div>'],
    ['a custom textbox', '<div data-focus role="textbox" tabindex="0"></div>'],
    ['an element inside an editor', '<div contenteditable><p><b data-focus tabindex="0">x</b></p></div>'],
  ])('lets single keys through untouched while typing in %s', (_name, html) => {
    const registry = createShortcutRegistry();
    const run = vi.fn();
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run });
    registry.register({ keys: 'x', label: 'Tick a Todo', group: 'Todos', run });
    registry.register({ keys: '?', label: 'Keyboard shortcuts', group: 'General', run });
    document.body.innerHTML = html;
    (document.querySelector('[data-focus]') as HTMLElement).focus();

    for (const key of ['3', 'x', '?']) {
      const { handled, event } = press(registry, key);
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('matches modifiers exactly, letters in either case, and printable keys whatever Shift made them', () => {
    const registry = createShortcutRegistry();
    const palette = vi.fn();
    const tick = vi.fn();
    const cheatSheet = vi.fn();
    registry.register({ keys: 'Ctrl+K', label: 'Palette', group: 'General', run: palette });
    registry.register({ keys: 'x', label: 'Tick a Todo', group: 'Todos', run: tick });
    registry.register({ keys: '?', label: 'Keyboard shortcuts', group: 'General', run: cheatSheet });

    expect(press(registry, 'k').handled).toBe(false);
    expect(press(registry, 'k', { ctrlKey: true }).handled).toBe(true);
    expect(press(registry, 'K', { ctrlKey: true, shiftKey: true }).handled).toBe(false);
    expect(press(registry, 'x', { ctrlKey: true }).handled).toBe(false);
    expect(press(registry, 'x', { altKey: true }).handled).toBe(false);
    expect(press(registry, 'X').handled).toBe(true); // Caps Lock
    expect(press(registry, '?', { shiftKey: true }).handled).toBe(true);

    expect(palette).toHaveBeenCalledOnce();
    expect(tick).toHaveBeenCalledOnce();
    expect(cheatSheet).toHaveBeenCalledOnce();
  });

  it('runs a chord or named key in a field only when it asks to', () => {
    const registry = createShortcutRegistry();
    const palette = vi.fn();
    const leave = vi.fn();
    const close = vi.fn();
    registry.register({ keys: 'Ctrl+K', label: 'Palette', group: 'General', inFields: true, run: palette });
    registry.register({
      keys: 'Escape',
      label: 'Leave the field',
      group: 'General',
      inFields: true,
      run: leave,
    });
    registry.register({ keys: 'Ctrl+W', label: 'Close', group: 'General', run: close });
    document.body.innerHTML = '<input>';
    (document.querySelector('input') as HTMLElement).focus();

    expect(press(registry, 'k', { ctrlKey: true }).handled).toBe(true);
    expect(press(registry, 'Escape').handled).toBe(true);
    expect(press(registry, 'w', { ctrlKey: true }).handled).toBe(false);
    expect([palette, leave, close].map((f) => f.mock.calls.length)).toEqual([1, 1, 0]);
  });

  it('refuses a single key that asks to run in fields, since that would swallow typing', () => {
    const registry = createShortcutRegistry();
    expect(() =>
      registry.register({ keys: 'x', label: 'Tick a Todo', group: 'Todos', inFields: true, run: () => {} }),
    ).toThrow(/typing/);
    expect(() =>
      registry.register({
        keys: 'Shift+X',
        label: 'Tick a Todo',
        group: 'Todos',
        inFields: true,
        run: () => {},
      }),
    ).toThrow(/typing/);
  });

  it("runs a Section's own keys only while that Section is active", () => {
    const registry = createShortcutRegistry();
    const tick = vi.fn();
    const archive = vi.fn();
    registry.register({ keys: 'x', label: 'Tick a Todo', group: 'Todos', scope: 'todos', run: tick });
    registry.register({ keys: 'x', label: 'Make a Todo', group: 'Email', scope: 'email', run: archive });

    expect(press(registry, 'x').handled).toBe(false);
    registry.setActiveScopes(['todos']);
    press(registry, 'x');
    registry.setActiveScopes(['email']);
    press(registry, 'x');

    expect(tick).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
  });

  it('lets an active scope take a key over from the app-wide one', () => {
    const registry = createShortcutRegistry();
    const appWide = vi.fn();
    const scoped = vi.fn();
    registry.register({ keys: 'Escape', label: 'Leave the field', group: 'General', run: appWide });
    registry.register({
      keys: 'Escape',
      label: 'Close Settings',
      group: 'Settings',
      scope: 'settings',
      run: scoped,
    });

    press(registry, 'Escape');
    registry.setActiveScopes(['settings']);
    press(registry, 'Escape');

    expect(appWide).toHaveBeenCalledOnce();
    expect(scoped).toHaveBeenCalledOnce();
  });

  it('refuses a key already taken in the same scope', () => {
    const registry = createShortcutRegistry();
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run: () => {} });
    registry.register({ keys: 'x', label: 'Tick a Todo', group: 'Todos', scope: 'todos', run: () => {} });

    expect(() => registry.register({ keys: '3', label: 'Other', group: 'Sections', run: () => {} })).toThrow(
      /already/,
    );
    expect(() =>
      registry.register({ keys: 'X', label: 'Other', group: 'Todos', scope: 'todos', run: () => {} }),
    ).toThrow(/already/);
  });

  it('frees a key when its shortcut is unregistered', () => {
    const registry = createShortcutRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const unregister = registry.register({ keys: '3', label: 'Todos', group: 'Sections', run: first });

    unregister();
    expect(press(registry, '3').handled).toBe(false);
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run: second });
    press(registry, '3');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('lists every shortcut registered, in order, marking those that work right now', () => {
    const registry = createShortcutRegistry();
    registry.register({ keys: '1', label: 'Dashboard', group: 'Sections', run: () => {} });
    registry.register({ keys: '?', label: 'Keyboard shortcuts', group: 'General', run: () => {} });
    registry.register({ keys: 'x', label: 'Tick a Todo', group: 'Todos', scope: 'todos', run: () => {} });
    registry.register({ keys: 'Ctrl+K', label: 'Palette', group: 'General', run: () => {} });
    registry.setActiveScopes(['email']);

    expect(registry.list()).toEqual([
      { keys: ['1'], label: 'Dashboard', group: 'Sections', scope: undefined, active: true },
      { keys: ['?'], label: 'Keyboard shortcuts', group: 'General', scope: undefined, active: true },
      { keys: ['X'], label: 'Tick a Todo', group: 'Todos', scope: 'todos', active: false },
      { keys: ['Ctrl', 'K'], label: 'Palette', group: 'General', scope: undefined, active: true },
    ]);
  });

  it('tells subscribers when the list changes, and keeps the same list until it does', () => {
    const registry = createShortcutRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    const before = registry.list();
    expect(registry.list()).toBe(before);
    const unregister = registry.register({ keys: '1', label: 'Dashboard', group: 'Sections', run: () => {} });
    registry.setActiveScopes(['todos']);
    unregister();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(registry.list()).not.toBe(before);

    unsubscribe();
    registry.register({ keys: '2', label: 'Notes', group: 'Sections', run: () => {} });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('skips a shortcut whose condition does not hold, leaving the key to others', () => {
    const registry = createShortcutRegistry();
    const run = vi.fn();
    let open = false;
    registry.register({ keys: 'Escape', label: 'Close', group: 'General', when: () => open, run });

    expect(press(registry, 'Escape').handled).toBe(false);
    open = true;
    expect(press(registry, 'Escape').handled).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps keys pressed inside a dialog to the dialog, unless a shortcut asks for them', () => {
    const registry = createShortcutRegistry();
    const section = vi.fn();
    const cheatSheet = vi.fn();
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run: section });
    registry.register({
      keys: '?',
      label: 'Keyboard shortcuts',
      group: 'General',
      inDialogs: true,
      run: cheatSheet,
    });
    document.body.innerHTML = '<div role="dialog"><button type="button">Close</button></div>';
    (document.querySelector('button') as HTMLElement).focus();

    expect(press(registry, '3').handled).toBe(false);
    expect(press(registry, '?').handled).toBe(true);
    expect(section).not.toHaveBeenCalled();
    expect(cheatSheet).toHaveBeenCalledOnce();
  });

  it('ignores keys pressed mid-composition and keys a component already handled', () => {
    const registry = createShortcutRegistry();
    const run = vi.fn();
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run });

    expect(press(registry, '3', { isComposing: true }).handled).toBe(false);
    const handledElsewhere = new KeyboardEvent('keydown', { key: '3', cancelable: true });
    handledElsewhere.preventDefault();
    expect(registry.handle(handledElsewhere)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('still runs keys from a checkbox or a button, which take no typing', () => {
    const registry = createShortcutRegistry();
    const run = vi.fn();
    registry.register({ keys: '3', label: 'Todos', group: 'Sections', run });
    document.body.innerHTML = '<input type="checkbox"><button type="button">Go</button>';

    (document.querySelector('input') as HTMLElement).focus();
    press(registry, '3');
    (document.querySelector('button') as HTMLElement).focus();
    press(registry, '3');

    expect(run).toHaveBeenCalledTimes(2);
  });
});
