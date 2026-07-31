import { useEffect, useState, type FormEvent } from 'react';
import { fetchReports, fetchReport, deleteReport } from '../../lib/admin';
import {
  REPORT_TEMPLATES,
  type ReportListItem,
  type ReportDetail,
  type ReportSource,
} from '../../lib/reports';
import { INPUT_LIMITS } from '../../lib/types';
import ReportMarkdown from './ReportMarkdown';

type View =
  | { kind: 'list' }
  | { kind: 'new' }
  | {
      kind: 'generating';
      topic: string;
      content: string;
      sources: ReportSource[];
    }
  | { kind: 'report'; report: ReportDetail };

export default function ReportsManager() {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [topicInput, setTopicInput] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      setItems(await fetchReports());
      setError('');
    } catch {
      setError('Could not load reports.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function generate(body: { template: string } | { topic: string }) {
    const topic =
      'template' in body
        ? (REPORT_TEMPLATES.find((t) => t.key === body.template)?.label ?? '')
        : body.topic;
    setError('');
    setView({ kind: 'generating', topic, content: '', sources: [] });
    try {
      const res = await fetch('/api/admin/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        setError(
          (await res.text().catch(() => '')) || 'Report generation failed.',
        );
        setView({ kind: 'new' });
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let content = '';
      let sources: ReportSource[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const evLine = frame.match(/^event: (.+)$/m);
          const dataLine = frame.match(/^data: (.+)$/m);
          if (!evLine || !dataLine) continue;
          const data = JSON.parse(dataLine[1]);
          if (evLine[1] === 'sources') {
            sources = data as ReportSource[];
            setView({ kind: 'generating', topic, content, sources });
          } else if (evLine[1] === 'token') {
            content += (data as { text: string }).text;
            setView({ kind: 'generating', topic, content, sources });
          } else if (evLine[1] === 'error') {
            setError((data as { message: string }).message);
            setView({ kind: 'new' });
            return;
          } else if (evLine[1] === 'done') {
            const id = (data as { id: string }).id;
            setView({
              kind: 'report',
              report: {
                id,
                topic,
                templateKey: 'template' in body ? body.template : null,
                createdAt: new Date().toISOString(),
                createdBy: '',
                contentMd: content,
                sources,
              },
            });
            void refresh();
            return;
          }
        }
      }
      setError('The report stream ended unexpectedly.');
      setView({ kind: 'new' });
    } catch {
      setError('Network error. Please try again.');
      setView({ kind: 'new' });
    }
  }

  async function onDelete(id: string) {
    try {
      await deleteReport(id);
      setView({ kind: 'list' });
      void refresh();
    } catch {
      setError('Delete failed.');
    }
  }

  async function openReport(id: string) {
    try {
      setView({ kind: 'report', report: await fetchReport(id) });
    } catch {
      setError('Could not load that report.');
    }
  }

  function onFreeform(e: FormEvent) {
    e.preventDefault();
    const topic = topicInput.trim();
    if (!topic) return;
    setTopicInput('');
    void generate({ topic });
  }

  const disclaimer = (
    <p className="notice">
      AI-generated from your documents — verify important details against the
      cited sources before acting. Reports are point-in-time snapshots;
      regenerate after new document uploads for current results.
    </p>
  );

  return (
    <section className="reports">
      <header>
        <p className="eyebrow">Board tools</p>
        <h1 className="page-title">Reports</h1>
        {view.kind === 'list' && (
          <button
            className="btn"
            type="button"
            onClick={() => setView({ kind: 'new' })}
          >
            New report
          </button>
        )}
        {view.kind !== 'list' && view.kind !== 'generating' && (
          <button
            className="btn btn--outline"
            type="button"
            onClick={() => setView({ kind: 'list' })}
          >
            Back to reports
          </button>
        )}
        {disclaimer}
      </header>

      {error && <div className="form-message form-message--error">{error}</div>}

      {view.kind === 'list' && (
        <div className="reports__list">
          {loading ? (
            <p className="loading">Loading…</p>
          ) : items.length === 0 ? (
            <p>No reports yet. Generate one with “New report”.</p>
          ) : (
            <ul>
              {items.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => void openReport(r.id)}>
                    {r.topic}
                  </button>
                  <span> · {new Date(r.createdAt).toLocaleDateString()}</span>
                  <button
                    type="button"
                    className="btn btn--outline"
                    onClick={() => void onDelete(r.id)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.kind === 'new' && (
        <div className="reports__new">
          <h2>Pick a topic</h2>
          <div className="reports__templates">
            {REPORT_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                className="btn btn--outline"
                onClick={() => void generate({ template: t.key })}
              >
                {t.label}
                <span> — {t.description}</span>
              </button>
            ))}
          </div>
          <form onSubmit={onFreeform}>
            <input
              type="text"
              value={topicInput}
              maxLength={INPUT_LIMITS.reportTopic}
              placeholder="Or enter your own topic…"
              onChange={(e) => setTopicInput(e.target.value)}
            />
            <button className="btn" type="submit">
              Generate
            </button>
          </form>
        </div>
      )}

      {view.kind === 'generating' && (
        <div className="reports__report">
          <h2>{view.topic}</h2>
          <p className="loading">Generating…</p>
          <ReportMarkdown text={view.content} />
        </div>
      )}

      {view.kind === 'report' && (
        <div className="reports__report">
          <h2>{view.report.topic}</h2>
          <p>
            Generated {new Date(view.report.createdAt).toLocaleString()}
            <button
              type="button"
              className="btn btn--outline"
              onClick={() => void onDelete(view.report.id)}
            >
              Delete
            </button>
          </p>
          <ReportMarkdown text={view.report.contentMd} />
          {view.report.sources.length > 0 && (
            <ul className="reports__sources">
              {view.report.sources.map((s) => (
                <li key={s.id}>
                  <a
                    href={`/api/files/${s.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {s.title}
                  </a>
                  <span> · {s.category}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.kind === 'generating' && view.sources.length > 0 && (
        <ul className="reports__sources">
          {view.sources.map((s) => (
            <li key={s.id}>{s.title}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
