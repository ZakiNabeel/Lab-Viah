# RishtaAI Backend

> Submission for **Challenge 2 — AI Service Orchestrator for the Informal Economy**, Google Antigravity Hackathon 2026.
>
> RishtaAI is an 8-agent matchmaking service for the Pakistani rishta market, orchestrated end-to-end inside Google Antigravity. The mobile app (Expo, separate repo) consumes a Fastify REST + Server-Sent Events API; every multi-step flow is a typed Antigravity workplan with a chronological trace that streams live to the client and persists to Postgres.

---

## 1. What it does (one screen)

A Pakistani user opens the app, speaks or types their preferences in English, Urdu, or Roman Urdu, and is guided through a four-layer onboarding that builds a **Twin** — a structured JSON persona encoding 8 compatibility dimensions, dealbreakers, and a 400-word AI voice. The backend then runs a five-candidate Twin-to-Twin debate orchestrated by a Moderator agent, scores each candidate across all 8 dimensions, and returns ranked match cards. Once the user selects a match, a Wali Agent produces a bilingual rishta brief with TTS audio, a Booking Agent finds a halal-friendly venue and proposes meeting slots, and a Dispute Agent handles any post-meeting grievances.

```
┌──────────────────────────────────────────────────────────────┐
│  EXPO MOBILE CLIENT (handled by frontend team)               │
│  Onboarding · Match cards · Live debate · Booking · Wali UI  │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTPS REST + SSE
                         │
┌────────────────────────▼─────────────────────────────────────┐
│  API GATEWAY  (Fastify, Node 20, TypeScript)                  │
│  /auth   /onboarding   /twin   /match   /book   /dispute      │
│  /stream/:flowId   (Server-Sent Events for live agent traces) │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│  ANTIGRAVITY ORCHESTRATION LAYER                              │
│                                                               │
│  Workplans:  onboarding_flow · find_matches · book_meeting    │
│              handle_dispute                                   │
│                                                               │
│  Agents:  Onboarding · Twin Forge · User Twin · Candidate     │
│           Twin · Moderator · Wali · Booking · Dispute         │
│                                                               │
│  Tool registry:  Gemini call · Cloud STT · Cloud TTS ·        │
│                  Supabase read/write · Maps Places · SMS      │
│                  template · Calendar mock                     │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│  DATA LAYER                                                   │
│  Supabase Postgres · Supabase Auth · Supabase Storage         │
│  Google Cloud Speech / TTS · Google Maps Places               │
└──────────────────────────────────────────────────────────────┘
```

**One sentence:** Mobile hits Fastify → Fastify kicks off an Antigravity workplan → workplan delegates to agents → agents call Gemini and other tools → results stream back via SSE → final state lands in Supabase.

---

## 2. Why it qualifies for Challenge 2

- **8 distinct agents** — Onboarding, Twin Forge, User Twin, Candidate Twin, Moderator, Wali, Booking, Dispute (see section 5 for roles).
- **4 Antigravity workplans** — `onboarding_flow`, `find_matches`, `book_meeting`, `handle_dispute` — each with a typed goal, constraint budget, task graph, and outcome schema.
- **7 registered tools** with retry + visible-recovery fallback: `geminiCall`, `sttTranscribe`, `ttsSynthesize`, `mapsFindVenue`, `smsRender`, `calendarMock`, `supabaseRead/Write`.
- **One persisted trace per workplan run** — full ordered `TraceEvent[]` stored in the `traces` table; five exported JSONL files in `traces/` are the hackathon trace deliverable.
- **Baseline non-agentic ranker** (`GET /baseline/match`) demonstrates measurable agentic uplift: the hero scenario candidate Hina Raza ranks in the top-3 under cosine-baseline, but the agentic debate surfaces her hidden past-relationship dealbreaker and flips her recommendation to `not_recommended` (see section 10).

---

## 3. Architecture

See the diagram in section 1. The core flow for a match request:

