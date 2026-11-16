// Generates pdfs.html — a single, bookmarkable page with one direct link per book.
// Run from the StudyNest folder:  node scripts/build-pdfs.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const marker = 'const LIBRARY_CATALOG = [';
const start = src.indexOf(marker);
if (start < 0) throw new Error('LIBRARY_CATALOG not found');
const bodyStart = src.indexOf('[', start);
const endMarker = '].map(b => ({ id: b[0]';
const end = src.indexOf(endMarker, bodyStart);
if (end < 0) throw new Error('catalog terminator not found');
const rows = eval(src.slice(bodyStart, end + 1)); // trusted, local source file

const cats = {
  all: '✨ All', fiction: '📖 Fiction', classic: '🏛️ Classics', science: '🔬 Science',
  maths: '📐 Maths', tech: '💻 Technology', history: '🏺 History', philosophy: '🧠 Philosophy',
  self: '🌱 Self-growth', exam: '🎯 Exam prep', language: '🗣️ Languages',
  business: '💼 Business', art: '🎨 Art & Design', kids: '🧸 Kids'
};

function pdfFor(row) {
  const url = row[6] || '';
  const g = /gutenberg\.org\/ebooks\/(\d+)/.exec(url);
  if (g) return 'https://www.gutenberg.org/cache/epub/' + g[1] + '/pg' + g[1] + '.pdf';
  return '';
}

const books = rows.map(r => ({
  id: r[0], title: r[1], author: r[2], cat: r[3], emoji: r[4],
  desc: r[5], url: r[6], level: r[7], mins: r[8], pdf: pdfFor(r)
}));

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const order = Object.keys(cats).filter(c => c !== 'all');
const groups = order
  .map(c => ({ key: c, label: cats[c], items: books.filter(b => b.cat === c) }))
  .filter(g => g.items.length);

const directCount = books.filter(b => b.pdf).length;

const card = b => `
  <div class="book" data-text="${esc((b.title + ' ' + b.author + ' ' + b.cat + ' ' + b.desc).toLowerCase())}">
    <div class="emoji">${esc(b.emoji || '📘')}</div>
    <div class="meta">
      <div class="title">${esc(b.title)}</div>
      <div class="sub">${esc(b.author)} · ${esc(b.level || 'All levels')} · ${esc(b.mins)} min</div>
      <div class="desc">${esc(b.desc)}</div>
    </div>
    <div class="links">
      ${b.pdf ? `<a class="dl" href="${esc(b.pdf)}" target="_blank" rel="noopener">📄 PDF</a>` : ''}
      <a class="read" href="${esc(b.url)}" target="_blank" rel="noopener">${b.pdf ? 'Page' : '📖 Read / Download'}</a>
    </div>
  </div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StudyNest · All PDF Links</title>
<meta name="description" content="Every book in the StudyNest library with a direct one-click PDF link.">
<style>
  :root { --bg:#0f0f1a; --panel:#171727; --line:#26263a; --text:#e8e8f2; --muted:#9a9ab5; --accent:#22d3ee; --accent3:#a78bfa; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { position:sticky; top:0; z-index:5; background:rgba(15,15,26,.92); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); padding:14px 18px; }
  h1 { margin:0 0 4px; font-size:1.15rem; }
  .lead { margin:0 0 12px; color:var(--muted); font-size:.82rem; }
  .lead b { color:var(--accent); }
  input { width:100%; max-width:520px; padding:11px 14px; border-radius:12px; border:1px solid var(--line); background:var(--panel); color:var(--text); font-size:.9rem; }
  main { padding:18px; max-width:980px; margin:0 auto; }
  h2 { font-size:.95rem; margin:26px 0 10px; color:var(--accent3); }
  .book { display:flex; gap:12px; align-items:flex-start; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:9px; }
  .emoji { font-size:1.5rem; line-height:1; width:34px; text-align:center; }
  .meta { flex:1; min-width:0; }
  .title { font-weight:700; font-size:.9rem; }
  .sub { color:var(--muted); font-size:.72rem; margin:2px 0 4px; }
  .desc { color:var(--muted); font-size:.76rem; }
  .links { display:flex; flex-direction:column; gap:6px; }
  .links a { text-decoration:none; text-align:center; padding:8px 12px; border-radius:10px; font-size:.72rem; font-weight:700; white-space:nowrap; }
  .dl { background:rgba(239,68,68,.16); color:#f87171; }
  .read { background:rgba(34,211,238,.14); color:var(--accent); }
  .note { margin:16px 0 0; color:var(--muted); font-size:.74rem; line-height:1.5; }
  .hidden { display:none; }
  @media (max-width:560px) { .book { flex-wrap:wrap; } .links { flex-direction:row; width:100%; } .links a { flex:1; } }
</style>
</head>
<body>
<header>
  <h1>📚 StudyNest — all PDF links</h1>
  <p class="lead">${books.length} books and courses · <b>${directCount}</b> direct one-click PDFs · save this page once and you never have to search again.</p>
  <input id="q" placeholder="Search title, author or subject…" autocomplete="off">
</header>
<main id="list">
${groups.map(g => `<h2>${esc(g.label)} <span style="color:var(--muted);font-weight:400;">(${g.items.length})</span></h2>\n${g.items.map(card).join('\n')}`).join('\n')}
  <p class="note">Direct PDFs come from Project Gutenberg's public-domain archive. OpenStax textbooks serve their PDFs behind signed links, so those open the official page where the PDF button is one click away. If a link ever moves, use the second button on that row.</p>
</main>
<script>
  var q = document.getElementById('q');
  q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase();
    document.querySelectorAll('.book').forEach(function (el) {
      el.classList.toggle('hidden', v && el.getAttribute('data-text').indexOf(v) < 0);
    });
    document.querySelectorAll('h2').forEach(function (h) {
      var next = h.nextElementSibling, any = false;
      while (next && next.tagName !== 'H2') { if (!next.classList.contains('hidden')) any = true; next = next.nextElementSibling; }
      h.classList.toggle('hidden', v && !any);
    });
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'pdfs.html'), html);
console.log('Wrote pdfs.html —', books.length, 'books,', directCount, 'direct PDFs');
