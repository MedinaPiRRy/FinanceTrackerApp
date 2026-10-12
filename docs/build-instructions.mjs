// Builds INSTRUCTIONS.html from INSTRUCTIONS.md, so the two can never disagree.
//
//   node docs/build-instructions.mjs
//
// It has no dependencies and needs no internet. It reads INSTRUCTIONS.md (next to README.md), turns the Markdown into HTML, adds a sticky topic menu,
// a search box and a light/dark look, and writes one self-contained INSTRUCTIONS.html beside it. It also checks every link that points inside the page
// and stops with a list if one points to a heading that does not exist.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'INSTRUCTIONS.md'), 'utf8').replace(/\r\n/g, '\n')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// the same rule GitHub uses for heading links: lower case, drop punctuation, spaces become hyphens
const slugOf = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-')

function inline(t) {
  const codes = []
  t = t.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000` })
  t = esc(t)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => `<a href="${href}">${text}</a>`)
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  t = t.replace(/\[screenshot: ([^\]]+)\]/g, '<span class="shot">[screenshot: $1]</span>')
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`)
}

// ---- block parser
const lines = src.split('\n')
const out = []
const headings = [] // { level, text, id }
const used = new Map()
const uniq = (id) => { const n = used.get(id) ?? 0; used.set(id, n + 1); return n ? `${id}-${n}` : id }

