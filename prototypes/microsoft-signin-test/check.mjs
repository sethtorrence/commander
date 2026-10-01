// PROTOTYPE, throwaway. Answers "Test Microsoft sign-in, sync and threading with real accounts"
// (https://github.com/sethtorrence/commander/issues/20). Tokens live in memory only.
// The report keeps counts and yes/no results only: no subjects, addresses or message content.
//
// Run: node check.mjs --client-id <APP_ID> --label personal|work
import { PublicClientApplication } from '@azure/msal-node';
import open from 'open';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const clientId = arg('client-id');
const label = arg('label', 'account');
const skipSend = process.argv.includes('--skip-send-later');
if (!clientId) { console.error('Usage: node check.mjs --client-id <APP_ID> --label personal|work [--skip-send-later]'); process.exit(1); }

const G = 'https://graph.microsoft.com';
const report = { label, startedAt: new Date().toISOString(), checks: {} };
const log = (...a) => console.log(`[${label}]`, ...a);
const save = () => writeFileSync(`report-${label}.json`, JSON.stringify(report, null, 2));

const pca = new PublicClientApplication({ auth: { clientId, authority: 'https://login.microsoftonline.com/common' } });
const interactive = (scopes, extra = {}) => pca.acquireTokenInteractive({
  scopes, openBrowser: async (url) => { await open(url); },
  successTemplate: '<h1>Signed in. You can close this tab and go back to the terminal.</h1>',
  errorTemplate: '<h1>Sign-in failed: {error}</h1>', ...extra,
});
const errInfo = (e) => ({ ok: false, errorCode: e.errorCode || e.code || null, message: String(e.errorMessage || e.message || e).slice(0, 400) });