1. `POST /match/request` validates input, creates a `TraceBus` keyed by `flowId`, returns `flowId` immediately.
2. The `find_matches` workplan runs async: prescreen 12 candidates → parallel 5-candidate debates → rank → persist.
3. Each debate is 8 Moderator-orchestrated Gemini calls (one per compatibility dimension), each emitting `dimension.scored` events to the SSE stream.
4. Workplan closes by writing the full event array to `traces.events` and updating `compatibility_reports`.
5. Mobile client polls `GET /match/results/:flowId` or reads `workplan.finished` from SSE.

### Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| HTTP framework | Fastify 4 |
| Language | TypeScript 5 (strict, `noUncheckedIndexedAccess`) |
| DB client | `@supabase/supabase-js` v2 |
| Database | Supabase Postgres + pgvector extension |
| Auth | Supabase phone OTP (dev-bypass mode for hackathon — see `.env.example`) |
| LLM | `@google/genai` v1 on Vertex AI (`gemini-2.5-pro` primary, `gemini-2.5-flash` fallback) |
| TTS | `@google-cloud/text-to-speech` v6 (Urdu + English voices) |
| Validation | Zod |
| Logging | Pino (structured JSON; pipes into Antigravity trace format) |
| Testing | Vitest |
| Deploy | Railway (API) + Supabase (DB) |

Note: the LLM SDK is `@google/genai` (not the deprecated `@google-cloud/vertexai`, which is removed 2026-06-24). Auth is Application Default Credentials via `GOOGLE_APPLICATION_CREDENTIALS`.

---

## 4. API surface (15 endpoints)

All endpoints return `{ ok: boolean, data?, error? }`. Authenticated endpoints require `Authorization: Bearer <supabase-jwt>`.

| Method | Path | Purpose | Status |
|---|---|---|---|
| POST | `/auth/otp/start` | Send OTP to phone (dev-bypass when `DEV_OTP_BYPASS=true`) | shipped |
| POST | `/auth/otp/verify` | Verify OTP, return Supabase JWT | shipped |
| POST | `/onboarding/layer1` | Voice/text intro chat turn; returns next prompt + confidence | shipped |
| POST | `/onboarding/layer2` | Scenario card response; returns updated radar vector | shipped |
| POST | `/onboarding/layer3` | Twin Interview — generate statements OR apply user corrections | shipped |
| POST | `/onboarding/wali` | Optional Wali Mode input; conflicts flagged, not auto-resolved | shipped |
| POST | `/onboarding/finalize` | Lock Twin v1.0; persists spec + embedding to Supabase | shipped |
| GET | `/twin/me` | Return current user's Twin spec | deferred (Session 5 nice-to-have — see SESSION_CONTEXT.md §6) |
| POST | `/match/request` | Kick off `find_matches` workplan; returns `flowId` immediately | shipped |
| GET | `/stream/:flowId` | SSE stream of agent trace events | shipped |
| GET | `/match/results/:flowId` | Top-3 CompatibilityReports once workplan finishes | shipped |
| POST | `/book/initiate` | Start `book_meeting` workplan: wali brief + slot proposals | shipped |
| POST | `/book/confirm` | Confirm slot; persists meeting, schedules reminders, renders SMS | shipped |
| POST | `/dispute/file` | File a dispute; kicks off `handle_dispute` workplan | shipped |
| POST | `/feedback/post-meeting` | 4-dimension rating; feeds Twin Forge v2 weight adjustment | shipped |
| GET | `/baseline/match` | Non-agentic weighted-distance ranker (required deliverable) | shipped |
| GET | `/health` | Liveness probe | shipped |
| GET | `/health/deep` | Liveness + Supabase + Vertex AI connectivity | shipped |

14 of the 15 MASTERPLAN endpoints are shipped. `/twin/me` is the only one deferred; it is a trivial read from the `twins` table (single-line handler) and is flagged as a Session 5 nice-to-have in SESSION_CONTEXT.md §6.

### SSE event shape

