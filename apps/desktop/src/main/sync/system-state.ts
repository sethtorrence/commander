// Whether the machine is awake and online, for the Core's sync engine: syncing pauses while asleep
// or offline and catches up once after. Sleep comes from Electron's powerMonitor; the main process
// has no online/offline event, so it checks `net.isOnline()` every few seconds.

type PowerEvents = {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  off(event: 'suspend' | 'resume', listener: () => void): unknown;
};

export type SystemState = { awake: boolean; online: boolean };

export function watchSystemState({
  powerMonitor,
  isOnline,
  onChange,
  pollMs = 10_000,
}: {
  powerMonitor: PowerEvents;
  isOnline: () => boolean;
  onChange: (state: SystemState) => void;
  pollMs?: number;
}): () => void {
  let state: SystemState = { awake: true, online: isOnline() };
  onChange(state);

  const update = (changes: Partial<SystemState>) => {
    const next = { ...state, ...changes };
    if (next.awake === state.awake && next.online === state.online) return;
    state = next;
    onChange(state);
  };
  const suspend = () => update({ awake: false });
  // The network may have changed while asleep: check it along with waking.
  const resume = () => update({ awake: true, online: isOnline() });
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  const poll = setInterval(() => update({ online: isOnline() }), pollMs);

  return () => {
    clearInterval(poll);
    powerMonitor.off('suspend', suspend);
    powerMonitor.off('resume', resume);
  };
}
