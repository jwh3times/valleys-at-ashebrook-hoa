# Design — Admin-only AI Document Assistant (with PII pseudonymization)

**Date:** 2026-07-06
**Status:** Approved design (pending spec review) → next step is an implementation plan
**Scope:** A board-only chat assistant in `/admin` that answers natural-language questions grounded
in the document library, with a reversible PII pseudonymization layer so real resident data is not
sent to Anthropic.

---

## 1. Goal & non-goals

**Goal.** Give board members a chat surface in the admin panel that answers questions over the
neighborhood's ~489 documents (governing docs, financials, bank statements, policies) using
retrieval-augmented generation, with citations back to the source files, and **without disclosing
known resident PII to the third-party LLM**.

**In scope (v1):**

- Board-only (`requireBoard`, fail-closed) chat endpoint + admin UI, streamed answers (SSE).
- Retrieval via **Cloudflare AI Search** (managed RAG) over the existing `ashebrook-hoa-docs` R2 bucket.
- Generation via **Claude Opus 4.8** (`@anthropic-ai/sdk`).
- **Reversible PII pseudonymization** between retrieval and Claude: real → realistic surrogate → Claude
  → surrogate answer → real answer shown to the board.
- Citations mapped from retrieved chunks back to the real D1 document rows and the existing gated
  `/api/files/[id]` download route.

**Out of scope (v1) — recorded, not built:**

- Conversation persistence (chat is ephemeral; the client replays recent history each turn — the
  Claude API is stateless anyway). No new D1 table.
- Auto-reindex hook on document upload (the AI Search 6-hour auto-refresh + manual "Force Sync" in the
  dashboard is sufficient).
