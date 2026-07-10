import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AssistantChat from './AssistantChat';

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('AssistantChat', () => {
  it('sends a question and renders the streamed answer + sources', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        `event: sources\ndata: ${JSON.stringify([{ id: 'd1', title: 'Bylaws', category: 'Governing Documents', href: '/api/files/d1' }])}\n\n`,
        `event: token\ndata: ${JSON.stringify({ text: 'The late fee ' })}\n\n`,
        `event: token\ndata: ${JSON.stringify({ text: 'is $25.' })}\n\n`,
        `event: done\ndata: {}\n\n`,
      ]),
    );

    render(<AssistantChat />);
    fireEvent.change(screen.getByPlaceholderText(/ask/i), {
      target: { value: 'late fee?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/The late fee is \$25\./)).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /Bylaws/ })).toHaveAttribute(
      'href',
      '/api/files/d1',
    );
  });

  it('shows the error and drops the empty assistant bubble on an error frame', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        `event: sources\ndata: ${JSON.stringify([{ id: 'd1', title: 'Bylaws', category: 'Governing Documents', href: '/api/files/d1' }])}\n\n`,
        `event: error\ndata: ${JSON.stringify({ message: 'The assistant hit an error. Please try again.' })}\n\n`,
      ]),
    );

    render(<AssistantChat />);
    fireEvent.change(screen.getByPlaceholderText(/ask/i), {
      target: { value: 'late fee?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/The assistant hit an error\. Please try again\./),
      ).toBeInTheDocument(),
    );
    // No lingering empty assistant bubble: only the user's message remains in the log.
    expect(screen.queryByText('…')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Bylaws/ }),
    ).not.toBeInTheDocument();
  });

  it('falls back to a generic message when a non-ok response has an empty body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );

    render(<AssistantChat />);
    fireEvent.change(screen.getByPlaceholderText(/ask/i), {
      target: { value: 'late fee?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/The assistant is unavailable\./),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('…')).not.toBeInTheDocument();
  });
});
