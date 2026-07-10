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
});
