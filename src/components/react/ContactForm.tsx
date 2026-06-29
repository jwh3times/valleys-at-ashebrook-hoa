import { useState, type FormEvent } from 'react';

const ACCESS_KEY = import.meta.env.PUBLIC_WEB3FORMS_KEY as string | undefined;

type Status = 'idle' | 'submitting' | 'success' | 'error';

export default function ContactForm() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  if (!ACCESS_KEY) {
    return (
      <div className="notice">
        <strong>Setup needed:</strong> the contact form isn’t connected yet. Add
        a free Web3Forms access key as <code>PUBLIC_WEB3FORMS_KEY</code> in your{' '}
        <code>.env</code> file (see <code>SETUP.md</code>).
      </div>
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    setErrorMsg('');
    const form = e.currentTarget;
    const data = new FormData(form);
    data.append('access_key', ACCESS_KEY!);
    if (!data.get('subject')) {
      data.set('subject', 'New message from the HOA website');
    }
    data.append('from_name', 'Valleys at Ashebrook HOA Website');

    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body: data,
      });
      const json = await res.json();
      if (json.success) {
        setStatus('success');
        form.reset();
      } else {
        setStatus('error');
        setErrorMsg(json.message ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setStatus('error');
      setErrorMsg('Network error. Please try again later.');
    }
  }

  if (status === 'success') {
    return (
      <div className="contact-success">
        <div className="contact-success__h">Message sent ✓</div>
        <p className="contact-success__p">
          Thank you — the board has received your note and will be in touch
          soon.
        </p>
        <button
          type="button"
          className="linklike"
          style={{ marginTop: '18px' }}
          onClick={() => setStatus('idle')}
        >
          Send another →
        </button>
      </div>
    );
  }

  return (
    <form className="form-stack" onSubmit={handleSubmit}>
      {status === 'error' && (
        <div className="form-message form-message--error">{errorMsg}</div>
      )}

      {/* Honeypot field to deter spam bots */}
      <input
        type="checkbox"
        name="botcheck"
        className="honeypot"
        tabIndex={-1}
        autoComplete="off"
      />

      <div className="form-row">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" type="text" required />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="email">Your email</label>
          <input id="email" name="email" type="email" required />
        </div>
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="subject">Subject</label>
        <input
          id="subject"
          name="subject"
          type="text"
          placeholder="What’s this about?"
        />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="message">Message</label>
        <textarea id="message" name="message" required />
      </div>
      <button
        className="btn"
        type="submit"
        disabled={status === 'submitting'}
        style={{ alignSelf: 'flex-start' }}
      >
        {status === 'submitting' ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}
