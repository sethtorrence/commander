// PROTOTYPE: node label-server.mjs  → open http://127.0.0.1:4317
// Label each email with its Bucket and Project. Keys: 1–6 Bucket, q/w/e/r Project, j/k move. Saves labels.json as you go.
import { createServer } from 'node:http';
import { load, save, config } from './common.mjs';

const emails = load('emails.json', []);
const labels = load('labels.json', {});
const cfg = config();
const page = `<!doctype html><meta charset=utf-8><title>PROTOTYPE · label emails</title>
<style>body{margin:0;background:#141516;color:#EEECE7;font:15px/1.5 system-ui}header{padding:12px 20px;border-bottom:1px solid #333;display:flex;gap:16px;align-items:center}
b.tag{color:#FF5F00;font:600 12px monospace;letter-spacing:.1em}main{display:grid;grid-template-columns:320px 1fr;height:calc(100vh - 50px)}
#list{overflow:auto;border-right:1px solid #333}#list div{padding:6px 12px;border-bottom:1px solid #222;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#list div.cur{background:#2a2b2f}#list div.done{color:#7CD992}#view{overflow:auto;padding:16px 24px}pre{white-space:pre-wrap;font:14px/1.5 system-ui;color:#D3D1CB}
.keys{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.keys button{all:unset;cursor:pointer;border:1px solid #444;padding:4px 10px;font:600 12px monospace}.keys button.on{background:#FF5F00;color:#141414;border-color:#FF5F00}</style>
<header><b class=tag>PROTOTYPE</b><span id=progress></span><span style="color:#8F8D87">1–6 Bucket · q w e r Project · j/k move</span></header>
<main><div id=list></div><div id=view></div></main>
<script>
const B=${JSON.stringify(Object.keys(cfg.buckets))}, P=${JSON.stringify(Object.keys(cfg.projects))};
let E=[],L={},i=0;
async function init(){E=await (await fetch('/api/emails')).json();L=await (await fetch('/api/labels')).json();draw();}
function draw(){const done=E.filter(e=>L[e.id]?.bucket&&L[e.id]?.project).length;document.getElementById('progress').textContent=done+' / '+E.length+' labelled';
document.getElementById('list').innerHTML=E.map((e,k)=>'<div data-k='+k+' class="'+(k===i?'cur ':'')+(L[e.id]?.bucket&&L[e.id]?.project?'done':'')+'">'+esc(e.subject||'(no subject)')+'</div>').join('');
const e=E[i];if(!e)return;const l=L[e.id]||{};
document.getElementById('view').innerHTML='<div><b>'+esc(e.subject)+'</b></div><div style="color:#8F8D87">'+esc(e.from)+' · '+esc(e.date||'')+'</div>'+
'<div class=keys>'+B.map((b,k)=>'<button data-b="'+b+'" class="'+(l.bucket===b?'on':'')+'">'+(k+1)+' '+b+'</button>').join('')+'</div>'+
'<div class=keys>'+P.map((p,k)=>'<button data-p="'+p+'" class="'+(l.project===p?'on':'')+'">'+'qwer'[k]+' '+p+'</button>').join('')+'</div><pre>'+esc(e.text)+'</pre>';
document.querySelector('#list .cur')?.scrollIntoView({block:'nearest'});}
function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function set(k,v){const e=E[i];L[e.id]={...(L[e.id]||{}),[k]:v};await fetch('/api/label',{method:'POST',body:JSON.stringify({id:e.id,...L[e.id]})});
if(L[e.id].bucket&&L[e.id].project&&i<E.length-1)i++;draw();}
document.addEventListener('click',ev=>{const t=ev.target;if(t.dataset.b)set('bucket',t.dataset.b);if(t.dataset.p)set('project',t.dataset.p);if(t.dataset.k){i=+t.dataset.k;draw();}});
document.addEventListener('keydown',ev=>{const n=+ev.key;if(n>=1&&n<=B.length)set('bucket',B[n-1]);const q='qwer'.indexOf(ev.key);if(q>=0&&q<P.length)set('project',P[q]);
if(ev.key==='j'&&i<E.length-1){i++;draw();}if(ev.key==='k'&&i>0){i--;draw();}});
init();
</script>`;
createServer(async (req, res) => {
  if (req.url === '/api/emails') return res.end(JSON.stringify(emails));
  if (req.url === '/api/labels') return res.end(JSON.stringify(labels));
  if (req.url === '/api/label' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    const { id, ...l } = JSON.parse(body); labels[id] = l; save('labels.json', labels); return res.end('ok');
  }
  res.setHeader('Content-Type', 'text/html'); res.end(page);
}).listen(4317, '127.0.0.1', () => console.log(`Labelling ${emails.length} emails at http://127.0.0.1:4317 (Ctrl+C to stop)`));