function parseBlocks(ls, indent = 0) {
  const html = []
  let i = 0
  const strip = (l) => l.slice(Math.min(indent, l.length - l.trimStart().length))
  while (i < ls.length) {
    const line = strip(ls[i])
    if (line.trim() === '') { i++; continue }
    let m
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = m[1].length
      const id = uniq(slugOf(m[2]))
      headings.push({ level, text: m[2].replace(/[*`]/g, ''), id })
      html.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`)
      i++
    } else if (/^---+$/.test(line.trim())) { html.push('<hr>'); i++ }
    else if (/^<details>/.test(line.trim())) {
      const summary = /<summary>(.*?)<\/summary>/.exec(line)?.[1] ?? 'More'
      const body = []
      i++
      while (i < ls.length && !/^<\/details>/.test(strip(ls[i]).trim())) { body.push(ls[i]); i++ }
      i++
      html.push(`<details><summary>${inline(summary)}</summary>${parseBlocks(body, indent)}</details>`)
    } else if (/^(\d+\.|-)\s+/.test(line)) {
      const ordered = /^\d+\./.test(line)
      const items = []
      while (i < ls.length) {
        const l = strip(ls[i])
        if (l.trim() === '') { // a blank line may sit between items of one list
          if (i + 1 < ls.length && (/^(\d+\.|-)\s+/.test(strip(ls[i + 1])) || /^\s{2,}\S/.test(ls[i + 1]))) { i++; continue }
          break
        }
        const mm = /^(\d+\.|-)\s+(.*)$/.exec(l)
        if (mm && ordered === /^\d+\./.test(l)) { items.push({ text: [mm[2]], sub: [] }); i++ }
        else if (/^\s{2,}\S/.test(l) && items.length) {
          const sub = l.trim()
          if (/^(\d+\.|-)\s+/.test(sub)) items[items.length - 1].sub.push(sub); else if (items[items.length - 1].sub.length) items[items.length - 1].sub.push(sub); else items[items.length - 1].text.push(sub)
          i++
        } else break
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((it) => `<li>${inline(it.text.join(' '))}${it.sub.length ? parseBlocks(it.sub) : ''}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
    } else {
      const para = []
      while (i < ls.length && strip(ls[i]).trim() !== '' && !/^(#{1,6}\s|---+$|<details>|<\/details>|(\d+\.|-)\s+)/.test(strip(ls[i]).trim())) { para.push(strip(ls[i]).trim()); i++ }
      if (!para.length) { i++; continue }
      html.push(`<p>${inline(para.join(' '))}</p>`)
    }
  }
  return html.join('\n')
}
const body = parseBlocks(lines)

// ---- wrap each H2 section so search can show or hide it, and build the menu
const parts = body.split(/(?=<h2 id=)/)
const intro = parts.shift()
const sections = parts.map((p) => {
  const m = /<h2 id="([^"]+)">(.*?)<\/h2>/.exec(p)
  return { id: m[1], title: m[2].replace(/<[^>]+>/g, ''), html: p }
})
const subsOf = (secId) => {
  const idx = headings.findIndex((h) => h.level === 2 && h.id === secId)
  const subs = []
  for (let k = idx + 1; k < headings.length && headings[k].level > 2; k++) if (headings[k].level === 3) subs.push(headings[k])
  return subs
}
const menu = sections.map((s) => `<li class="topic" data-id="${s.id}"><a href="#${s.id}">${esc(s.title)}</a></li>`).join('')
const pageTitle = (/^#\s+(.*)$/m.exec(src)?.[1] ?? 'Instructions').replace(/[*`]/g, '')

// ---- check the links
const ids = new Set(headings.map((h) => h.id))
const broken = [...src.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((id) => !ids.has(id))
if (broken.length) { console.error('Links that point to a heading that does not exist:\n  #' + [...new Set(broken)].join('\n  #')); process.exit(1) }

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<style>
:root{--bg:#f6f7fb;--panel:#fff;--text:#1d2433;--muted:#5d6678;--line:#dfe3ec;--accent:#2457d6;--accent-bg:#e8eefc;--code:#eef1f7;--note:#fff8e1}
@media (prefers-color-scheme:dark){:root{--bg:#10141c;--panel:#171c27;--text:#e6eaf3;--muted:#98a2b8;--line:#2a3142;--accent:#7da2ff;--accent-bg:#1d2740;--code:#222a3a;--note:#2a2614}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:70px}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.top{position:sticky;top:0;z-index:5;display:flex;gap:10px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
.top strong{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#menu-btn{display:none;border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}
.layout{display:flex;max-width:1180px;margin:0 auto}
nav{width:290px;flex:none;position:sticky;top:57px;align-self:flex-start;max-height:calc(100vh - 57px);overflow:auto;padding:16px;border-right:1px solid var(--line)}
nav input{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);font:inherit}
nav ul{list-style:none;margin:12px 0 0;padding:0}nav li a{display:block;padding:6px 10px;border-radius:7px;color:var(--text);text-decoration:none;font-size:14.5px}
nav li a:hover,nav li a.on{background:var(--accent-bg);color:var(--accent)}
#none{display:none;color:var(--muted);font-size:14px;margin-top:10px}
main{flex:1;min-width:0;padding:8px 28px 80px}
h1{font-size:30px;margin:24px 0 8px}h2{font-size:24px;margin:34px 0 8px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:18px;margin:24px 0 6px}
p,li{max-width:76ch}li{margin:4px 0}ol,ul{padding-left:24px}
code{background:var(--code);padding:1px 5px;border-radius:5px;font-size:.92em}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 14px;margin:12px 0}summary{cursor:pointer;font-weight:600}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
.shot{color:var(--muted);font-style:italic}
section.sec[hidden]{display:none}
mark{background:#ffe27a;color:#222;border-radius:3px}
@media (max-width:860px){#menu-btn{display:inline-block}nav{display:none;position:fixed;inset:57px 0 0 0;width:auto;max-height:none;background:var(--panel);z-index:4;border:0}nav.open{display:block}main{padding:8px 16px 60px}}
@media print{.top,nav{display:none}.layout{display:block}details{border:0}}
</style></head><body>
<div class="top"><button id="menu-btn" aria-expanded="false">Topics</button><strong>${esc(pageTitle)}</strong></div>
<div class="layout">
<nav id="nav" aria-label="Topics"><input id="q" type="search" placeholder="Search this guide" aria-label="Search this guide" autocomplete="off"><ul id="topics">${menu}</ul><p id="none">No topic matches.</p></nav>
<main id="main">
<div id="intro">${intro}</div>
${sections.map((s) => `<section class="sec" id="sec-${s.id}" data-id="${s.id}">${s.html}</section>`).join('\n')}
</main></div>
<script>
(function(){
  var q=document.getElementById('q'),nav=document.getElementById('nav'),btn=document.getElementById('menu-btn'),none=document.getElementById('none');
  var secs=[].slice.call(document.querySelectorAll('section.sec')),topics=[].slice.call(document.querySelectorAll('li.topic')),intro=document.getElementById('intro');
  var text=secs.map(function(s){return s.textContent.toLowerCase()});
  btn.addEventListener('click',function(){var o=nav.classList.toggle('open');btn.setAttribute('aria-expanded',o)});
  nav.addEventListener('click',function(e){if(e.target.tagName==='A')nav.classList.remove('open')});
  function filter(){
    var v=q.value.trim().toLowerCase(),shown=0,words=v.split(/\\s+/).filter(Boolean);
    secs.forEach(function(s,i){var ok=!words.length||words.every(function(w){return text[i].indexOf(w)>-1});s.hidden=!ok;topics[i].style.display=ok?'':'none';if(ok)shown++;
      [].slice.call(s.querySelectorAll('details')).forEach(function(d){d.open=!!words.length&&words.every(function(w){return d.textContent.toLowerCase().indexOf(w)>-1})})});
    intro.style.display=words.length?'none':'';none.style.display=shown?'none':'block';
  }
  q.addEventListener('input',filter);
  // open the collapsible part that a link points into
  function openFor(){var h=location.hash.slice(1);if(!h)return;var el=document.getElementById(h);while(el){if(el.tagName==='DETAILS')el.open=true;el=el.parentElement}}
  window.addEventListener('hashchange',openFor);openFor();
  // mark the topic being read
  if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){topics.forEach(function(t){t.firstChild.classList.toggle('on',t.dataset.id===e.target.dataset.id)})}})},{rootMargin:'-20% 0px -70% 0px'});secs.forEach(function(s){io.observe(s)})}
})();
</script></body></html>`
fs.writeFileSync(path.join(root, 'INSTRUCTIONS.html'), html)
console.log(`Wrote INSTRUCTIONS.html (${sections.length} topics, ${headings.length} headings, all links checked).`)