- `.xlsx` handling (AI Search indexes PDF/CSV/etc. but not xlsx — a few roster/export spreadsheets
  won't be searchable).
- A Workers-AI NER detection pass (roster dictionary + regex only — see §4).
- Homeowner-facing access; category-level exclusion of documents from the index.

---

## 2. Architecture & request flow

Cloudflare AI Search runs **inside the site's own Cloudflare account** — indexing, embeddings, and
vector search never leave it. The only new third-party hop is *retrieved chunks → Anthropic*. The
pseudonymization boundary is placed exactly there, so retrieval still runs against **real** text
(accurate matches) and only surrogates cross to Claude.

```
Board member (admin “Assistant” tab)
    │  POST /api/admin/assistant  { question, history }
    ▼
requireBoard(locals, request, env)            ← fail-closed; 403 for anyone else
    │  validate + cap question (INPUT_LIMITS)
    ▼
env.AI.autorag(AI_SEARCH_INSTANCE).search({ query })   ← REAL text, stays in Cloudflare
    │   → chunks: { content, score, metadata.filename, metadata.folder }
    │
    ├─ sources.ts: folder `documents/<uuid>/…` → D1 doc row → { id, title, category, href }
    │              (deduped; NOT PII; shown to the board as real links)
    │              → emit SSE `sources` event immediately
    │
    ├─ pii.ts: build per-request pseudonymizer from the D1 roster (owners + properties)
    │          anonymize(chunks) and anonymize(question) and anonymize(history)
    ▼
Claude Opus 4.8 (streaming)                    ← sees ONLY surrogate PII
    │   system prompt + numbered surrogate chunks + surrogate history + surrogate question
    │   → surrogate answer tokens
    ▼
DeanonymizeStream (hold-back = longest surrogate length)  ← surrogate → real, cross-chunk safe
    │   → emit SSE `token` events (real text)
    ▼
SSE `done` → Admin UI shows real answer + real source links
```

Per-request maps are **in-memory and discarded** after the response.

---

## 3. Components

### 3.1 Server (`src/server/ai/` — new)

- **`search.ts`** — `retrieve(env, query): Promise<Chunk[]>`. Thin wrapper over
  `env.AI.autorag(env.AI_SEARCH_INSTANCE).search({ query, max_num_results, ranking_options })`.
  Returns raw chunks (content + metadata). Wraps `AutoRAGNotFoundError` / `AutoRAGUnauthorizedError`
  into a typed "search unavailable" error.
- **`sources.ts`** — `toSources(env, chunks): Promise<Source[]>`. Parses the `<uuid>` out of each
  chunk's `documents/<uuid>/…` folder, looks the ids up in D1 `documents`, returns
  `{ id, title, category, href: '/api/files/<id>' }`, deduped, best-score order. Sources are board
  metadata, **shown real** and never sent to Claude.
- **`pii.ts`** — the pseudonymization layer (see §4).
- **`anthropic.ts`** — `getAnthropic(env)`: constructs `new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })`
  from `@anthropic-ai/sdk` (new dependency; works on Workers via fetch). Throws a typed
  "assistant not configured" error if the key is absent.
- **`assistant.ts`** — orchestration: `answer(env, { question, history }) →
  { sources, stream }`. Retrieves, builds the pseudonymizer, anonymizes, calls Claude with streaming,
  and returns the **de-anonymized** text stream plus the real `sources`.

### 3.2 Endpoint (`src/pages/api/admin/assistant.ts` — new)

- `POST`, `export const prerender = false`.
- `requireBoard(locals, request, env)` first — fail-closed.
- Body via `readJson`/`stringField` (`src/server/http.ts`); `question` trimmed and capped
  (`INPUT_LIMITS.assistantQuestion`, e.g. 2000 chars); optional `history: {role, content}[]` capped in
  count and per-message length. Malformed body → 400.
- Returns a `Response` whose body is a `ReadableStream` of **Server-Sent Events**:
  - `event: sources` — `data: Source[]` (emitted first, right after retrieval).
  - `event: token` — `data: { text }` (de-anonymized deltas, streamed).
  - `event: done` — end of turn.
  - `event: error` — `data: { message }` (friendly; see §6).

### 3.3 Admin UI (`src/components/admin/AssistantChat.tsx` — new)

- A new **Assistant** section wired into `AdminApp.tsx` and its nav.
- Chat panel: message list, textarea, send button. Holds recent turns in component state and replays
  them as `history` (client-side only — no persistence).
- On send: `fetch` the endpoint, read the SSE stream, render `token` deltas progressively, render
  `sources` as links to `/api/files/[id]` (board-accessible via the existing gated download route).
- Standing disclaimer: *"AI-generated from your documents — verify important details before acting.
  Scanned or spreadsheet content may be incomplete, and answers can be wrong."*

---

## 4. PII pseudonymization (`src/server/ai/pii.ts`)

**Decision:** detection = **roster dictionary + regex**; surrogates = **realistic, consistent,
reversible**.

### 4.1 Building the map (per request)

Load the roster from D1: `owners.fullName`, `owners.phone`, `owners.email`,
`properties.address` (+ `addressNormalized`). For each real value assign a **stable, type-preserving,
collision-free surrogate**:

- name → a fake full name (first+last from bundled pools)
- address → a fake street address
- phone → a fake NANP number
- email → a fake `first.last@example.org`-style address

Surrogates are assigned **deterministically by roster order** (owner #1 → surrogate #1, …) so they are
stable across turns and never collide, and are checked to not equal any real roster value. The module
keeps forward (`real → surrogate`) and reverse (`surrogate → real`) maps.

### 4.2 `anonymize(text)` — the privacy-critical direction

Single-pass, span-based replacement (collect all match spans, drop overlaps keeping the **longest**,
replace once) so replacements never corrupt each other:

1. **Emails** — regex; each match → surrogate (roster email if known, else a freshly generated
   surrogate recorded for this request). Catches non-resident emails too.
2. **Phones** — regex with normalization (strip to digits, match against normalized roster phones);
   each match → surrogate. Catches non-resident phones too.
3. **Addresses** — dictionary (raw + normalized forms), longest-first.
4. **Names** — dictionary of roster full names, word-boundary aware, longest-first.

Applied to retrieved **chunks**, the **question**, and replayed **history** with the same map instance,
so the same real entity gets the same surrogate everywhere Claude sees it.

### 4.3 `deanonymize(text)` / `DeanonymizeStream` — the cosmetic direction

Reverse-map surrogate → real, longest-first. On the stream, a `TransformStream` buffers a **hold-back
window = the longest surrogate length**, so a surrogate split across two token deltas
("Michael" + " Jones") is still replaced before its region is emitted. The final flush de-anonymizes
the remainder. The board never sees a surrogate under normal operation.

### 4.4 What this guarantees — and does not

**Favorable asymmetry.** The privacy property depends only on **inbound** completeness (`anonymize`):
if de-anon misses outbound, the board merely sees a fake name — cosmetic, not a leak.

**Reliably scrubbed inbound:** every **known resident** name/phone/email/address (roster) + **any**
email or phone anywhere (regex).

**Not scrubbed (documented residual exposure to Anthropic):**

- Non-resident **names** (management-company staff, bank signatories, vendors) — not in the roster.
- Standalone first names / surnames / nicknames not matching a roster full name.
- PII inside **OCR-garbled** scanned pages (broken text won't dictionary-match).
- Quasi-identifiers (identifiable by description rather than by a direct identifier).

Therefore SECURITY.md will describe this as **"best-effort pseudonymization of known resident PII,"**
never "no PII is sent to Anthropic." Non-PII document content (financial figures, policy text) is still
sent to Claude by design.

---

## 5. Claude prompt & model

- Model **`claude-opus-4-8`**, streaming, `thinking: { type: 'adaptive' }`, `max_tokens` ≈ 4000.
- **Chunks are labeled by index** in the prompt (`[Source 1]`, `[Source 2]`, …) — document **titles
  are not sent to Claude** (a title could contain a name); citations map index → real doc server-side.
- System prompt (surrogate-safe): answer **only** from the provided excerpts; cite the `[Source N]`
  labels used; if the answer isn't in the excerpts, say so plainly; do not invent facts; **use names
  and identifiers exactly as written — do not alter, abbreviate, or reformat them** (this protects
  outbound de-anon reliability).
- Handle `stop_reason: 'refusal'` before reading content (surface a friendly message).

---

## 6. Error handling (fail-closed / friendly)

| Condition | Response |
| --- | --- |
| Caller not board | 403 (fail-closed, via `requireBoard`) |
| `ANTHROPIC_API_KEY` or `AI` binding missing | 500 "assistant isn't configured" (no internal detail leaked) |
| AI Search unavailable (`AutoRAG*Error`) | 503 "document search is temporarily unavailable" |
| Empty retrieval | Answer states nothing relevant was found (system prompt) |
| Anthropic refusal / 429 / 5xx | Friendly `error` SSE; SDK auto-retries 429/5xx |
| Malformed body / over-length | 400 |

---

## 7. Config & one-time operator setup

- **`wrangler.toml`**: add `[ai]\nbinding = "AI"`, and `AI_SEARCH_INSTANCE = "<name>"` under `[vars]`.
- **Secret**: `wrangler secret put ANTHROPIC_API_KEY`.
- **`src/env.d.ts`**: add `AI: Ai`, `AI_SEARCH_INSTANCE: string`, `ANTHROPIC_API_KEY: string` to
  `Cloudflare.Env` (augment the `Ai` type with `.autorag()` if the installed `@cloudflare/workers-types`
  version lacks it).
- **Dashboard (operator, one-time)**: create an AI Search instance pointing at the
  **`ashebrook-hoa-docs`** R2 bucket; let the initial index build; note the 4 MB/file cap and that
  `.xlsx` won't index. Documented in SETUP.md.
- **Adapter note**: the root `wrangler.toml` has no `main`; verify the `[ai]` binding and the new var
  are carried into the adapter-emitted `dist/server/wrangler.json` at build.

---

## 8. Testing

**Unit (jsdom, `test/unit/**`):**

- `pii.ts`: `anonymize` replaces roster names/addresses/phones/emails and regex emails/phones;
  `deanonymize` round-trips; overlapping/substring safety (single-pass span replacement);
  surrogate/real collision avoidance; `DeanonymizeStream` reassembles a surrogate split across chunks.
- `sources.ts`: `documents/<uuid>/…` → real doc link mapping + dedupe.
- `AssistantChat.tsx`: renders, sends, displays streamed `token` deltas and `sources` links (mock
  fetch/SSE).

**Server (vitest-pool-workers, `test/server/**`):** `/api/admin/assistant` with `env.AI.autorag`
mocked to return canned chunks and the Anthropic client `vi.mock`'d (repo's sender-mock pattern):

- 403 for a non-board caller (fail-closed); 400 for malformed body.
- **Privacy guardrail (critical):** assert the payload handed to the mocked Anthropic client contains
  **none** of the seeded roster's real names/phones/emails/addresses.
- Happy path: `sources` resolve to the right docs; streamed answer is **de-anonymized** (surrogates
  mapped back).

---

## 9. Docs to update

- **CLAUDE.md**: new `src/server/ai/`, the `/api/admin/assistant` endpoint, the `AI` binding + AI Search.
- **SETUP.md**: AI Search instance creation, `ANTHROPIC_API_KEY` secret, `AI_SEARCH_INSTANCE` var, the
  pseudonymization behavior + its honest limits.
- **SECURITY.md**: board-only assistant; document content is sent to Anthropic for generation;
  **best-effort** pseudonymization of known resident PII and what it does not cover; ties to the
  existing PII stance (§4.8 / SETUP.md §5).
- **CHANGELOG.md** `[Unreleased]`: `### Added` (assistant) + `### Security` (pseudonymization).

---

## 10. Risks & open questions

- **R1 — Incomplete inbound scrubbing.** Residual non-resident / OCR / quasi-identifier PII reaches
  Anthropic. Mitigation: honest SECURITY.md wording; regex catches all emails/phones; a Workers-AI NER
  pass is a documented future enhancement, not v1.
- **R2 — `Ai.autorag` typing.** If the installed workers-types lacks `.autorag()`, add a local type
  augmentation. Verify the `[ai]` binding surfaces through the Astro Cloudflare adapter.
- **R3 — Streaming de-anon correctness.** The hold-back window must be ≥ the longest surrogate; unit
  test the split-surrogate case explicitly.
- **R4 — Retrieval quality on scanned/xlsx.** Accepted "best-effort"; disclaimer in the UI.
- **R5 — Cost.** Opus 4.8 per query at board-query volume is negligible; Haiku 4.5 is a one-line swap
  if that ever changes.
- **Q1 — Effort/thinking.** Start with adaptive thinking; revisit if latency or answer depth needs it.
```