The `TraceEvent` union is defined in `src/agents/_shared/types.ts` and fully documented in `ANTIGRAVITY.md` §3. All 11 event types are emitted. See `ANTIGRAVITY.md` for the rule set (pairing guarantees, `recovery` mandatory on fallback, timestamp semantics).

---

## 5. Antigravity wiring (workplan / agent / tool / trace)

See `ANTIGRAVITY.md` for the deep dive. Summary:

**Workplans** are TypeScript files in `src/workplans/` that declare a goal, constraint budget, and task graph. One workplan → one row in `traces` → one exportable trace artifact. The four workplans map to these triggers:

| Workplan | HTTP trigger | Agents involved |
|---|---|---|
| `onboarding_flow` | `POST /onboarding/finalize` | Onboarding, Twin Forge, Wali (optional) |
| `find_matches` | `POST /match/request` | Prescreen, User Twin, Candidate Twin (x5), Moderator |
| `book_meeting` | `POST /book/initiate` | Wali, Booking |
| `handle_dispute` | `POST /dispute/file` | Dispute |

**Agents** own a single role, take typed input, emit observations and decisions to the trace, and return typed output. No agent calls a Gemini client directly — all LLM calls go through the `geminiCall` tool wrapper.

**TraceBus** (`src/agents/_shared/trace.ts`) is the single chokepoint for every event. Three sinks fire simultaneously:

1. **In-memory bus** — forwarded to `GET /stream/:flowId` (SSE) for the mobile client.
2. **Pino** — structured JSON to stdout for Railway logs and local debug.
3. **Supabase `traces` table** — written at workplan close; includes the full ordered `events` JSONB array. This is the exportable trace artifact.

**Five exported trace files** in `traces/` (one per workplan + one recovery exemplar) are the hackathon trace deliverable. Regenerate with `npm run export-traces`. See `traces/INDEX.md` for which `traceId` was selected for each file and why.

---

## 6. Data model

Six Supabase tables. Authoritative DDL is `src/db/schema.sql`.

| Table | Purpose |
|---|---|
| `users` | Auth identity, phone, city, language preference, wali contact |
| `twins` | User twins AND the 12 seeded candidate twins; stores `spec` JSONB + pgvector 768-dim embedding |
| `compatibility_reports` | One row per debated candidate pair; dimension scores, dealbreakers hit, recommendation, full reasoning trace JSONB |
| `meetings` | Proposed and confirmed rishta meetings; slot, venue, wali contacts, reminder schedule, status |
| `disputes` | Post-meeting grievances; severity 1-5, resolution JSONB, reputation impact |
| `traces` | One row per workplan run; flattened event columns + full ordered `events` JSONB for export |

The `twins` table carries both real user twins (`is_candidate=false`) and the 12 fictional candidate personas (`is_candidate=true`). The `embedding` column (pgvector 768-dim, `ivfflat` index) supports cosine-similarity prescreen.

### Twin JSON spec

The heart of the system. Full TypeScript type definition in `src/domain/twin.ts`; authoritative prose spec in MASTERPLAN.md §6.2. Key fields:

- `identity` — name, age, gender, city.
- `deen_level` — `strict | practicing | moderate | cultural | secular`.
- `family_setup`, `family_loyalty_score`, `conflict_style`, `geography`.
- `career`, `finances`, `kids_timeline`.
- `dealbreakers[]` — explicit non-negotiables; any match triggers `not_recommended`.
- `dimension_weights` — user-stated importance per dimension, sums to 1.0; updated by post-meeting feedback.
- `system_prompt` — ~400-word AI voice generated by Twin Forge; injected as `systemInstruction` when the agent debates.
- `wali_override?` — partial override if Wali Mode used; conflicts flagged, never silently merged.

### Compatibility Report

Defined in `src/agents/_shared/types.ts` and MASTERPLAN.md §6.3. `recommendation` is one of `strong_match | conditional_match | not_recommended`. A single dealbreaker hit forces `not_recommended` regardless of weighted score.

---

