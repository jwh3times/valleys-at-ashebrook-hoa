import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ReportMarkdown from './ReportMarkdown';

describe('ReportMarkdown', () => {
  it('renders headings, lists, bold, and paragraphs', () => {
    render(
      <ReportMarkdown
        text={[
          '## Summary',
          'Leases must run **12 months** [Source 1].',
          '',
          '### Details',
          '- first rule',
          '- second rule',
          '1. step one',
        ].join('\n')}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Summary' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Details' }),
    ).toBeInTheDocument();
    expect(screen.getByText('12 months')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders HTML in the source text as literal text, not markup', () => {
    render(<ReportMarkdown text={'<img src=x onerror=alert(1)>'} />);
    expect(
      screen.getByText('<img src=x onerror=alert(1)>'),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders an https link', () => {
    render(
      <ReportMarkdown text="See [the bylaws](https://example.com/b.pdf)." />,
    );
    const a = screen.getByRole('link', { name: 'the bylaws' });
    expect(a).toHaveAttribute('href', 'https://example.com/b.pdf');
  });

  it('renders a site-relative link', () => {
    render(<ReportMarkdown text="See [documents](/documents)." />);
    expect(screen.getByRole('link', { name: 'documents' })).toHaveAttribute(
      'href',
      '/documents',
    );
  });

  it('renders a mailto link', () => {
    render(<ReportMarkdown text="[Email us](mailto:board@example.com)" />);
    expect(screen.getByRole('link', { name: 'Email us' })).toHaveAttribute(
      'href',
      'mailto:board@example.com',
    );
  });

  it('refuses a javascript: href and renders it as literal text', () => {
    render(<ReportMarkdown text="[click](javascript:alert(1))" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText(/\[click\]\(javascript:alert\(1\)\)/),
    ).toBeInTheDocument();
  });

  it('refuses a protocol-relative href', () => {
    render(<ReportMarkdown text="[x](//evil.example.com)" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText(/\[x\]\(\/\/evil\.example\.com\)/),
    ).toBeInTheDocument();
  });

  it('refuses a backslash-prefixed href that browsers normalize off-site', () => {
    render(<ReportMarkdown text="[Click here](/\evil.example.com)" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText(/\[Click here\]\(\/\\evil\.example\.com\)/),
    ).toBeInTheDocument();
  });

  it('refuses a doubled backslash-prefixed href that browsers normalize off-site', () => {
    render(<ReportMarkdown text="[Click here](/\/evil.example.com)" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText(/\[Click here\]\(\/\\\/evil\.example\.com\)/),
    ).toBeInTheDocument();
  });

  it('still renders bold inside a paragraph containing a link', () => {
    render(<ReportMarkdown text="**Note**: see [docs](/documents)." />);
    expect(screen.getByText('Note').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'docs' })).toBeInTheDocument();
  });
});
