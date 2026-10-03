// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignalColourPicker } from '../components/signal-colour-picker';
import { ThemeToggle } from '../components/theme-toggle';
import { loadAppearance, STORAGE_KEYS } from './appearance';
import { AppearanceProvider, useAppearance } from './appearance-provider';

function signalStyle() {
  return document.getElementById('commander-signal')?.textContent ?? '';
}

let api: ReturnType<typeof useAppearance>;
function Probe() {
  api = useAppearance();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.getElementById('commander-signal')?.remove();
});
afterEach(cleanup);

describe('loadAppearance', () => {
  it('defaults to the dark theme and international orange', () => {
    expect(loadAppearance(localStorage)).toEqual({ theme: 'dark', signal: '#FF5F00' });
  });

  it('ignores stored values it cannot use', () => {
    localStorage.setItem(STORAGE_KEYS.theme, 'sepia');
    localStorage.setItem(STORAGE_KEYS.signal, 'orange');
    expect(loadAppearance(localStorage)).toEqual({ theme: 'dark', signal: '#FF5F00' });
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem() {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(loadAppearance(broken)).toEqual({ theme: 'dark', signal: '#FF5F00' });
  });
});

describe('AppearanceProvider', () => {
  it('applies the default theme and signal colour to the document', () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(signalStyle()).toContain('[data-theme=light]{--signal:#E65600;');
  });

  it('persists the theme so the next start uses it', () => {
    const first = render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => api.setTheme('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    first.unmount();

    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    expect(api.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('recolours live and remembers a new signal colour', () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => api.setSignal('#00e676'));
    expect(api.signal.hex).toBe('#00E676');
    expect(signalStyle()).toContain('[data-theme=light]{--signal:#00984E;');
    expect(localStorage.getItem(STORAGE_KEYS.signal)).toBe('#00E676');
  });

  it('ignores a signal colour it cannot read', () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => api.setSignal('not a colour'));
    expect(api.signal.hex).toBe('#FF5F00');
  });

  it('goes back to orange on reset', () => {
    localStorage.setItem(STORAGE_KEYS.signal, '#2F6BFF');
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => api.resetSignal());
    expect(api.signal.hex).toBe('#FF5F00');
  });
});

describe('ThemeToggle', () => {
  it('switches between dark and light', () => {
    render(
      <AppearanceProvider>
        <ThemeToggle />
      </AppearanceProvider>,
    );
    const toggle = screen.getByRole('button', { name: /switch to light/i });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: /switch to dark/i })).toBeTruthy();
  });
});

describe('SignalColourPicker', () => {
  it('recolours from a preset swatch', () => {
    render(
      <AppearanceProvider>
        <SignalColourPicker />
      </AppearanceProvider>,
    );
    fireEvent.click(screen.getByRole('radio', { name: /phosphor green/i }));
    expect(signalStyle()).toContain('--signal:#00E676;');
  });

  it('recolours from a typed hex value', () => {
    render(
      <AppearanceProvider>
        <SignalColourPicker />
      </AppearanceProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: /hex/i }), { target: { value: '#2F6BFF' } });
    expect(signalStyle()).toContain('--signal:#2F6BFF;');
  });

  it('shows the contrast each theme reaches', () => {
    render(
      <AppearanceProvider>
        <SignalColourPicker />
      </AppearanceProvider>,
    );
    const light = screen.getByRole('group', { name: /light theme/i });
    expect(light.textContent).toContain('#E65600');
    expect(light.textContent).toContain('3.0:1');
    expect(light.textContent).toContain('#B24200');
  });
});
