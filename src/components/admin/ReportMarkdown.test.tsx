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
});
