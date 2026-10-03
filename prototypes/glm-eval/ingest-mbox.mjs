// PROTOTYPE: node ingest-mbox.mjs <file.mbox> [count=200]
// Keeps the newest N messages as plain text (quoted replies trimmed) in ~/.local/share/commander-eval/emails.json.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { simpleParser } from 'mailparser';
import { save, config } from './common.mjs';

const [file, n = '200'] = process.argv.slice(2);
if (!file) { console.error('Usage: node ingest-mbox.mjs <file.mbox> [count]'); process.exit(1); }
config(); // writes the default config.json on first run
const raws = []; let cur = [];
const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (line.startsWith('From ') && cur.length) { raws.push(cur.join('\n')); cur = []; continue; }
  if (line.startsWith('From ') && !cur.length) continue;
  cur.push(line.replace(/^>(>*From )/, '$1'));
  if (raws.length > 20000) break;
}
if (cur.length) raws.push(cur.join('\n'));
console.log(`Found ${raws.length} messages; parsing…`);
const parsed = [];
for (const raw of raws) {
  try {
    const m = await simpleParser(raw);
    const text = (m.text || '').split(/\n(?:On .{5,120}wrote:|-----Original Message-----)/)[0].replace(/\n>.*$/gm, '').trim().slice(0, 4000);
    parsed.push({ id: m.messageId || String(parsed.length), date: m.date?.toISOString() || null, from: m.from?.text || '', to: m.to?.text || '', subject: m.subject || '', labels: m.headers.get('x-gmail-labels') || '', text });
  } catch { /* skip unparseable */ }
}
parsed.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
const keep = parsed.slice(0, Number(n));
save('emails.json', keep);
console.log(`Saved the newest ${keep.length} emails to ~/.local/share/commander-eval/emails.json`);
