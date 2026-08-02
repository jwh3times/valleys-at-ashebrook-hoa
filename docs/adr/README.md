# Architecture Decision Records

This directory records durable architecture and operating decisions for the public project. ADRs
should describe decisions future work must preserve or deliberately supersede. They should not
include resident data, private runbooks, or exploit-level security analysis.

## Index

- [ADR 0001: Possession-Based Homeowner Verification](./0001-possession-based-homeowner-verification.md)
- [ADR 0002: Tiered Content and Document Storage](./0002-tiered-content-and-document-storage.md)
- [ADR 0003: Board Role Management and Bootstrap](./0003-board-role-management-and-bootstrap.md)
- [ADR 0004: Deployment via Cloudflare Workers Builds](./0004-deployment-via-cloudflare-workers-builds.md)
- [ADR 0005: Resident Mode and Official Mode](./0005-resident-mode-and-official-mode.md)
- [ADR 0006: People-per-Home Roster](./0006-people-per-home-roster.md)
- [ADR 0007: Document Deduplication Policy](./0007-document-deduplication-policy.md)
- [ADR 0008: AI Assistant Privacy Gate](./0008-ai-assistant-privacy-gate.md)
- [ADR 0009: RAG Index Corpus Separate from the Download Library](./0009-rag-index-separate-from-download-library.md)
- [ADR 0010: OCR of Scanned Documents Runs as an Operator Offline Job](./0010-ocr-scanned-documents-operator-job.md)
- [ADR 0011: Claude-Sourced Agent Assets, Generated Mirror for Codex](./0011-claude-sourced-agent-assets-mirrored-for-codex.md)
- [ADR 0012: Board Record Modeled as Structured Rows, Separate from Auth Users](./0012-board-record-as-structured-rows.md)
- [ADR 0013: The Admin API Is Gated in Middleware, Not Only Per Route](./0013-admin-api-gated-in-middleware.md)
- [ADR 0014: Meeting Approval Is a Status Gate, Not a Visibility Tier](./0014-meeting-record-status-gate.md)
- [ADR 0015: Vote Weight Is Always Present and Always Summed](./0015-weighted-member-voting.md)
