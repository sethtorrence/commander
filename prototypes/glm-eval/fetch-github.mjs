// PROTOTYPE: node fetch-github.mjs [days=7] → github-week.json (read-only via the gh CLI).
import { execFileSync } from 'node:child_process';
import { save } from './common.mjs';
const days = Number(process.argv[2] || 7);
const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 50e6 }));
const repos = gh(['api', '/user/repos?affiliation=owner,organization_member&sort=pushed&per_page=30']).filter(r => r.pushed_at >= since).slice(0, 15);
const week = { since, repos: [] };
for (const r of repos) {
  const q = (extra) => gh(['search', 'prs', '--repo', r.full_name, ...extra, '--limit', '50', '--json', 'number,title,author,body,state,createdAt,closedAt,url']);
  const merged = q(['--merged', `--merged-at=>=${since}`]);
  const opened = q([`--created=>=${since}`]);
  week.repos.push({ repo: r.full_name, merged: merged.map(p => ({ ...p, body: (p.body || '').slice(0, 1500) })), opened: opened.map(p => ({ number: p.number, title: p.title, author: p.author?.login, state: p.state })) });
  console.log(`${r.full_name}: ${merged.length} merged, ${opened.length} opened`);
}
save('github-week.json', week);
console.log('Saved github-week.json');
