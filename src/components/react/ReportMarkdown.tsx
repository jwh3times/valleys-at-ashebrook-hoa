import type { ReactNode } from 'react';

/** Allow-list of href schemes. Anything else renders as literal text. */
function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith('//')) return null; // protocol-relative — not site-root
  if (h.startsWith('/')) return h;
  if (/^https?:\/\//i.test(h)) return h;
  if (/^mailto:/i.test(h)) return h;
  return null;
}

/**
 * Inline pass: **bold** and [text](href). Builds React elements only (no
 * dangerouslySetInnerHTML), so neither model output nor board-authored prose
 * can inject markup. Hrefs go through safeHref, so a javascript: URL renders
 * as the literal source text rather than becoming a link.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out.push(<strong key={key++}>{match[1]}</strong>);
    } else {
      const href = safeHref(match[3]);
      out.push(
        href ? (
          <a key={key++} href={href}>
            {match[2]}
          </a>
        ) : (
          match[0]
        ),
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Minimal markdown renderer for AI report output. Builds React elements only
 * (no dangerouslySetInnerHTML), so model output can never inject markup.
 * Supports ##/### headings, -/* bullets, "1." ordered items, **bold**,
 * and paragraphs; anything else renders as literal text.
 */
export default function ReportMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: number) => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={`l${key}`}>{items}</ol>
      ) : (
        <ul key={`l${key}`}>{items}</ul>
      ),
    );
    list = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      const item = (bullet ?? numbered)![1];
      if (!list || list.ordered !== ordered) {
        flushList(i);
        list = { ordered, items: [] };
      }
      list.items.push(item);
      return;
    }
    flushList(i);
    if (line === '') return;
    const h3 = /^###\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h3) blocks.push(<h3 key={i}>{inline(h3[1])}</h3>);
    else if (h2) blocks.push(<h2 key={i}>{inline(h2[1])}</h2>);
    else if (h1) blocks.push(<h2 key={i}>{inline(h1[1])}</h2>);
    else blocks.push(<p key={i}>{inline(line)}</p>);
  });
  flushList(lines.length);

  return <div className="report-md">{blocks}</div>;
}
