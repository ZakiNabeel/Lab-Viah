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
| `onboarding_flow` | `POST /onboarding/finalize` (also drives layers 1–4) | Onboarding, Twin Forge, Wali (optional) |
| `find_matches` | `POST /match/request` | Prescreen, User Twin, Candidate Twin (×N), Moderator |
| `book_meeting` | `POST /book/initiate` | Wali, Booking |
| `handle_dispute` | `POST /dispute/file` | Dispute |

### 2.2 Agent
An agent is a TypeScript module in `src/agents/` that owns one role. Every agent:
- Takes a typed input.
- Emits **observations** (what it sees) and **decisions** (what it chose + rationale) to the trace.
- Calls only registered tools.
- Returns a typed output.

The eight agents are specified in `MASTERPLAN.md` section 5. No other agents may be added without updating the MASTERPLAN.

### 2.3 Tool
A tool is anything an agent can call that has side effects or talks to a non-deterministic service. Every tool:
- Lives in `src/tools/` (external services) or `src/agents/_shared/` (cross-agent shared like Gemini).
- Has typed input + typed output (Zod).
- Has a retry policy declared at the call site.
- Has a fallback path documented in `MASTERPLAN.md` section 9.
- Emits `tool.call` and `tool.result` trace events automatically — agents do not emit these manually.

Tools registered for Session 1+: `geminiCall`, `supabaseRead`, `supabaseWrite`, `sttTranscribe`, `ttsSynthesize`, `mapsFindVenue`, `smsRender`, `calendarMock`.

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

---

## 5. Mock vs real (no real PII, no real side effects)

Per `MASTERPLAN.md` §1 non-negotiables 8 and 9:

| Tool | Mode in this build |
|---|---|
| Gemini (text) | Real. Live LLM calls. |
| Cloud STT | Real. Audio chunks → transcript. |
| Cloud TTS | Real. Wali brief → MP3. |
| Maps Places | Real for venue lookups, hardcoded fallback per city. |
| Supabase | Real. Free-tier project. |
| SMS | **Mocked.** `smsRender` returns a rendered SMS body to the client; nothing leaves the server. |
| Wali phone | **Mocked.** Numbers in seed data are fictional. |
| Calendar | **Mocked.** `calendarMock` returns fake availability windows. |
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

Each file is newline-delimited JSON, one `TraceEvent` per line, in chronological order. The Supabase `traces` row is the source of truth; the JSONL files are dumps.

The export script lives at `scripts/export-traces.ts` (Session 5 deliverable).

---

## 8. What Antigravity does NOT do for us

To prevent confusion:
- Antigravity is not the auth layer. Supabase handles auth.
- Antigravity is not the DB. Supabase is.
- Antigravity is not the HTTP server. Fastify is.
- Antigravity is the **orchestration spine** between Fastify and the agents, plus the **trace observer** for everything they do.

If a task does not involve multi-step agent reasoning or a tool with side effects, it does not need a workplan. CRUD endpoints (`/twin/me`, `/health`) call Supabase directly and emit nothing.

---

*End of ANTIGRAVITY.md. Last touched: Session 1 draft.*
