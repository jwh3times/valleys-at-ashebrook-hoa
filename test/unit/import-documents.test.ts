import { describe, it, expect } from 'vitest';
import {
  contentTypeFor,
  buildInsertSql,
  safeObjectName,
  type DocumentEntry,
} from '../../scripts/import-documents';

describe('safeObjectName', () => {
  it('collapses runs of dots so the R2 key has no ".." (Cloudflare WAF blocks it as directory traversal)', () => {
    expect(safeObjectName('requesting a....pdf')).toBe('requesting_a.pdf');
    expect(safeObjectName('Quote 620..pdf')).toBe('Quote_620.pdf');
    expect(safeObjectName('Homes Inc..doc')).toBe('Homes_Inc.doc');
    expect(safeObjectName('requesting a....pdf')).not.toContain('..');
  });

  it('replaces spaces and unsafe characters with underscore', () => {
    expect(safeObjectName("O'Brien Report.pdf")).toBe('O_Brien_Report.pdf');
  });

  it('leaves an already-safe name unchanged', () => {
    expect(safeObjectName('minutes.pdf')).toBe('minutes.pdf');
  });
});

describe('contentTypeFor', () => {
  it('returns application/pdf for .pdf', () => {
    expect(contentTypeFor('x.pdf')).toBe('application/pdf');
  });

  it('returns the correct MIME type for .docx', () => {
    expect(contentTypeFor('report.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('returns the correct MIME type for .xlsx', () => {
    expect(contentTypeFor('budget.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('returns the correct MIME type for .msg', () => {
    expect(contentTypeFor('email.msg')).toBe('application/vnd.ms-outlook');
  });

  it('returns application/octet-stream for an unknown extension', () => {
    expect(contentTypeFor('file.xyz')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for a file with no extension', () => {
    expect(contentTypeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('buildInsertSql', () => {
  const entry1: DocumentEntry = {
    id: '00000000-0000-0000-0000-000000000001',
    relativePath: 'docs/minutes.pdf',
    filename: 'minutes.pdf',
    title: 'minutes',
    category: 'Financials',
    visibility: 'homeowner',
    r2Key: 'documents/00000000-0000-0000-0000-000000000001/minutes.pdf',
    sizeBytes: 1024,
    contentType: 'application/pdf',
  };

  const entry2: DocumentEntry = {
    id: '00000000-0000-0000-0000-000000000002',
    relativePath: "docs/O'Brien Report.pdf",
    filename: "O'Brien Report.pdf",
    title: "O'Brien Report",
    category: 'Other',
    visibility: 'board',
    r2Key: 'documents/00000000-0000-0000-0000-000000000002/O_Brien_Report.pdf',
    sizeBytes: 2048,
    contentType: 'application/pdf',
  };

  it('targets the documents table with the correct column list', () => {
    const sql = buildInsertSql([entry1]);
    expect(sql).toContain('INSERT INTO documents');
    expect(sql).toContain(
      'id, title, category, visibility, r2_key, filename, size_bytes, content_type, uploaded_at, updated_at',
    );
  });

  it('includes the visibility value for a homeowner entry', () => {
    const sql = buildInsertSql([entry1]);
    expect(sql).toContain("'homeowner'");
  });

  it("escapes a single quote in a title (O'Brien → O''Brien)", () => {
    const sql = buildInsertSql([entry2]);
    expect(sql).toContain("O''Brien");
  });

  it('includes all entries when given multiple', () => {
    const sql = buildInsertSql([entry1, entry2]);
    expect(sql).toContain("'homeowner'");
    expect(sql).toContain("'board'");
    expect(sql).toContain("O''Brien");
  });

  it('keeps a small entry set in a single INSERT statement', () => {
    const sql = buildInsertSql([entry1, entry2]);
    expect((sql.match(/INSERT INTO documents/g) ?? []).length).toBe(1);
  });

  it('splits entries into multiple INSERT statements past the batch size', () => {
    const sql = buildInsertSql([entry1, entry2], 1);
    expect((sql.match(/INSERT INTO documents/g) ?? []).length).toBe(2);
    // both rows still present
    expect(sql).toContain("'homeowner'");
    expect(sql).toContain("'board'");
  });
});