## 7. The 8 compatibility dimensions

Defined in `src/domain/dimensions.ts`. Scored 0-1 by the Moderator after the per-dimension debate turn. Final score = sum of (dimension_score x user_weight). If any dealbreaker is hit, `recommendation` is forced to `not_recommended` regardless of the weighted total.

| Dimension | What it covers |
|---|---|
| `deen` | Shared religious practice and rigor level |
| `family` | Family dynamics, joint/nuclear expectations, in-law relations |
| `career` | Career trajectory, ambition alignment |
| `finances` | Financial outlook, lifestyle expectation match |
| `kids` | Kids timing and parenting philosophy |
| `conflict` | Disagreement and resolution style |
| `geography` | Current city and 10-year preference flexibility |
| `dealbreakers` | Explicit non-negotiables; binary hit-or-miss |

Dimension weights default to equal distribution but are user-stated at onboarding and refined by post-meeting feedback. Moderator scores each dimension with an `evidence` string (1-2 sentences visible in the UI) and a `friction_level` from `none | low | medium | high | dealbreaker`.

---

## 8. Setup — local development

### Prerequisites

- Node.js 20 LTS
- A Supabase project (free tier is sufficient)
- A GCP project with Vertex AI API (`aiplatform.googleapis.com`) and Cloud Text-to-Speech API (`texttospeech.googleapis.com`) enabled, billing enabled (so `gemini-2.5-pro` quota is non-zero)
- A service account JSON whose SA has `Vertex AI User` + `Cloud Text-to-Speech User` IAM roles on the GCP project

### Steps

```bash
git clone https://github.com/ZakiNabeel/Lab-Viah.git
cd Lab-Viah/backend
npm install

# Copy and fill env vars
cp .env.example .env
# Edit .env — at minimum fill in:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET
#   GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS (absolute path to service-account JSON)
# See .env.example for the full annotated list and important warnings
# (e.g. paste only the base Supabase URL, not the /rest/v1 suffix).

# Apply DB schema — one time only
# Open Supabase SQL Editor, paste src/db/schema.sql, run.
# Then seed the 12 fictional candidate twins:
npm run seed

# Start dev server
npm run dev
# Server starts on http://localhost:3000

# Smoke checks
curl http://localhost:3000/health
curl http://localhost:3000/health/deep        # checks Supabase + Vertex AI
npm test                                      # 6/6 happy-path tests
```

### Production build

```bash
npm run build     # tsc → dist/
npm start         # node --env-file=.env dist/server.js
```

Deploy target is Railway. Configure all env vars from `.env.example` in the Railway service settings. Schema migrations run once against the production Supabase project via SQL Editor.

---

## 9. Trace export

Five JSONL files in `traces/` — one event per line, in chronological order — are the hackathon trace deliverable. They cover:

- `onboarding_flow__01.jsonl` — full 4-layer onboarding to Twin v1.0 (71 events in verification run)
- `find_matches__hero_scenario_C.jsonl` — 5-candidate debate including the Hina Raza dealbreaker flip
- `book_meeting__01.jsonl` — wali brief + slot proposals + venue fallback recovery
- `handle_dispute__01.jsonl` — severity-3 dispute mediation with Gemini Pro
- `recovery__moderator_timeout.jsonl` — explicit visible-recovery exemplar (per-debate budget exceeded, remaining dims aggregated as neutral 0.5)

To regenerate from the live `traces` Supabase table:

```bash
npm run export-traces
```

See `traces/INDEX.md` for the `traceId` selected for each file and the selection criteria.

---

## 10. Baseline comparison

`GET /baseline/match` runs the same 12 candidates through a non-agentic weighted-distance ranker (`src/domain/scoring.ts → baselineScore`). No Gemini calls, no debate — pure cosine similarity on the 18-feature value vector.

Compared against `POST /match/request`, the hero scenario demonstrates agentic uplift:

