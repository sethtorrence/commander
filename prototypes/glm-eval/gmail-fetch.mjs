// PROTOTYPE: node gmail-fetch.mjs [count=200]
// Signs in to Gmail READ-ONLY (desktop OAuth, loopback + PKCE), fetches the newest messages and saves them like ingest-mbox.mjs.
// The OAuth client JSON lives at ~/.config/commander-eval/google-client.json. Tokens stay in memory only.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { save, config } from './common.mjs';

const n = Number(process.argv[2] || 200);
const raw = JSON.parse(readFileSync(join(homedir(), '.config/commander-eval/google-client.json'), 'utf8'));
const c = raw.installed || raw.web;
config();
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const code = await new Promise((resolve, reject) => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (!u.searchParams.get('code') && !u.searchParams.get('error')) { res.end(); return; }
    res.end('<h1>Signed in. You can close this tab and go back to the terminal.</h1>');
    srv.close(); u.searchParams.get('code') ? resolve({ code: u.searchParams.get('code'), port: srv.address()?.port ?? port }) : reject(new Error(u.searchParams.get('error')));
  });
  let port;
  srv.listen(0, '127.0.0.1', () => {
    port = srv.address().port;
    const auth = new URL(c.auth_uri);
    Object.entries({ client_id: c.client_id, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.readonly', code_challenge: challenge, code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' })
      .forEach(([k, v]) => auth.searchParams.set(k, v));
    console.log('Opening your browser to sign in to Gmail (read-only)…');
    execFile('xdg-open', [auth.toString()]);
    srv.port = port;
  });
});

const tok = await (await fetch(c.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
  code: code.code, client_id: c.client_id, client_secret: c.client_secret || '', redirect_uri: `http://127.0.0.1:${code.port}`, grant_type: 'authorization_code', code_verifier: verifier }) })).json();
if (!tok.access_token) { console.error('Token exchange failed:', tok); process.exit(1); }
async function G(path, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (r.status === 429 || r.status >= 500) { console.log(`  Gmail ${r.status}, retrying in ${2 ** i}s`); await new Promise(res => setTimeout(res, 1000 * 2 ** i)); continue; }
    const j = await r.json(); if (j.error) console.log(`  Gmail error ${r.status}: ${j.error.message}`); return j;
  }
  return { error: { message: 'gave up after retries' } };
}

const prof = await G('profile'); console.log(`Signed in as a mailbox with ${prof.messagesTotal ?? '?'} messages.`);
const ids = []; let pageToken = '';
while (ids.length < n) {
  const page = await G(`messages?maxResults=100&q=${encodeURIComponent('-in:chats -in:spam -in:trash')}${pageToken ? `&pageToken=${pageToken}` : ''}`);
  if (page.error) { console.log('List failed:', page.error.message); break; }
  ids.push(...(page.messages || []).map(m => m.id)); if (!page.nextPageToken) break; pageToken = page.nextPageToken;
}
const dec = (d) => Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const findPart = (p, mime) => !p ? null : p.mimeType === mime && p.body?.data ? p.body.data : (p.parts || []).map(x => findPart(x, mime)).find(Boolean);
const emails = [];
for (const id of ids.slice(0, n)) {
  const m = await G(`messages/${id}?format=full`);
  if (!m.payload) { console.log(`skipped ${id} (${m.error?.message || 'no body'})`); continue; }
  const h = Object.fromEntries((m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  let text = findPart(m.payload, 'text/plain'); text = text ? dec(text) : (findPart(m.payload, 'text/html') ? dec(findPart(m.payload, 'text/html')).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ') : (m.snippet || ''));
  text = text.split(/\n(?:On .{5,120}wrote:|-----Original Message-----)/)[0].replace(/\n>.*$/gm, '').trim().slice(0, 4000);
  emails.push({ id: h['message-id'] || id, date: m.internalDate ? new Date(+m.internalDate).toISOString() : null, from: h.from || '', to: h.to || '', subject: h.subject || '', labels: (m.labelIds || []).join(','), text });
  if (emails.length % 25 === 0) console.log(`${emails.length}/${Math.min(n, ids.length)} fetched`);
}
save('emails.json', emails);
console.log(`Saved ${emails.length} emails to ~/.local/share/commander-eval/emails.json. The access token was never written to disk.`);
