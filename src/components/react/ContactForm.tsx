import { useState, type FormEvent } from 'react';
import { SITE_NAME } from '../../lib/site';

type Status = 'idle' | 'submitting' | 'success' | 'error';

type ContactFormProps = {
  accessKey?: string;
};

export default function ContactForm({ accessKey }: ContactFormProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  if (!accessKey) {
    return (
      <div className="notice">
        <strong>Setup needed:</strong> the contact form isn’t connected yet. Add
        a free Web3Forms access key as <code>WEB3FORMS_KEY</code> in{' '}
        <code>wrangler.toml</code> (see <code>SETUP.md</code>).
      </div>
    );
  }
  const configuredAccessKey = accessKey;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    setErrorMsg('');
    const form = e.currentTarget;
    const data = new FormData(form);
    data.append('access_key', configuredAccessKey);
    if (!data.get('subject')) {
      data.set('subject', `New message from the ${SITE_NAME} website`);
    }
    data.append('from_name', `${SITE_NAME} website`);

    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body: data,
      });
      const json = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
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
          Thanks — your message has been sent. You’ll hear back soon.
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
