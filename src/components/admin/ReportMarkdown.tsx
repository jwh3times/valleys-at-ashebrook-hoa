import type { ReactNode } from 'react';

/** Inline pass: only **bold** is supported; everything else is literal text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  parts.forEach((part, i) => {
    if (part === '') return;
    out.push(i % 2 === 1 ? <strong key={i}>{part}</strong> : part);
  });
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
