/**
 * Small, safe Markdown renderer for Sentinel's output: builds React elements (never HTML
 * strings), so model output cannot inject markup. Supports headings, paragraphs, lists,
 * fenced code, tables, blockquotes, **bold**, *italic*, `code` and http(s) links.
 */

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(\*[^*\n]+\*|_[^_\n]+_)/g;

function inline(text, keyPrefix) {
  const out = [];
  let last = 0;
  let m;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i += 1}`;
    if (m[1]) out.push(<code key={key} style={st.code}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) {
      const label = m[3].slice(1, m[3].indexOf(']('));
      out.push(<a key={key} href={m[4]} target="_blank" rel="noopener noreferrer" style={st.link}>{label}</a>);
    } else if (m[5]) out.push(<em key={key}>{m[5].slice(1, -1)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const listItem = (l) => l.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);

export default function Markdown({ text, compact = false }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k += 1}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    const fence = line.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push(<pre key={key()} style={fence[1] === 'diff' ? st.diff : st.pre}>{body.join('\n')}</pre>);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const k2 = key();
      blocks.push(<div key={k2} role="heading" aria-level={Math.min(6, heading[1].length + 3)} style={heading[1].length <= 2 ? st.h1 : st.h2}>{inline(heading[2], k2)}</div>);
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      const k2 = key();
      blocks.push(
        <div key={k2} style={{ overflowX: 'auto' }}>
          <table style={st.table}>
            <thead><tr>{head.map((c, j) => <th key={j} style={st.th}>{inline(c, `${k2}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} style={st.td}>{inline(c, `${k2}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      const k2 = key();
      blocks.push(<blockquote key={k2} style={st.quote}>{inline(body.join(' '), k2)}</blockquote>);
      continue;
    }

    const li = listItem(line);
    if (li) {
      const ordered = Boolean(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = listItem(lines[i]);
        if (m && Boolean(m[2]) === ordered) { items.push(m[3]); i += 1; continue; }
        // continuation line of the previous item
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; i += 1; continue; }
        break;
      }
      const k2 = key();
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={k2} style={st.list}>{items.map((it, j) => <li key={j} style={st.li}>{inline(it, `${k2}-${j}`)}</li>)}</Tag>);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !listItem(lines[i]) && !/^\s*>/.test(lines[i]) && !isTableRow(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length === 0) { // a line no rule consumed — render as text
      para.push(line.trim());
      i += 1;
    }
    const k2 = key();
    blocks.push(<p key={k2} style={compact ? st.pCompact : st.p}>{inline(para.join(' '), k2)}</p>);
  }

  return <div style={st.wrap}>{blocks}</div>;
}

const st = {
  wrap: { fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)', lineHeight: 1.6, wordBreak: 'break-word' },
  p: { margin: '0 0 var(--space-2)' },
  pCompact: { margin: '0 0 4px' },
  h1: { fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-base)', margin: 'var(--space-3) 0 var(--space-2)' },
  h2: { fontWeight: 'var(--font-weight-semibold)', margin: 'var(--space-3) 0 var(--space-1)' },
  list: { margin: '0 0 var(--space-2)', paddingLeft: 22 },
  li: { margin: '2px 0' },
  code: { fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, background: 'var(--color-bg-light)', padding: '1px 5px', borderRadius: 4 },
  pre: { whiteSpace: 'pre-wrap', background: '#111827', color: '#E5E7EB', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', fontSize: 12, lineHeight: 1.5, overflow: 'auto', margin: '0 0 var(--space-2)' },
  diff: { whiteSpace: 'pre', background: '#0B1220', color: '#E5E7EB', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', fontSize: 12, lineHeight: 1.5, overflow: 'auto', margin: '0 0 var(--space-2)' },
  quote: { margin: '0 0 var(--space-2)', padding: '4px 12px', borderLeft: '3px solid var(--color-border-medium)', color: 'var(--color-text-steel)' },
  link: { color: 'var(--color-action-blue)' },
  table: { borderCollapse: 'collapse', margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)' },
  th: { textAlign: 'left', padding: '4px 8px', borderBottom: '2px solid var(--color-border-light)', whiteSpace: 'nowrap' },
  td: { padding: '4px 8px', borderBottom: '1px solid var(--color-border-light)', verticalAlign: 'top' },
};
