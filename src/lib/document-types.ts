// The document upload allowlist: the one source for the store that enforces
// it, the search-twin builder that must convert every type on it, and the
// upload form's file picker (#290 slice 1). Client-safe, so the admin
// component can import it.
//
// The stored content type is chosen here from the extension, never from the
// client, because browsers report .md/.csv unreliably. text/html and
// image/svg+xml are deliberately absent — they are the stored-XSS vectors when
// served inline.
export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const DOCUMENT_EXTENSIONS: readonly string[] =
  Object.keys(DOCUMENT_TYPES);
