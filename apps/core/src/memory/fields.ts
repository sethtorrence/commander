import type Database from 'better-sqlite3';
import type { IndexedMemory, MemoryRetriever, RetrieverQuery } from './retriever';

/*
  Memory's lookup by fields: the live memories about any of the People (by Person, or by any of their
  handles) or Projects a lookup names, newest first. This is how "Priya works mostly on TL" reaches
  the filing of an issue assigned to her, whatever its words: Person handle → Project.

  People and Projects are columns of `memories`, indexed there. Handles are a list on each memory, so
  they are also kept one per row in `memory_handles`, indexed: derived data like the word index, kept
  current as each memory is saved and rebuilt from the memories when missing.
*/

type Handled = { id: string; handles: readonly string[] };

export function openMemoryFields(
  sqlite: Database.Database,
  // Every live memory's handles, for building the handle index from scratch.
  all: () => Iterable<Handled>,
): MemoryRetriever {
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_handles'")
    .get();
  const drop = () => sqlite.prepare<[string]>('DELETE FROM memory_handles WHERE memory_id = ?');
  const add = () => sqlite.prepare<[string, string]>('INSERT OR IGNORE INTO memory_handles VALUES (?, ?)');
  if (!exists) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE memory_handles (handle TEXT NOT NULL, memory_id TEXT NOT NULL, PRIMARY KEY (handle, memory_id));
        CREATE INDEX memory_handles_memory ON memory_handles (memory_id);
      `);
      const insert = add();
      for (const memory of all())
        for (const handle of memory.handles) insert.run(handle.toLowerCase(), memory.id);
    })();
  }
  const dropHandles = drop();
  const addHandle = add();

  function retrieve(query: RetrieverQuery, limit: number) {
    const ors: string[] = [];
    const params: unknown[] = [];
    const list = (values: readonly string[]) => {
      params.push(...values);
      return values.map(() => '?').join(', ');
    };
    if (query.personIds.length) ors.push(`m.person_id IN (${list(query.personIds)})`);
    if (query.projectIds.length) ors.push(`m.project_id IN (${list(query.projectIds)})`);
    if (query.handles.length) {
      ors.push(
        `m.id IN (SELECT memory_id FROM memory_handles WHERE handle IN (${list(
          query.handles.map((handle) => handle.toLowerCase()),
        )}))`,
      );
    }
    if (!ors.length) return [];
    const kinds = query.kinds ?? [];
    const rows = sqlite
      .prepare(
        `SELECT m.id FROM memories m
        WHERE m.deleted_at IS NULL AND (${ors.join(' OR ')})
        ${kinds.length ? `AND m.kind IN (${list(kinds)})` : ''}
        ORDER BY m.updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as { id: string }[];
    return rows.map((row) => ({ id: row.id, exact: false }));
  }

  function put(memory: IndexedMemory) {
    dropHandles.run(memory.id);
    for (const handle of memory.handles) addHandle.run(handle.toLowerCase(), memory.id);
  }

  return {
    foundBy: 'fields',
    retrieve,
    put,
    drop: (memoryId) => {
      dropHandles.run(memoryId);
    },
  };
}
