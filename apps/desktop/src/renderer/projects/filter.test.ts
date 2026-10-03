import type { Filing, Project } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  countByFilter,
  FILTER_STORAGE_KEY,
  filingForNew,
  inFilter,
  loadFilter,
  saveFilter,
  validFilter,
} from './filter';

const project = (id: string, code: string): Project => ({
  id,
  name: code,
  code,
  accent: 'blue',
  order: 0,
  archived: false,
  createdAt: 0,
});
const lt = project('p-lt', 'LT');
const tl = project('p-tl', 'TL');

const filed = (projectId: string): { filing: Filing } => ({ filing: { projectId, filedBy: 'user' } });
const unfiled = { filing: null };

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

describe('the Project filter', () => {
  it('lets everything through, only Unfiled Items, or only one Project’s', () => {
    const items = [filed('p-lt'), filed('p-tl'), unfiled];

    expect(items.filter((item) => inFilter('everything', item))).toEqual(items);
    expect(items.filter((item) => inFilter('unfiled', item))).toEqual([unfiled]);
    expect(items.filter((item) => inFilter('p-tl', item))).toEqual([filed('p-tl')]);
  });

  it('counts Items for Everything, Unfiled and each Project', () => {
    const counts = countByFilter([filed('p-lt'), filed('p-lt'), unfiled]);

    expect(counts.everything).toBe(3);
    expect(counts.unfiled).toBe(1);
    expect(counts.project('p-lt')).toBe(2);
    expect(counts.project('p-tl')).toBe(0);
  });

  it('files a new Item into the selected Project, by the User, and leaves it Unfiled otherwise', () => {
    expect(filingForNew('p-lt')).toEqual({ projectId: 'p-lt', filedBy: 'user' });
    expect(filingForNew('everything')).toBeNull();
    expect(filingForNew('unfiled')).toBeNull();
  });

  it('falls back to Everything when its Project is no longer offered', () => {
    expect(validFilter('p-lt', [lt, tl])).toBe('p-lt');
    expect(validFilter('p-gone', [lt, tl])).toBe('everything');
    expect(validFilter('unfiled', [])).toBe('unfiled');
  });

  it('is remembered in storage, starting at Everything', () => {
    const storage = memoryStorage();
    expect(loadFilter(storage)).toBe('everything');

    saveFilter(storage, 'p-lt');

    expect(storage.getItem(FILTER_STORAGE_KEY)).toBe('p-lt');
    expect(loadFilter(storage)).toBe('p-lt');
  });

  it('starts at Everything when storage is unavailable', () => {
    const broken = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };

    expect(loadFilter(broken)).toBe('everything');
    expect(() => saveFilter(broken, 'unfiled')).not.toThrow();
  });
});
