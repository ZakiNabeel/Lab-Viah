# ANTIGRAVITY.md — How RishtaAI Uses Google Antigravity

> **Read this file alongside `MASTERPLAN.md`.**
> This file documents how the RishtaAI backend is wired into Google Antigravity for the hackathon. It defines the workplan / agent / tool / trace contract that the rest of the code conforms to.
>
> If anything in this file conflicts with `MASTERPLAN.md`, the MASTERPLAN wins and this file gets updated.

---

## 1. Why Antigravity is mandatory

Challenge 2 of the Google Antigravity Hackathon 2026 explicitly requires that the AI service orchestrator be expressed as **workplans + agents + tools + traces** inside Antigravity. The hackathon trace deliverable is a 20% slice of the score; if our traces are empty or shallow, we lose.

Every multi-step flow in this backend is therefore expressed as an **Antigravity workplan** — never as a plain function. Every agent decision emits a **TraceEvent**. Every external call goes through the **tool registry**.

If you find yourself about to write code that bypasses this contract, stop and flag it.

---

## 2. The four primitives

### 2.1 Workplan
A workplan is a TypeScript file in `src/workplans/` that declares:
- A **goal** (one sentence).
- **Constraints** (latency budget, retry policy, recovery behaviour).
- A **task graph** — ordered or parallel tasks, each of which delegates to one or more agents.
- An **outcome** schema (Zod) that the workplan resolves to.

Workplans are the unit of observability. One workplan → one row in `traces` table → one exportable trace artifact.

The four workplans we ship:

| Workplan | Trigger | Agents involved |
|---|---|---|
| `onboarding_flow` | Spans 5 HTTP calls: `POST /onboarding/layer1`, `layer2`, `layer3`, `wali`, `finalize`. One trace per user journey; `sessionId === flowId` across all calls. | Onboarding, Twin Forge, Wali (optional) |
| `find_matches` | `POST /match/request` | Moderator (unified per-dim call voices both Twins + scores); User Twin + Candidate Twin agents are not on the critical path — see §9 |
| `book_meeting` | `POST /book/initiate` (async, Phase 1) + `POST /book/confirm` (sync, Phase 2) | Wali, Booking |
| `handle_dispute` | `POST /dispute/file` | Dispute |

### 2.2 Agent
An agent is a TypeScript module in `src/agents/` that owns one role. Every agent:
- Takes a typed input.
- Emits **observations** (what it sees) and **decisions** (what it chose + rationale) to the trace.
- Calls only registered tools.
- Returns a typed output.

The eight as-shipped agents (details in `MASTERPLAN.md` §5):