- **Baseline** ranks Hina Raza (`candidate_id: 44444444-...`) in the top-3 for users with a "no prior relationship" dealbreaker, because her publicly-visible profile scores well on deen, geography, and career dimensions.
- **Agentic debate** surfaces the hidden 5-year past public relationship embedded in her `dealbreakers` array during the `dealbreakers` dimension turn. The Moderator flags it, `dealbreaker_hit=true`, recommendation flips to `not_recommended`.

The baseline endpoint returns a 6-candidate cosine ranking; the agentic top-3 meaningfully diverges. This is the Day 3 exit-check deliverable from MASTERPLAN.md §11.

Decision log entry: SESSION_CONTEXT.md §5 "2026-05-17 (Session 3) — Hero candidate Hina Raza".

---

## 11. Cost and scalability

See `docs/COSTS.md` for the full per-operation pricing table and 10x / 100x / 1000x projections. Quick reference from MASTERPLAN.md §14:

- **Per match debate:** ~$0.004 in LLM tokens (5 candidates x 8 dims x 1 unified Flash call).
- **Per full onboarding:** ~$0.25 (Gemini Pro for Twin synthesis, Layer-3 statements, system prompt generation).
- **Estimated full happy-path journey** (onboard + match + book + feedback): ~$0.17.
- **1,000 users:** No architecture change. Supabase free tier covers it.
- **10,000 users:** Supabase Pro ($25/mo), Redis cache for Twin specs, overnight batch prescreen.
- **100,000 users:** Vector DB at scale (pgvector Pro or Pinecone), background workers, multi-region replicas.
- **Bottleneck:** Moderator debate latency (~30s end-to-end at MVP with 10 concurrent Vertex calls). Mitigated at scale by overnight pre-computation against fresh candidates, on-demand only for new users or new candidates.

---

## 12. Privacy and safety stance

- All 12 candidate Twins are **fictional** — synthetic names, synthetic backstories, hardcoded stable UUIDs in `src/content/candidates.ts`. No real person is represented.
- All SMS output, all wali phone numbers, and all calendar availability are **mocked**. The mock output is rendered to the client so the demo looks real, but nothing leaves the server. The `smsRender` tool is a pure function; `calendarMock` uses a deterministic PRNG seeded by wali phone pairs.
- **Real payments are out of scope.** No payment processor is wired or planned.
- **Google Maps Places API** is optionally real (live venue lookups when `GOOGLE_MAPS_API_KEY` is set); the fallback to hardcoded city-specific venues fires whenever the key is absent or the API call fails.
- Per MASTERPLAN.md §1.8, §1.9, and §13 — none of these constraints are negotiable for the hackathon submission.

---

## 13. Tests

`npm test` runs 6 Vitest happy-paths (all mocking Gemini + Supabase):

| Test file | What it covers |
|---|---|
| `tests/health.test.ts` | `/health` returns `{ ok: true }` |
| `tests/onboarding.test.ts` | Full 4-layer onboarding workplan produces a valid `TwinSpec` + at least 15 trace events |
| `tests/moderator.test.ts` | Full 8-dimension debate produces a valid `CompatibilityReport` with correct recommendation |
| `tests/wali.test.ts` | Bilingual rishta brief generation + TTS text-only fallback path |
| `tests/booking.test.ts` | Slot proposal + venue fallback to hardcoded list |
| `tests/dispute.test.ts` | Severity classification + escalation flag on contradictory accounts |

All mocks are in `tests/setup.ts` (Vitest `globalSetup`) plus per-file inline mocks. Tests run in ~6s.

---

## 14. Known limitations and deviations from MASTERPLAN.md

- **`/twin/me` not shipped.** Deferred to Session 5 nice-to-have. It is a single Supabase read returning the latest Twin row for the authenticated user. Implementation note in SESSION_CONTEXT.md §6.

