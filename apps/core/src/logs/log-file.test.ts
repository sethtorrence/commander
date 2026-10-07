import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKnownSecrets } from '../safety/known-secrets';
import {
  blankLogText,
  createLog,
  LEFT_OUT,
  LOGS_FOLDER,
  logFiles,
  logLine,
  logsDir,
  readLogs,
} from './log-file';

// The fake tokens are written in two pieces so the source never holds a whole token-shaped string.
const GITHUB_TOKEN = 'gh' + 'p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const BEARER = 'Authorization: Bearer ' + 'ya29' + '.a0AfH6SMBx1234567890abcdefghijk';

const DAY = 24 * 60 * 60 * 1000;
const AT = Date.UTC(2026, 9, 6, 0, 0, 30);

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'commander-logs-')), LOGS_FOLDER);
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const names = () => readdirSync(dir).sort();

describe('the log folder', () => {
  it('is one folder in the data folder, named once for Wipe', () => {
    expect(logsDir('/data')).toBe(join('/data', 'logs'));
  });
});

describe('lines', () => {
  it('lead with the UTC time, then level, process and area', () => {
    expect(logLine(AT, 'core', 'warn', 'sync', 'gmail sync of google:1 failed')).toBe(
      '2026-10-06T00:00:30.000Z WARN  core sync     gmail sync of google:1 failed',
    );
  });

  it('blank tokens, keys and authorization headers before they are written', () => {
    const line = blankLogText(`sync failed with ${GITHUB_TOKEN}; ${BEARER}`);
    expect(line).not.toContain(GITHUB_TOKEN);
    expect(line).not.toContain('a0AfH6SMBx1234567890abcdefghijk');
    expect(line).toContain('[removed]');
  });

  it('leave out a line holding a token or key the Core was handed, whatever its shape', () => {
    const secrets = createKnownSecrets();
    secrets.remember('correct horse battery staple');
    expect(blankLogText('the key is correct horse battery staple, sent', secrets)).toBe(LEFT_OUT);
    expect(blankLogText('nothing secret here', secrets)).toBe('nothing secret here');
  });

  it('are one line, cut short when long', () => {
    expect(blankLogText('first\nsecond\r\n  third')).toBe('first ⏎ second ⏎ third');
    const long = blankLogText('word '.repeat(1000));
    expect(long.length).toBe(1000);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('createLog', () => {
  it('appends each process’s lines to its own file in the logs folder, blanked', () => {
    const core = createLog({ dir, process: 'core', now: () => AT });
    const main = createLog({ dir, process: 'main', now: () => AT + 1 });
    core.warn('sync', `failed: ${GITHUB_TOKEN}`);
    main.info('core', 'Started the Core');
    expect(names()).toEqual(['core.log', 'main.log']);
    expect(read('core.log')).toContain('failed: [removed]');
    expect(read('core.log')).not.toContain(GITHUB_TOKEN);
    expect(read('main.log')).toContain('Started the Core');
  });

  it('rotates a file past its size, keeping only the newest few', () => {
    const log = createLog({ dir, process: 'core', maxBytes: 200, keptFiles: 2, now: () => AT });
    for (let n = 1; n <= 12; n++) log.info('sync', `run ${String(n).padStart(2, '0')} ${'x'.repeat(40)}`);
    expect(names()).toEqual(['core.1.log', 'core.2.log', 'core.log']);
    for (const name of names()) expect(Buffer.byteLength(read(name))).toBeLessThanOrEqual(200);
    // The newest lines are in the live file, the ones before in .1, then .2; older ones are gone.
    expect(read('core.log')).toContain('run 12');
    expect(read('core.1.log')).toContain('run 10');
    expect(read('core.2.log')).toContain('run 08');
    expect(readLogs(dir).join('\n')).not.toContain('run 06');
    expect(logFiles(dir, 'core').map((path) => path.slice(dir.length + 1))).toEqual([
      'core.log',
      'core.1.log',
      'core.2.log',
    ]);
  });

  it('carries on from the size a file already has', () => {
    createLog({ dir, process: 'main', now: () => AT }).info('app', 'x'.repeat(150));
    createLog({ dir, process: 'main', maxBytes: 200, now: () => AT }).info('app', 'y'.repeat(150));
    expect(names()).toEqual(['main.1.log', 'main.log']);
  });

  it('deletes files untouched for a week when it opens', () => {
    const first = createLog({ dir, process: 'core', maxBytes: 100, now: () => AT });
    first.info('sync', 'a'.repeat(90));
    first.info('sync', 'b'.repeat(90));
    expect(names()).toEqual(['core.1.log', 'core.log']);
    const old = (AT - 8 * DAY) / 1000;
    utimesSync(join(dir, 'core.1.log'), old, old);
    createLog({ dir, process: 'core', now: () => AT });
    expect(names()).toEqual(['core.log']);
  });

  it('makes the folder again when it was deleted meanwhile, and never throws', () => {
    const log = createLog({ dir, process: 'main', now: () => AT });
    log.info('app', 'before');
    rmSync(dir, { recursive: true });
    expect(() => log.info('app', 'after')).not.toThrow();
    expect(read('main.log')).toContain('after');
  });

  it('captures console.warn and console.error, blanked, and puts them back', () => {
    const log = createLog({ dir, process: 'core', now: () => AT, echo: false });
    const restore = log.captureConsole();
    try {
      console.warn('Sync engine error for', 'linear:1', new Error(`refused ${GITHUB_TOKEN}`));
      console.error('broken');
    } finally {
      restore();
    }
    const written = read('core.log');
    expect(written).toContain('WARN  core console  Sync engine error for linear:1 Error: refused [removed]');
    expect(written).toContain('ERROR core console  broken');
    expect(written).not.toContain(GITHUB_TOKEN);
    // Each line is one line, the stack folded in.
    expect(written.trim().split('\n')).toHaveLength(2);
  });
});

describe('readLogs', () => {
  it('merges both processes’ files, oldest first', () => {
    const core = createLog({ dir, process: 'core', now: () => AT + 2 });
    const main = createLog({ dir, process: 'main', now: () => AT + 1 });
    main.info('app', 'one');
    core.info('sync', 'two');
    const later = createLog({ dir, process: 'main', now: () => AT + 3 });
    later.info('app', 'three');
    expect(readLogs(dir).map((line) => line.split(/\s+/).at(-1))).toEqual(['one', 'two', 'three']);
    expect(readLogs(dir, { limit: 2 }).map((line) => line.split(/\s+/).at(-1))).toEqual(['two', 'three']);
  });

  it('is empty when there is no logs folder', () => {
    expect(readLogs(join(dir, 'none'))).toEqual([]);
  });
});