| Agent | As-shipped role |
|---|---|
| Onboarding | Gemini-backed interview conductor; chip-fallback recovery on STT low-confidence or malformed JSON. |
| Twin Forge | Three entry points: `forgeTwin` (initial synthesis, v1), `generateLayer3Statements`, `reconcileWaliConflicts` (flags conflicts, does NOT auto-resolve — MASTERPLAN §5.2). Fourth entry: `forgeTwinV2` — post-meeting feedback → increments `version`. |
| User Twin | Gemini-backed, `system_prompt` injected via `systemInstruction`. Exported per MASTERPLAN §5.3 but NOT on the `find_matches` workplan critical path — the Moderator's unified per-dim call renders both Twin statements. |
| Candidate Twin | Thin wrapper over `runTwinTurn` with `side='candidate_twin'`. Same critical-path note as User Twin. |
| Moderator | 8-dim debate loop; 1 unified Gemini Flash call per dim (voices both Twins + scoring). 60 s per-debate self-budget + `recover` on overflow. Final synthesis on Pro (1 call per debate, 5 per workplan). |
| Wali | Bilingual (EN + user's native UR/RO_UR) rishta brief; Pro tier; 2 language calls + 2 TTS calls in parallel. Mock SMS rendered to both walis. |
| Booking | Two entry points: `proposeSlots` (calendar + venue in parallel) and `finalizeMeeting` (locks chosen slot/venue, schedules reminders). |
| Dispute | Single Gemini Pro call; 1-5 severity, 5 action types; deterministic fallback resolution on failure. |

No other agents may be added without updating the MASTERPLAN.

### 2.3 Tool
A tool is anything an agent can call that has side effects or talks to a non-deterministic service. Every tool:
- Lives in `src/tools/` (external services) or `src/agents/_shared/` (cross-agent shared like Gemini).
- Has typed input + typed output (Zod).
- Has a retry policy declared at the call site.
- Has a fallback path documented in `MASTERPLAN.md` section 9.
- Emits `tool.call` and `tool.result` trace events automatically — agents do not emit these manually.

Tools registered: `geminiCall`, `supabaseRead`, `supabaseWrite`, `sttTranscribe`, `ttsSynthesize`, `mapsFindVenue`, `smsRender`, `calendarMock`.

Notes:
- `sttTranscribe` is a **stub** — `attemptStt` always returns `{lowConfidence: true, stub: true}`. The chip-fallback recovery in the Onboarding Agent IS the demo's visible recovery for this tool. Replacing the stub body is the only change needed when real Cloud Speech-to-Text is wired.
- `ttsSynthesize` uses `@google-cloud/text-to-speech` (added Session 4). Falls back to text-only with a `recover` event when GCP credentials are missing or both attempts fail.

### 2.4 Trace
A trace is the chronological stream of events emitted during one workplan run. Events conform to the `TraceEvent` union in `src/agents/_shared/types.ts`. They flow through three sinks simultaneously:

1. **In-memory bus** → forwarded to the SSE endpoint `/stream/:flowId` for the mobile app.
2. **Pino logger** → structured JSON to stdout for local debug and Railway logs.
3. **Supabase `traces` table** → persisted at workplan end, includes the full ordered event array. This is the exportable trace artifact submitted to the hackathon judges.

---

## 3. The TraceEvent contract

Defined once in `src/agents/_shared/types.ts`. All eleven event types:

```ts
type TraceEvent =
  | { type: 'workplan.started'; workplan: string; flowId: string; ts: number }
  | { type: 'task.started'; task: string; ts: number }
  | { type: 'agent.observation'; agent: string; observation: string; ts: number }
  | { type: 'agent.decision'; agent: string; decision: string; rationale: string; ts: number }
  | { type: 'tool.call'; tool: string; args: unknown; ts: number }
  | { type: 'tool.result'; tool: string; result: unknown; latency_ms: number; ts: number }
  | { type: 'agent.message'; agent: string; content: string; ts: number }
  | { type: 'dimension.scored'; dimension: string; score: number; evidence: string; ts: number }
  | { type: 'recovery'; reason: string; action: string; ts: number }
  | { type: 'task.finished'; task: string; outcome: unknown; ts: number }
  | { type: 'workplan.finished'; outcome: unknown; ts: number };
```

**Rules:**
- An agent emits `agent.observation` and `agent.decision`. Tool events are emitted by the tool registry, not the agent.
- A `recovery` event is mandatory whenever a retry succeeds, a fallback fires, or a partial result is salvaged. At least one demo workplan must surface a recovery.
- `workplan.started` is paired with exactly one `workplan.finished`. Same for `task.started` / `task.finished`.
- Timestamps are `Date.now()` milliseconds. Order in the stream is wall-clock order.

---

## 4. How a request flows through Antigravity

Concrete example: `POST /match/request`.

```
1. Fastify route handler validates input (Zod), grabs user_id from JWT.
2. Handler calls runWorkplan('find_matches', { userId }) → returns { flowId }.
3. runWorkplan:
   a. Creates a TraceBus instance keyed by flowId.
   b. Inserts a row in `traces` (started_at, workplan, user_id).
   c. Emits workplan.started.
   d. Spawns the task graph (loadUserTwin → prescreen → parallel debates → rank → persist).
   e. For each task: emit task.started → call agent(s) → emit task.finished.
   f. Agents emit observation/decision via the TraceBus.
   g. Tool registry wraps every tool call with tool.call + tool.result emissions.
   h. On completion: emit workplan.finished, update the `traces` row, close the SSE.
4. Handler returns { ok: true, data: { flowId } } immediately (workplan runs async).
5. Mobile client opens `GET /stream/:flowId` and renders events live.
6. Mobile client polls `GET /match/results/:flowId` (or reads workplan.finished from SSE).
```

The `TraceBus` is the single chokepoint that every event goes through. There is no other path to the trace.

**Exception — `POST /book/initiate`:** the route awaits `meetingIdPromise` (which resolves only after the meetings row is inserted in step 5) before it returns. By the time the mobile client subscribes to `GET /stream/:flowId`, the trace bus has already closed. The SSE consumer therefore catches only the final `workplan.finished` event. The full trace is still persisted in the `traces` table and readable via Supabase. The `POST /match/request` flow is unaffected — that route returns `flowId` before any workplan work starts.

---

## 5. Mock vs real (no real PII, no real side effects)

Per `MASTERPLAN.md` §1 non-negotiables 8 and 9:

| Tool | Mode in this build |
|---|---|
| Vertex AI (Gemini) | Real. Live calls via `@google/genai` against project `lab-viah` / `us-central1`. Primary model: `gemini-2.5-pro`; fallback: `gemini-2.5-flash`. Flash has `thinkingBudget: 0`; Pro keeps default thinking. |
| Cloud STT | **Stub.** `sttTranscribe` always returns `{lowConfidence: true, stub: true}`. Chip-fallback fires and IS the demo's visible recovery. |
| Cloud TTS | Real when `GOOGLE_APPLICATION_CREDENTIALS` is set (`@google-cloud/text-to-speech`). Falls back to text-only with a `recover` event when credentials are absent or both attempts fail. Wali brief → base64 `data:audio/mp3` URI. |
| Maps Places | Real for venue lookups (`places:searchText` via fetch against Places API v1, `regionCode: PK/AE`). Hardcoded city fallback (Karachi/Lahore/Islamabad/Multan/Dubai) when key is missing or API returns insufficient results — every fallback branch emits a `recover` event. |
| Supabase | Real. Free-tier project `lab-viah`. |
| SMS | **Mocked.** `smsRender` returns a rendered SMS body to the client; nothing leaves the server. |
| Wali phone | **Mocked.** Numbers in seed data are fictional. |
| Calendar | **Mocked.** `calendarMock` returns deterministic availability windows (PRNG seeded by phone-pair hash). |
| Payments | Out of scope. Not in any tool. |

Mocked tools still emit `tool.call` and `tool.result` events. The trace must read like a real run.

---

## 6. Working inside Antigravity (the IDE)

We use Antigravity in two modes:

- **Manager view** — for multi-file scaffolds, refactors, and parallel agent wiring. Use this when the task spans 3+ files. Label every workplan with the session number so we can audit later.
- **Editor view (Claude Sonnet 4.6)** — for surgical edits: one logic gate, one schema column, one prompt tweak. Sonnet has better precision than the orchestrator agent for small diffs.

When a long task is delegated to an Antigravity agent, the prompt MUST include:
1. The relevant `MASTERPLAN.md` section number.
2. The trace contract from §3 of this file.
3. A definition-of-done from `MASTERPLAN.md` §12.

Auto-commit is fine for additive work. Show a diff before any destructive change.

---

## 7. Trace export (the hackathon deliverable)

At Session 5 we export one trace per workplan to `/traces/` in the repo root:

```
traces/
├── onboarding_flow__01.jsonl
├── find_matches__hero_scenario_C.jsonl
├── book_meeting__01.jsonl
├── handle_dispute__01.jsonl
└── recovery__moderator_timeout.jsonl   # the visible-recovery exemplar
```

Each file is newline-delimited JSON, one `TraceEvent` per line, in chronological order. The Supabase `traces` row is the source of truth; the JSONL files are dumps. The `traces.events` column is already chronological (populated by `bus.events()` at workplan close).

The export script lives at `scripts/export-traces.ts` and is run via `npm run export-traces`. It reads from the `traces` Supabase table and writes the JSONL files to `traces/`.

See `docs/COSTS.md` for the per-operation cost analysis (10×, 100×, 1000× scale projections).

---

## 8. What Antigravity does NOT do for us

To prevent confusion:
- Antigravity is not the auth layer. Supabase handles auth.
- Antigravity is not the DB. Supabase is.
- Antigravity is not the HTTP server. Fastify is.
- Antigravity is the **orchestration spine** between Fastify and the agents, plus the **trace observer** for everything they do.

If a task does not involve multi-step agent reasoning or a tool with side effects, it does not need a workplan. CRUD endpoints (`/twin/me`, `/health`) call Supabase directly and emit nothing.

`POST /feedback/post-meeting` is intentionally workplan-free. It is a single Gemini Pro call + deterministic weight adjustment + one Supabase insert — CRUD-ish with no branching task graph. Pino structured logs cover decision auditing for this endpoint; no row is written to the `traces` table. The `forgeTwinV2` function in Twin Forge is the only path that increments `TwinSpec.version`.

---

## 9. As-shipped deviations from spec

Brief record of where the implementation diverged from MASTERPLAN intent, and why.

| Item | Spec | As-shipped | Why |
|---|---|---|---|
| Per-dim Moderator calls | 3 separate calls (user_twin → candidate_twin → scoring) | 1 unified call per dim | Vertex burst pressure under 5-parallel debates (Session 3). Agent files preserved per MASTERPLAN §5.3. |
| Final synthesis tier | (unspecified) | Pro after Session 4 quota uplift; Flash before | Quality matters; 5 calls per workplan is low volume. |
| MAX_CONCURRENT | (unspecified) | 10 (raised from 3 in Session 4) | Billing-enabled Vertex 300 RPM provides headroom; 3 was the hackathon-quota safety value. |
| `thinkingBudget` on Flash | (default) | 0 on Flash | Default thinking ate ~80% of the token budget and truncated JSON mid-string. Pro keeps default thinking. |
| `/book/initiate` SSE | Live-stream workplan events | Client catches only `workplan.finished` | Route awaits `meetingIdPromise` before returning; bus is already closed when client subscribes. Trace persisted in DB regardless. |
| `/feedback/post-meeting` | (unspecified) | No workplan / no `traces` row | CRUD-ish, 1 Gemini call; Pino logs cover audit trail. |
| STT | Real Google Cloud Speech | Stub — always returns `lowConfidence: true` | Avoided adding `@google-cloud/speech` as a new dep; chip-fallback IS the demo's visible recovery. |

---

*End of ANTIGRAVITY.md. Last touched: Session 5 (2026-05-18) — ship day final pass.*