- **`/book/initiate` SSE catches only `workplan.finished`.** The route awaits the `meetingIdPromise` (which resolves after step 5 of the workplan — the DB insert) before returning. By the time the mobile client subscribes to `GET /stream/:flowId`, the bus has already closed. The trace IS persisted in the `traces` table and the full event array is readable post-hoc. Session 5 polish: decouple `meetingId` resolution from the initial response so `flowId` can be returned before work starts (matching the `POST /match/request` pattern). Risk log entry: SESSION_CONTEXT.md §8.

- **STT is a stub.** `src/tools/stt.ts` validates input, emits the full `tool.call` / `tool.result` / `recovery` trace contract, and returns `{ lowConfidence: true, stub: true }` always. The chip-based fallback in the Onboarding Agent IS the demo's STT visible-recovery moment. Replacing the body of `attemptStt` with a real `@google-cloud/speech` call is a one-file change.

- **Google Maps Places API key is not set in the dev `.env`.** The hardcoded city venue fallback fires every request (`src/tools/maps.ts`). This is the documented fallback per MASTERPLAN.md §9, and the trace shows it as a `recover` event so judges can see the failure-handling path. Drop a real `GOOGLE_MAPS_API_KEY` into `.env` to get live venue data.

- **TTS Urdu output untested on mobile.** `ur-IN-Wavenet-B` plays correctly in Chrome desktop on the dev machine. Expo-av playback on iOS and Android needs frontend smoke-test before the demo, particularly on Android devices without a fallback Urdu font.

- **Onboarding session state is in-memory.** The partial-answers map (`src/domain/onboarding-session.ts`) lives in a `Map` keyed by `sessionId`. A server restart mid-onboarding forces the user to restart the flow. Acceptable at hackathon scale; a production build would persist to a `onboarding_sessions` table.

- **Workplan latency over MASTERPLAN spec.** MASTERPLAN.md §8.2 budgets 30s for `find_matches`. The current implementation runs at ~30s with GCP billing enabled (300 RPM Vertex quota) but was 79s at hackathon-tier quota (60 RPM). The per-debate budget ceiling is 60s with a `recover` event on overflow. SESSION_CONTEXT.md §8 risk log.

---

## 15. Repo map