async function graph(token, path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : G + path, {
    ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// ── Check 1 + 2: sign in with Commander's full mail and calendar scopes ─────────────────────
const CORE = ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'MailboxSettings.ReadWrite', 'offline_access'];
let token, account;
try {
  log('Opening the browser to sign in with the core mail and calendar scopes…');
  const r = await interactive(CORE, { prompt: 'select_account' });
  token = r.accessToken; account = r.account;
  const claims = r.idTokenClaims || {};
  report.checks.coreSignIn = {
    ok: true,
    accountType: claims.tid === '9188040d-6c67-4c5b-b112-36a304b66dad' ? 'personal' : 'work-or-school',
    tenantId: claims.tid, grantedScopes: r.scopes,
    note: 'For check 1, compare tenantId with the tenant the app was registered in.',
  };
  log('Signed in ✓', report.checks.coreSignIn.accountType);
} catch (e) {
  report.checks.coreSignIn = errInfo(e); save();
  log('Sign-in failed ✗', report.checks.coreSignIn); process.exit(1);
}
save();

// ── Check 3: what happens when Mail.*.Shared is requested ────────────────────────────────────
try {
  log('Opening the browser again to request Mail.Read.Shared (shared mailbox scope)…');
  const r = await interactive(['Mail.Read.Shared'], { account, prompt: 'consent' });
  report.checks.sharedScope = { ok: true, grantedScopes: r.scopes };
} catch (e) { report.checks.sharedScope = errInfo(e); }
log('Shared scope:', report.checks.sharedScope.ok ? 'granted ✓' : `refused ✗ ${report.checks.sharedScope.errorCode}`);
save();

// ── Check 4: v1.0 calendarView delta on a non-primary calendar ──────────────────────────────
{
  const start = new Date(Date.now() - 7 * 864e5).toISOString(), end = new Date(Date.now() + 30 * 864e5).toISOString();
  const cals = await graph(token, '/v1.0/me/calendars?$select=id,isDefaultCalendar,canEdit');
  const list = cals.body?.value || [];
  const primary = await graph(token, `/v1.0/me/calendarView/delta?startDateTime=${start}&endDateTime=${end}`);
  const other = list.find(c => !c.isDefaultCalendar);
  const res = { calendars: list.length, primaryDeltaStatus: primary.status, nonPrimaryCalendarFound: !!other };
  if (other) {
    const d = await graph(token, `/v1.0/me/calendars/${other.id}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`);
    res.nonPrimaryDeltaStatus = d.status;
    res.nonPrimaryDeltaWorks = d.status === 200 && !!(d.body?.['@odata.deltaLink'] || d.body?.['@odata.nextLink']);
    if (d.status !== 200) res.nonPrimaryError = d.body?.error?.code || null;
  } else res.note = 'Create a second calendar in Outlook on the web and re-run to test this.';
  report.checks.calendarDelta = res;
  log('Calendar delta:', res);
  save();
}

// ── Check 6: Graph conversationId vs header-based threading (counts only) ───────────────────
{
  const msgs = [];
  let url = '/v1.0/me/messages?$top=50&$orderby=receivedDateTime desc&$select=conversationId,internetMessageId,internetMessageHeaders';
  let headersInList = true;
  while (url && msgs.length < 300) {
    const r = await graph(token, url);
    if (r.status !== 200) { headersInList = false; break; }
    msgs.push(...(r.body.value || [])); url = r.body['@odata.nextLink'];
  }
  if (!headersInList) { // fall back: list ids, then fetch headers per message (first 120)
    const r = await graph(token, '/v1.0/me/messages?$top=120&$orderby=receivedDateTime desc&$select=id,conversationId,internetMessageId');
    for (const m of r.body?.value || []) {
      const h = await graph(token, `/v1.0/me/messages/${m.id}?$select=internetMessageHeaders`);
      msgs.push({ ...m, internetMessageHeaders: h.body?.internetMessageHeaders || [] });
    }
  }
  // Union-find over Message-ID, In-Reply-To and References.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const ids = (s) => (s || '').match(/<[^>]+>/g) || [];
  let withHeaders = 0;
  for (const m of msgs) {
    const own = m.internetMessageId; if (!own) continue; add(own);
    const hdr = Object.fromEntries((m.internetMessageHeaders || []).map(h => [h.name.toLowerCase(), h.value]));
    if (hdr['in-reply-to'] || hdr['references']) withHeaders++;
    for (const ref of [...ids(hdr['in-reply-to']), ...ids(hdr['references'])]) union(own, ref);
  }
  const headerThreadOf = new Map(msgs.filter(m => m.internetMessageId).map(m => [m.internetMessageId, find(m.internetMessageId)]));
  const byConv = new Map(), byHdr = new Map();
  for (const m of msgs) {
    if (!m.internetMessageId) continue;
    const h = headerThreadOf.get(m.internetMessageId);
    (byConv.get(m.conversationId) || byConv.set(m.conversationId, new Set()).get(m.conversationId)).add(h);
    (byHdr.get(h) || byHdr.set(h, new Set()).get(h)).add(m.conversationId);
  }
  report.checks.threading = {
    messagesCompared: msgs.length, messagesWithReplyHeaders: withHeaders,
    headersAvailableInListCall: headersInList,
    conversations: byConv.size, headerThreads: byHdr.size,
    conversationsMergingSeveralHeaderThreads: [...byConv.values()].filter(s => s.size > 1).length,
    headerThreadsSplitAcrossConversations: [...byHdr.values()].filter(s => s.size > 1).length,
  };
  log('Threading:', report.checks.threading);
  save();
}

// ── Check 5: server-side send-later via PidTagDeferredSendTime ──────────────────────────────
if (skipSend) report.checks.sendLater = { skipped: true };
else {
  const me = await graph(token, '/v1.0/me?$select=mail,userPrincipalName');
  const addr = me.body?.mail || me.body?.userPrincipalName;
  const due = new Date(Date.now() + 3 * 60e3);
  const tag = `[Commander test] send-later probe ${Date.now()}`;
  const draft = await graph(token, '/v1.0/me/messages', { method: 'POST', body: JSON.stringify({
    subject: tag, body: { contentType: 'Text', content: 'Throwaway test from the Commander sign-in tester. Safe to delete.' },
    toRecipients: [{ emailAddress: { address: addr } }],
    singleValueExtendedProperties: [{ id: 'SystemTime 0x3FEF', value: due.toISOString() }],
  }) });
  const sendRes = draft.status === 201 ? await graph(token, `/v1.0/me/messages/${draft.body.id}/send`, { method: 'POST' }) : { status: null };
  const res = { draftStatus: draft.status, sendStatus: sendRes.status, dueAt: due.toISOString() };
  if (sendRes.status === 202) {
    log(`Send-later probe queued for ${due.toLocaleTimeString()}. Polling the inbox for up to 7 minutes…`);
    const t0 = Date.now(); let arrived = null, earlyArrival = false;
    while (Date.now() - t0 < 7 * 60e3) {
      await new Promise(r => setTimeout(r, 20e3));
      const q = await graph(token, `/v1.0/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime desc&$select=id,subject,receivedDateTime`);
      const hit = (q.body?.value || []).find(m => m.subject === tag);
      if (hit) { arrived = hit; earlyArrival = new Date(hit.receivedDateTime) < new Date(due.getTime() - 60e3); break; }
    }
    res.arrived = !!arrived;
    if (arrived) {
      res.secondsAfterDue = Math.round((new Date(arrived.receivedDateTime) - due) / 1000);
      res.heldServerSide = !earlyArrival;
      await graph(token, `/v1.0/me/messages/${arrived.id}`, { method: 'DELETE' });
    }
    const sent = await graph(token, `/v1.0/me/mailFolders/sentitems/messages?$top=10&$orderby=sentDateTime desc&$select=id,subject`);
    for (const m of (sent.body?.value || []).filter(m => m.subject === tag)) await graph(token, `/v1.0/me/messages/${m.id}`, { method: 'DELETE' });
  } else res.error = draft.body?.error?.code || sendRes.body?.error?.code || null;
  report.checks.sendLater = res;
  log('Send later:', res);
}

report.finishedAt = new Date().toISOString();
save();
log(`Done. Report written to report-${label}.json (counts and yes/no results only).`);
