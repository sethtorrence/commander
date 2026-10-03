// PROTOTYPE shared helpers. All data lives in ~/.local/share/commander-eval (never committed).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA = join(homedir(), '.local/share/commander-eval');
export const KEY_FILE = join(homedir(), '.config/commander-eval/zai.key');
export const p = (f) => join(DATA, f);
export const load = (f, d = null) => existsSync(p(f)) ? JSON.parse(readFileSync(p(f), 'utf8')) : d;
export const save = (f, v) => writeFileSync(p(f), JSON.stringify(v, null, 2), { mode: 0o600 });

export const DEFAULT_CONFIG = {
  model: 'glm-5.3-flash',
  endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',
  pricePerMillion: { input: 0.15, cachedInput: 0.03, output: 0.5 },
  buckets: {
    'Needs reply': 'Someone is waiting on me to answer or decide.',
    'Waiting on others': 'I asked or sent something and am waiting for them.',
    'FYI': 'Worth knowing, nothing to do.',
    'Newsletters': 'Newsletters, marketing, digests, product updates.',
    'Receipts': 'Receipts, invoices, orders, bills, statements.',
    'Calendar': 'Invitations, meeting changes, scheduling.',
  },
  projects: {
    'LT': 'Longtail: (edit me) what Longtail is, its domains, people and repos.',
    'TL': 'Titanlink: (edit me) what Titanlink is, its domains, people and repos.',
    'TX': 'Tactics: (edit me) what Tactics is, its domains, people and repos.',
    'Unfiled': 'Personal or anything that belongs to no Project.',
  },
};
export function config() { const c = load('config.json'); if (!c) { save('config.json', DEFAULT_CONFIG); return DEFAULT_CONFIG; } return c; }

export function apiKey() {
  if (!existsSync(KEY_FILE)) throw new Error(`No Z.ai key. Save it (one line) to ${KEY_FILE} and run: chmod 600 ${KEY_FILE}`);
  return readFileSync(KEY_FILE, 'utf8').trim();
}

// One chat call. Returns { ok, json, text, usage, ms, error }.
export async function chat(messages, { json = true, thinking = null, maxTokens = 2048 } = {}) {
  const cfg = config();
  const body = { model: cfg.model, messages, max_tokens: maxTokens, temperature: 0 };
  if (json) body.response_format = { type: 'json_object' };
  if (thinking) body.reasoning_effort = thinking; // GLM-5.3-Flash: 'low' | 'high' | 'max'. Thinking can't be disabled; omitted = model default.
  const t0 = Date.now();
  let res, data;
  try {
    res = await fetch(cfg.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    data = await res.json();
  } catch (e) { return { ok: false, error: String(e), ms: Date.now() - t0 }; }
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}`, status: res.status, ms };
  const text = data.choices?.[0]?.message?.content ?? '';
  let parsed = null;
  if (json) { try { parsed = JSON.parse(text.replace(/^```json\s*|```\s*$/g, '')); } catch { parsed = null; } }
  return { ok: true, json: parsed, text, usage: data.usage || {}, reasoning: data.choices?.[0]?.message?.reasoning_content?.length || 0, ms };
}

export function cost(usage) {
  const pr = config().pricePerMillion;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  return ((usage.prompt_tokens - cached) * pr.input + cached * pr.cachedInput + (usage.completion_tokens || 0) * pr.output) / 1e6;
}
