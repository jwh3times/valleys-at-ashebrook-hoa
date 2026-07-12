import { useRef, useState, type FormEvent } from 'react';

interface Source {
  id: string;
  title: string;
  category: string;
  href: string;
}
interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  noDocuments?: boolean;
}

export default function AssistantChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const historyRef = useRef<Message[]>([]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    setError('');
    setInput('');
    setBusy(true);

    const userMsg: Message = { role: 'user', content: question };
    const priorHistory = historyRef.current
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, userMsg, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch('/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, history: priorHistory }),
      });
      if (!res.ok || !res.body) {
        setError(
          (await res.text().catch(() => '')) || 'The assistant is unavailable.',
        );
        setMessages((m) => m.slice(0, -1)); // drop the empty assistant bubble
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let answer = '';
      let sources: Source[] = [];
      let sourcesReceived = false;
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
            sources = data as Source[];
            sourcesReceived = true;
            const noDocuments = sources.length === 0;
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = {
                ...next[next.length - 1],
                sources,
                noDocuments,
              };
              return next;
            });
          } else if (evLine[1] === 'token') {
            answer += (data as { text: string }).text;
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = {
                role: 'assistant',
                content: answer,
                sources,
                noDocuments: sourcesReceived && sources.length === 0,
              };
              return next;
            });
          } else if (evLine[1] === 'error') {
            setError((data as { message: string }).message);
            setMessages((m) => m.slice(0, -1)); // drop the trailing assistant bubble
            return; // stop consuming the stream; don't commit this turn to history
          }
        }
      }
      const finalAssistant: Message = {
        role: 'assistant',
        content: answer,
        sources,
        noDocuments: sourcesReceived && sources.length === 0,
      };
      historyRef.current = [...historyRef.current, userMsg, finalAssistant];
    } catch {
      setError('Network error. Please try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    setMessages([]);
    historyRef.current = [];
    setError('');
    setInput('');
  }

  return (
    <section className="assistant">
      <header>
        <p className="eyebrow">Board tools</p>
        <h1 className="page-title">Document Assistant</h1>
        <button
          type="button"
          className="btn assistant__new"
          onClick={newConversation}
          disabled={busy}
        >
          New conversation
        </button>
        <p className="notice">
          AI-generated from your documents and general knowledge — the answer
          labels which parts come from the documents. Verify important details
          before acting: general knowledge is not specific to this HOA, scanned
          or spreadsheet content may be incomplete, and answers can be wrong.
          Resident names and contact details are pseudonymized before the
          question is sent to the AI provider.
        </p>
      </header>

      <div className="assistant__log">
        {messages.map((m, i) => (
          <div key={i} className={`assistant__msg assistant__msg--${m.role}`}>
            <div className="assistant__bubble">
              {m.content || (m.role === 'assistant' ? '…' : '')}
            </div>
            {m.role === 'assistant' && m.noDocuments && (
              <p className="assistant__notice notice">
                No matching documents found — this answer is general knowledge
                only.
              </p>
            )}
            {m.sources && m.sources.length > 0 && (
              <ul className="assistant__sources">
                {m.sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.href} target="_blank" rel="noopener noreferrer">
                      {s.title}
                    </a>
                    <span className="assistant__cat"> · {s.category}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {error && <div className="form-message form-message--error">{error}</div>}

      <form className="assistant__form" onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          placeholder="Ask a question about the documents…"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