```
backend/
├── MASTERPLAN.md                   spec — single source of truth
├── ANTIGRAVITY.md                  workplan / agent / tool / trace contract
├── SESSION_CONTEXT.md              cross-session engineering memory
├── README.md                       this file
├── .env.example                    all required env vars, annotated
├── package.json
├── tsconfig.json
├── docs/
│   └── COSTS.md                    cost per operation + 10x/100x/1000x projections
├── traces/                         exported hackathon trace JSONLs (5 files)
│   └── INDEX.md                    which traceId was selected for each file
├── scripts/
│   ├── export-traces.ts            npm run export-traces
│   └── check-traces.ts             dev aux — inspect traces table
├── src/
│   ├── server.ts                   Fastify entrypoint, route registration
│   ├── config.ts                   Zod-validated env loader
│   ├── db/
│   │   ├── client.ts               Supabase service-role + anon clients, retry wrappers
│   │   ├── schema.sql              authoritative DDL (apply via Supabase SQL Editor)
│   │   └── seed-candidates.ts      npm run seed — upserts 12 candidate twins
│   ├── routes/
│   │   ├── auth.routes.ts          /auth/otp/{start,verify}
│   │   ├── onboarding.routes.ts    /onboarding/{layer1,layer2,layer3,wali,finalize}
│   │   ├── match.routes.ts         /match/request, /match/results/:flowId, /baseline/match
│   │   ├── booking.routes.ts       /book/{initiate,confirm}
│   │   ├── dispute.routes.ts       /dispute/file
│   │   ├── feedback.routes.ts      /feedback/post-meeting
│   │   ├── stream.routes.ts        /stream/:flowId (SSE)
│   │   └── _auth.middleware.ts     requireUserId — JWT → user_id
│   ├── agents/
│   │   ├── _shared/
│   │   │   ├── gemini.ts           geminiCall: retry + Pro→Flash fallback + trace auto-emit
│   │   │   ├── trace.ts            TraceBus, startTrace, endTrace, obs/decide/recover helpers
│   │   │   └── types.ts            TraceEvent union, Dimension, WorkplanName, ApiResponse
│   │   ├── onboarding.agent.ts
│   │   ├── twin-forge.agent.ts
│   │   ├── user-twin.agent.ts
│   │   ├── candidate-twin.agent.ts
│   │   ├── moderator.agent.ts
│   │   ├── wali.agent.ts
│   │   ├── booking.agent.ts
│   │   └── dispute.agent.ts
│   ├── workplans/
│   │   ├── onboarding.workplan.ts
│   │   ├── find-matches.workplan.ts
│   │   ├── book-meeting.workplan.ts
│   │   └── handle-dispute.workplan.ts
│   ├── tools/
│   │   ├── stt.ts                  Cloud STT (stub — chip fallback is the recovery demo)
│   │   ├── tts.ts                  Cloud TTS, Urdu + English voices, base64 MP3 output
│   │   ├── maps.ts                 Maps Places API + hardcoded city fallback list
│   │   ├── sms.template.ts         mock SMS renderer, 6 templates x 3 languages
│   │   └── calendar.mock.ts        deterministic PRNG slot proposals, PKT-aware
│   ├── domain/
│   │   ├── twin.ts                 TwinSpec type + TwinSpecSchema Zod validator
│   │   ├── dimensions.ts           8 dimension metadata + default weights
│   │   ├── scoring.ts              weighted aggregation + baselineScore (non-agentic ranker)
│   │   └── prescreen.ts            18-feature cosine similarity + dealbreaker penalty
│   ├── content/
│   │   ├── candidates.ts           12 fictional candidate Twin specs, stable UUIDs
│   │   ├── scenario-cards.ts       12 onboarding scenario cards, trilingual
│   │   └── prompts/
│   │       ├── onboarding.prompt.ts
│   │       ├── twin-system.prompt.ts
│   │       ├── moderator.prompt.ts
│   │       ├── wali.prompt.ts
│   │       └── dispute.prompt.ts
│   └── utils/
│       ├── logger.ts               Pino, pretty-print in dev
│       ├── errors.ts               AppError with code → HTTP status mapping
│       └── retry.ts                generic exponential-backoff retry
└── tests/
    ├── setup.ts                    global Vitest mocks (Gemini, Supabase, tools)
    ├── health.test.ts
    ├── onboarding.test.ts
    ├── moderator.test.ts
    ├── wali.test.ts
    ├── booking.test.ts
    └── dispute.test.ts
```

---

## 16. The 8 agents — quick reference

Full specifications in MASTERPLAN.md §5.

| Agent | Role |
|---|---|
| Onboarding | Multilingual voice/chat intake; extracts identity, deen, career, dealbreakers across up to 5 turns |
| Twin Forge | Synthesizes all four onboarding layers into a persistent Twin spec; refreshes `system_prompt` after post-meeting feedback |
| User Twin | Argues the user's values in Twin-to-Twin compatibility debates |
| Candidate Twin | Same architecture as User Twin; argues from one of the 12 pre-built fictional personas |
| Moderator | Orchestrates the 8-dimension debate; scores each dimension; detects dealbreakers; enforces time budget |
| Wali | Generates bilingual rishta brief (EN + UR/RO_UR) with TTS audio; renders mock SMS to both walis |
| Booking | Proposes meeting slots (PKT-aware, Jumma-safe); fetches halal-friendly venues via Maps Places; generates meeting card |
| Dispute | Classifies severity 1-5; applies reputation impact; flags contradictory accounts for human review |

---

## 17. Authors

Two-engineer backend team for the Google Antigravity Hackathon 2026. Frontend (Expo) lives in a sibling folder of the same monorepo. Demo video and content are owned by separate teammates.

GCP project: `lab-viah` (Vertex AI, us-central1). Supabase project: `kllejrzqraqclmysdtfv`.

---

*End README. Last updated 2026-05-18 by Session 5 (ship day).*
