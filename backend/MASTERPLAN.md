# RishtaAI Backend — Masterplan

> **This file is the single source of truth for the RishtaAI backend.** Every session begins by reading this file. Update it only at the end of a session, never mid-session.

---

## 0. Mission

Build, in 5 days (15–20 May 2026), the backend that powers RishtaAI: an 8-agent matchmaking system orchestrated inside Google Antigravity, exposing a REST + Server-Sent Events API consumed by an Expo mobile app. The backend must satisfy every requirement of Challenge 2 (AI Service Orchestrator for Informal Economy) of the Google Antigravity Hackathon.

**Two engineers (you + teammate) own everything in this document.** Frontend, demo video, and content are handled by other team members per the PRD.

**Submission deadline: Wednesday 20 May 2026, end of day.** Feature freeze: 11:00 AM that day.

---

## 1. Non-negotiables

These cannot change without team-lead approval:

1. **Antigravity is the orchestrator.** Every multi-step agent flow runs through an Antigravity workplan. Workplan + task plan + agent observations + decisions + tool calls + recovery + outcomes must be exportable as the hackathon trace deliverable.
2. **Eight agents, distinct roles.** Onboarding, Twin Forge, User Twin, Candidate Twin, Moderator, Wali, Booking, Dispute. See section 5.
3. **Gemini 3 Pro for orchestration, Claude Sonnet 4.6 for precision file edits.** Antigravity natively supports both. Use Gemini for agent reasoning at runtime; use Claude inside the IDE for our own coding sessions.
4. **TypeScript everywhere.** Backend = Node.js 20 + Fastify + TS. No JavaScript files.
5. **Supabase = single source of truth for persisted state.** No in-memory state survives process restart.
6. **Every agent decision is logged to the trace.** No silent operations. If the trace is empty, the demo is dead.
7. **Failures and recovery are first-class.** Every external call has a retry policy and a fallback path. At least one recovery scenario must be visible in the demo.
8. **No real personal data, ever.** All 12 candidate Twins are fictional. Synthetic names, synthetic avatars.
9. **No real SMS, no real payments, no real wali phone numbers.** All side effects are mocked but the mock output is rendered to the client so the demo looks real.

---

## 2. Architecture (one screen)

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
│                                                                │
│  Workplans:  onboarding_flow · find_matches · book_meeting    │
│              handle_dispute                                    │
│                                                                │
│  Agents:  Onboarding · Twin Forge · User Twin · Candidate     │
│           Twin · Moderator · Wali · Booking · Dispute         │
│                                                                │
│  Tool registry:  Gemini call · Cloud STT · Cloud TTS ·        │
│                  Supabase read/write · Maps Places · SMS      │
│                  template · Calendar mock                      │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│  DATA LAYER                                                    │
│  Supabase Postgres · Supabase Auth · Supabase Storage         │
│  Google Cloud Speech / TTS · Google Maps Places                │
└──────────────────────────────────────────────────────────────┘
```

**One sentence:** Mobile hits Fastify → Fastify kicks off an Antigravity workplan → workplan delegates to agents → agents call Gemini and other tools → results stream back via SSE → final state lands in Supabase.

---

## 3. Tech stack (locked)

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS | Stable, fast cold starts on Railway. |
| HTTP framework | Fastify 4 | Native SSE support, faster than Express, schema validation built in. |
| Language | TypeScript 5 (strict) | Catches errors agents commonly introduce. |
| ORM / DB client | `@supabase/supabase-js` v2 | First-party. No Prisma. |
| Database | Supabase Postgres | Free tier, RLS, realtime. |
| Auth | Supabase phone OTP | Built-in; matches Pakistan SIM-first reality. |
| LLM (agent runtime) | Gemini 3 Pro via `@google/generative-ai` | Multilingual, fast, cheap. Fallback to Gemini 2.5 Flash for low-stakes calls. |
| STT | Google Cloud Speech-to-Text | Urdu + English + auto-detect. |
| TTS | Google Cloud Text-to-Speech | Urdu voice for Wali brief. |
| Maps | Google Maps Places API | Halal-friendly venue suggestions. |
| Validation | Zod | Every input and LLM output validated. |
| Logging | Pino + structured JSON | Pipes into Antigravity trace format. |
| Testing | Vitest | Fastest TS test runner. Hand-write 5–10 critical tests, no more. |
| Deploy | Railway (API) + Supabase (DB) | Five-minute deploys, no DevOps. |
| Orchestration IDE | Google Antigravity (mandatory) | Hackathon requirement. |
| Code assist | Claude Sonnet 4.6 inside Antigravity | Highest-quality precision edits. |

**Forbidden:** Prisma, Express, REST clients other than `fetch`, JavaScript files, untyped any.

---

## 4. Repository layout

```
rishtaai-backend/
├── ANTIGRAVITY.md              # How Antigravity is wired into this project
├── MASTERPLAN.md               # This file
├── SESSION_CONTEXT.md          # Updated at end of each session
├── README.md                   # Public-facing (becomes hackathon README)
├── .env.example                # All required env vars
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts               # Fastify entrypoint
│   ├── config.ts               # Env validation via Zod
│   ├── db/
│   │   ├── client.ts           # Supabase client
│   │   ├── schema.sql          # Authoritative schema
│   │   └── seed.ts             # 12 candidate Twins
│   ├── routes/
│   │   ├── auth.routes.ts
│   │   ├── onboarding.routes.ts
│   │   ├── twin.routes.ts
│   │   ├── match.routes.ts
│   │   ├── booking.routes.ts
│   │   ├── dispute.routes.ts
│   │   └── stream.routes.ts    # SSE endpoint
│   ├── agents/
│   │   ├── _shared/
│   │   │   ├── gemini.ts       # Wrapped Gemini client with retries
│   │   │   ├── trace.ts        # Antigravity trace emitter
│   │   │   └── types.ts
│   │   ├── onboarding.agent.ts
│   │   ├── twin-forge.agent.ts
│   │   ├── user-twin.agent.ts
│   │   ├── candidate-twin.agent.ts
│   │   ├── moderator.agent.ts
│   │   ├── wali.agent.ts
│   │   ├── booking.agent.ts
│   │   └── dispute.agent.ts
│   ├── workplans/              # Antigravity workplan definitions
│   │   ├── onboarding.workplan.ts
│   │   ├── find-matches.workplan.ts
│   │   ├── book-meeting.workplan.ts
│   │   └── handle-dispute.workplan.ts
│   ├── tools/
│   │   ├── stt.ts              # Google Cloud Speech
│   │   ├── tts.ts              # Google Cloud TTS
│   │   ├── maps.ts             # Places API
│   │   ├── sms.template.ts     # Mock SMS renderer
│   │   └── calendar.mock.ts    # Mock calendar
│   ├── domain/
│   │   ├── twin.ts             # Twin spec + builder
│   │   ├── dimensions.ts       # 8 compatibility dimensions
│   │   ├── scoring.ts          # Weighted score aggregation
│   │   └── prescreen.ts        # Vector-similarity pre-screen
│   ├── content/
│   │   ├── candidates.ts       # 12 candidate Twin specs
│   │   ├── scenario-cards.ts   # 12 onboarding cards
│   │   └── prompts/            # All LLM system prompts
│   │       ├── onboarding.prompt.ts
│   │       ├── twin-system.prompt.ts
│   │       ├── moderator.prompt.ts
│   │       ├── wali.prompt.ts
│   │       └── dispute.prompt.ts
│   └── utils/
│       ├── logger.ts
│       ├── errors.ts
│       └── retry.ts
└── tests/
    ├── onboarding.test.ts
    ├── moderator.test.ts
    └── prescreen.test.ts
```

---

## 5. The eight agents (specifications)

Each agent: **input → tools → output → failure modes**. Implementations live in `src/agents/`.

### 5.1 Onboarding Agent
- **Purpose:** Conducts Layer 1 of onboarding. Multilingual voice/chat. Extracts name, age, location, family setup, deen practice, career, dealbreakers.
- **Inputs:** Audio chunks (base64) or text, conversation history, language hint.
- **Tools:** Cloud STT, Gemini 3 Pro.
- **Output:** `{ identity, family_setup, deen_level, career, dealbreakers[], language_pref, per_field_confidence }`.
- **Failure modes:** STT confidence < 0.6 → return chip-based re-prompt. Empty answer → polite probe. Session timeout → save partial, allow resume.

### 5.2 Twin Forge Agent
- **Purpose:** Synthesizes Layer 1 + Layer 2 (scenario cards) + Layer 3 (Twin Interview) + Layer 4 (optional Wali) into a persistent Twin v1.0.
- **Inputs:** Onboarding payload, scenario card responses, Twin Interview corrections, optional Wali Mode input.
- **Tools:** Gemini 3 Pro, Supabase write.
- **Output:** Twin JSON spec (see section 6.2). Includes generated `system_prompt` that defines the Twin's voice.
- **Failure modes:** Conflicting Wali vs user input → flag for reconciliation, don't auto-resolve. Sparse data → mark dimension low-confidence.

### 5.3 User Twin Agent
- **Purpose:** Represents the user in compatibility debates. Argues from stated values. Flags dealbreakers.
- **Inputs:** Twin spec, Moderator prompt for current dimension, counterpart's previous statement.
- **Tools:** Gemini 3 Pro (Twin system prompt injected, temperature 0.4).
- **Output:** Debate statement (1–3 sentences), `willingness_to_compromise` (0–1), `dealbreaker_hit` (bool).
- **Failure modes:** Drift off-spec → Moderator detects and re-anchors. Inconsistency → re-load from spec.

### 5.4 Candidate Twin Agent
- Same architecture as User Twin. 12 hand-crafted candidate specs loaded from `src/content/candidates.ts`. The agent does not generate candidates at runtime — they are pre-built fictional personas with rich backstories.

### 5.5 Moderator Agent
- **Purpose:** Orchestrates the Twin-to-Twin debate. Decides dimension order, prompts each Twin, scores each dimension, detects dealbreakers, terminates when verdict threshold reached.
- **Inputs:** User Twin spec, Candidate Twin spec, user-stated dimension weights.
- **Tools:** Gemini 3 Pro (orchestrator prompt, temperature 0.2), Antigravity sub-task spawning, Supabase write.
- **Output:** Compatibility Report (section 6.3).
- **Failure modes:** Twin contradicts itself → re-anchor. Time budget exceeded (>30s) → force termination, low-confidence flag. Tie scores → 2 extra turns.

### 5.6 Wali Agent
- **Purpose:** Generates Urdu/English rishta brief on top-3 reveal. Handles Layer 4 (Wali Mode) onboarding input.
- **Inputs:** Top-3 match data, user wali contact, language pref.
- **Tools:** Gemini 3 Pro (Urdu-tuned prompt), TTS for spoken brief, SMS template renderer.
- **Output:** Rishta brief (structured + free-text), spoken audio URL, mock SMS body.
- **Failure modes:** Missing wali contact → fallback to user as own wali with note. Wali no response in 48h sim → reminder + alternate wali suggestion.

### 5.7 Booking Agent
- **Purpose:** Simulates first-meeting workflow once both walis approve.
- **Inputs:** Approved match, both wali calendar availability (mocked), location, language prefs.
- **Tools:** Google Maps Places API (halal-friendly venues), Supabase write, SMS template, calendar mock.
- **Output:** `{ slot_iso, venue, attendees[], wali_contacts[], meeting_card_url, reminders[] }`. SMS body rendered to client.
- **Failure modes:** Slot conflict → propose 3 alternates. Venue unavailable → 3 alternates. SMS API failure → in-app notification fallback.

### 5.8 Dispute Agent
- **Purpose:** Handles post-meeting issues: no-show, misrepresentation, ghosting, family rejection.
- **Inputs:** Dispute filing, match history, prior reputation, both Twin specs.
- **Tools:** Gemini 3 Pro (mediation prompt), Supabase write, notification renderer.
- **Output:** `{ type, severity, action, reputation_impact[], blocklist_changes[], escalated }`.
- **Failure modes:** Contradictory accounts → flag for human review (visible in trace). Repeat offender → auto-shadowban with reason.

---

## 6. Data models

### 6.1 Tables (Supabase Postgres)

```sql
-- users
create table users (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  age int,
  gender text check (gender in ('male','female','other')),
  city text,
  language_pref text check (language_pref in ('ur','ro_ur','en')) default 'en',
  wali_contact text,
  created_at timestamptz default now(),
  last_active timestamptz default now()
);

-- twins (user twins AND candidate twins)
create table twins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  is_candidate boolean default false,
  version int default 1,
  spec jsonb not null,                  -- Twin JSON spec (6.2)
  embedding vector(768),                -- pgvector, for prescreen
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on twins using ivfflat (embedding vector_cosine_ops);

-- compatibility_reports
create table compatibility_reports (
  id uuid primary key default gen_random_uuid(),
  user_twin_id uuid references twins(id),
  candidate_twin_id uuid references twins(id),
  overall_score numeric(3,2),
  dimension_scores jsonb,
  top_strengths text[],
  top_friction_points text[],
  dealbreakers_hit text[],
  recommendation text check (recommendation in ('strong_match','conditional_match','not_recommended')),
  reasoning_trace jsonb,                -- full Antigravity trace
  generated_at timestamptz default now()
);

-- meetings
create table meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  candidate_id uuid references twins(id),
  slot_iso timestamptz,
  venue jsonb,
  wali_contacts jsonb,
  meeting_card_url text,
  status text check (status in ('proposed','confirmed','completed','cancelled','no_show')),
  reminders jsonb,
  created_at timestamptz default now()
);

-- disputes
create table disputes (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references meetings(id),
  filed_by text check (filed_by in ('user','wali')),
  type text,
  severity int check (severity between 1 and 5),
  status text default 'open',
  resolution jsonb,
  reputation_impact jsonb,
  created_at timestamptz default now()
);

-- traces (Antigravity workplan execution logs)
create table traces (
  id uuid primary key default gen_random_uuid(),
  workplan text,
  user_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  observations jsonb,
  decisions jsonb,
  tool_calls jsonb,
  recoveries jsonb,
  outcome jsonb
);
```

### 6.2 Twin JSON spec

```ts
type TwinSpec = {
  identity: { name: string; age: number; gender: 'male'|'female'; city: string };
  deen_level: 'strict'|'practicing'|'moderate'|'cultural'|'secular';
  family_setup: 'joint'|'nuclear'|'single_parent';
  family_loyalty_score: number;      // 0..1
  career: { current: string; five_yr_goal: string; ambition: number };
  finances: { current_status: 'student'|'starting'|'stable'|'affluent'; lifestyle_pref: 'simple'|'comfortable'|'aspirational' };
  kids_timeline: 'asap'|'2-3_yrs'|'5_plus'|'none';
  conflict_style: 'avoidant'|'direct'|'consensus'|'elder_mediated';
  geography: { current_city: string; ten_yr_pref: string; flexible: boolean };
  dealbreakers: string[];
  dimension_weights: {                 // user-stated importance per dimension, sums to 1.0
    deen: number; family: number; career: number; finances: number;
    kids: number; conflict: number; geography: number; dealbreakers: number;
  };
  system_prompt: string;               // ~400 words, generated by Twin Forge
  wali_override?: Partial<TwinSpec>;   // if Wali Mode used
  language_pref: 'ur'|'ro_ur'|'en';
  version: number;
};
```

### 6.3 Compatibility Report

```ts
type CompatibilityReport = {
  overall_score: number;                                  // 0..1
  dimension_scores: Record<Dimension, {
    score: number;                                        // 0..1
    weight: number;
    evidence: string;                                     // 1-2 sentences explaining
    friction_level: 'none'|'low'|'medium'|'high'|'dealbreaker';
  }>;
  top_strengths: [string, string, string];
  top_friction_points: [string, string, string];
  dealbreakers_hit: string[];
  recommendation: 'strong_match'|'conditional_match'|'not_recommended';
  reasoning_trace: AntigravityTrace;
};
```

---

## 7. API surface (locked)

All endpoints return `{ ok: boolean, data?, error? }`. Auth via `Authorization: Bearer <supabase-jwt>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/otp/start` | Send OTP to phone. |
| POST | `/auth/otp/verify` | Verify OTP → JWT. |
| POST | `/onboarding/layer1` | Voice/text intro chat turn. Returns next prompt + confidence. |
| POST | `/onboarding/layer2` | Scenario card response. Returns updated radar vector. |
| POST | `/onboarding/layer3` | Twin Interview correction. Returns updated Twin. |
| POST | `/onboarding/wali` | Optional Wali Mode input. |
| POST | `/onboarding/finalize` | Lock Twin v1.0. |
| GET | `/twin/me` | Return current user's Twin spec. |
| POST | `/match/request` | Kick off find_matches workplan. Returns `flowId`. |
| GET | `/stream/:flowId` | SSE stream of agent trace events. |
| GET | `/match/results/:flowId` | Final top-3 once complete. |
| POST | `/book/initiate` | Start halal reveal + booking workflow. Returns `flowId`. |
| POST | `/book/confirm` | Wali confirms slot. |
| POST | `/dispute/file` | File a dispute. |
| POST | `/feedback/post-meeting` | 4-dimension rating. Feeds Twin Forge. |
| GET | `/baseline/match` | Non-agentic baseline ranking (required deliverable). |

### SSE event shape

```ts
type TraceEvent =
  | { type: 'workplan.started'; workplan: string; flowId: string }
  | { type: 'task.started'; task: string }
  | { type: 'agent.observation'; agent: string; observation: string }
  | { type: 'agent.decision'; agent: string; decision: string; rationale: string }
  | { type: 'tool.call'; tool: string; args: any }
  | { type: 'tool.result'; tool: string; result: any; latency_ms: number }
  | { type: 'agent.message'; agent: string; content: string }   // Twin debate turn
  | { type: 'dimension.scored'; dimension: string; score: number; evidence: string }
  | { type: 'recovery'; reason: string; action: string }
  | { type: 'task.finished'; task: string; outcome: any }
  | { type: 'workplan.finished'; outcome: any };
```

Every agent emits to this stream. The mobile app renders it live below the debate UI. **No stream = no demo.**

---

## 8. Antigravity workplans

Workplans are TypeScript files that declare the goal, constraints, and task graph. The Antigravity orchestrator executes them and pipes events to the trace store.

### 8.1 onboarding_flow
1. start_session(user_id, language_pref)
2. layer1_chat (Onboarding Agent, ≤5 turns) → onboarding_payload
3. layer2_cards (12 scenario cards) → personality_vector
4. layer3_interview (Twin Forge generates 3 statements, user corrects) → corrections
5. (optional) layer4_wali → wali_input
6. forge_twin (Twin Forge) → Twin v1.0
7. persist + index_embedding
   - **Constraint:** total time ≤ 11 min. If exceeded, save partial and resume.

### 8.2 find_matches
1. load_user_twin
2. prescreen_candidates → top_5 (vector similarity on values + dealbreakers)
3. parallel for each candidate: spawn_debate(User Twin, Candidate Twin) → CompatibilityReport
4. rank_reports → top_3
5. persist_reports + notify_user
   - **Constraint:** budget 30s end-to-end. If Gemini >5s per call, downgrade to Flash for non-Moderator agents.
   - **Recovery:** any failed debate → retry once, then mark candidate low-confidence and continue.

### 8.3 book_meeting
1. wali_brief (Wali Agent, both languages)
2. send_mock_sms_to_both_walis (rendered in client)
3. propose_slots (Booking Agent, 3 options)
4. on_user_confirm → fetch_venues (Maps Places)
5. generate_meeting_card + schedule_reminders
6. persist
   - **Recovery:** Maps fails → fallback to 3 hardcoded city-specific halal-friendly venues.

### 8.4 handle_dispute
1. collect_perspectives (both sides via Dispute Agent prompts)
2. classify_severity (1–5)
3. apply_reputation_impact
4. if contradictory → flag_for_human_review (visible in trace)
5. notify_both_parties + update Twin Forge weights

---

## 9. Tool registry

Every tool has: typed input, typed output, retry policy, mock-mode flag.

| Tool | Module | Retries | Fallback |
|---|---|---|---|
| `geminiCall` | `src/agents/_shared/gemini.ts` | 2× exponential | Switch model Pro→Flash |
| `sttTranscribe` | `src/tools/stt.ts` | 1× | Return low-confidence flag; UI shows chip prompts |
| `ttsSynthesize` | `src/tools/tts.ts` | 1× | Skip audio, send text only |
| `mapsFindVenue` | `src/tools/maps.ts` | 2× | Hardcoded venue list per city |
| `smsRender` | `src/tools/sms.template.ts` | n/a | Pure function, no fallback needed |
| `calendarMock` | `src/tools/calendar.mock.ts` | n/a | Pure function |
| `supabaseRead/Write` | `src/db/client.ts` | 3× | Surface to user; do not silently fail |

---

## 10. Five compatibility dimensions resolved into a score

8 dimensions, each scored 0–1 by the Moderator after the debate.

```ts
const DIMENSIONS = [
  'deen',         // shared deen practice and rigor
  'family',       // family dynamics, in-law expectations
  'career',       // career trajectory, ambition match
  'finances',     // financial outlook, lifestyle expectation
  'kids',         // timing and parenting philosophy
  'conflict',     // disagreement and resolution style
  'geography',    // current city + 10-year preference
  'dealbreakers', // explicit non-negotiables
] as const;

// Final score = Σ (dimension_score × user_weight)
// If any dealbreaker is hit, recommendation is forced to 'not_recommended'
// regardless of other scores.
```

---

## 11. The 5-day plan (engineering view)

Time budgets are rough. Reassess every standup.

### Day 1 — Fri eve + Sat full (foundation)
- **Hours 0–4:** Repo init, TS config, Fastify hello-world, Supabase project, env scaffolding, ANTIGRAVITY.md draft.
- **Hours 4–10:** Schema SQL run on Supabase. Seed script for 2 placeholder candidates (full 12 land Day 2). Auth endpoints working. JWT validated.
- **Hours 10–16:** Antigravity workspace set up. Onboarding workplan skeleton. Gemini client wrapper with retries. First SSE endpoint streaming a fake event.
- **End-of-day exit criteria:** `curl /health` returns ok; `curl /auth/otp/start` writes to Supabase; SSE stream emits a dummy event every second.

### Day 2 — Sunday (onboarding agents + Twin Forge)
- **Hours 0–4:** Onboarding Agent implementation. Cloud STT wired. Layer 1 endpoint functional with real Gemini calls.
- **Hours 4–8:** Twin Forge Agent. Scenario card scoring logic. Layer 2 endpoint.
- **Hours 8–12:** Layer 3 endpoint. Twin v1.0 generation. Wali Mode endpoint.
- **Hours 12–16:** Trace emitter wired to all four endpoints. End-to-end onboarding produces a stored Twin spec.
- **End-of-day exit criteria:** A scripted user completes onboarding via API; Twin spec lands in Supabase with version=1.

### Day 3 — Monday (Twin debate + Moderator) — HERO DAY
- **Hours 0–4:** User Twin and Candidate Twin agents. System prompt templates wired.
- **Hours 4–10:** Moderator agent. 8-dimension debate logic. Per-dimension scoring. Dealbreaker detection.
- **Hours 10–14:** find_matches workplan end-to-end. Prescreen (vector similarity) implemented. Parallel debate spawning.
- **Hours 14–16:** All 12 candidate Twins written and seeded.
- **End-of-day exit criteria:** `POST /match/request` returns a flowId; SSE stream emits a full debate; `GET /match/results/:flowId` returns top-3 with compatibility reports including reasoning_trace.

### Day 4 — Tuesday (service orchestration)
- **Hours 0–5:** Wali Agent. Urdu/English brief generation. TTS audio. Mock SMS rendering.
- **Hours 5–10:** Booking Agent. Maps Places integration. Venue suggestions. Calendar mock. Meeting card generation.
- **Hours 10–13:** Dispute Agent. Filing endpoint. Severity classification. Reputation impact.
- **Hours 13–16:** Baseline endpoint (non-agentic ranker for comparison deliverable). Post-meeting feedback endpoint wired to Twin Forge updates.
- **End-of-day exit criteria:** Every endpoint in section 7 returns real data. Trace export for one full user journey is a complete Antigravity-compliant log.

### Day 5 — Wednesday (lock + ship)
- **0:00–11:00:** Final bug fixes only. No new endpoints.
- **11:00 SHARP:** Feature freeze.
- **11:00–14:00:** README, ANTIGRAVITY.md final pass, trace exports, cost/scalability docs.
- **14:00–17:00:** Deploy to Railway. Validate from real device against deployed URL. Frontend team plugs in production URL.
- **17:00–19:00:** Run full demo dry-run with frontend team. Two pre-recorded hero scenarios cached against demo flakiness.
- **19:00:** Submit. Buffer until 23:00.

---

## 12. Definition of done

A feature is "done" when:
1. TypeScript compiles with no errors and no `any`.
2. At least one happy-path test passes (Vitest).
3. The endpoint emits trace events for every agent decision.
4. At least one failure mode is handled with a visible recovery event.
5. Latency is under the budget in section 9 (or documented as a known issue).
6. Schema is reflected in `schema.sql` if anything changed.
7. `SESSION_CONTEXT.md` updated with what changed and what's next.

---

## 13. What we will NOT build

Anything not listed in section 7 or 11 is out of scope. Specifically:
- Real SMS/email sending
- Real payment processing
- Profile photo upload (use synthetic avatars in candidates seed)
- NADRA / employer verification (mock badges only, frontend concern)
- Human-to-human chat
- Push notifications beyond Expo's built-in
- Reinforcement learning, Reddit scraping, any external training data pipeline
- Web app

If a session proposes any of the above, push back and update `SESSION_CONTEXT.md` with the deferral.

---

## 14. Cost & scalability (required deliverable)

Documented in section 9.1 of the PRD; quick reference here:

- Per match: ~$0.004 in LLM tokens. Onboarding: ~$0.25 total.
- 1,000 users: no architecture change. Supabase free tier covers it.
- 10,000 users: Supabase Pro ($25/mo), Redis cache for Twin specs, batch overnight prescreen.
- 100,000 users: vector DB (pgvector at scale or Pinecone), background workers, multi-region replicas.
- Bottleneck: Moderator debate latency (~12s end-to-end at MVP). Mitigated at scale by overnight pre-computation, on-demand only for fresh matches.

---

## 15. Session protocol

You will work in 4–5 focused sessions inside Antigravity. Each session:

1. **Open `MASTERPLAN.md` and `SESSION_CONTEXT.md`.**
2. Pick the next "in-progress" or "next" item from `SESSION_CONTEXT.md`.
3. Spawn an Antigravity agent with the session's scoped task.
4. At the end of the session, update `SESSION_CONTEXT.md` (done, in-progress, blockers, next).
5. Commit and push. Tag the commit with the session number.

Suggested split:
- **Session 1** (4 hrs, Day 1): Foundation. Repo, schema, auth, SSE skeleton.
- **Session 2** (6 hrs, Day 2): Onboarding agents + Twin Forge.
- **Session 3** (6 hrs, Day 3): Moderator + Twin debate + find_matches workplan.
- **Session 4** (5 hrs, Day 4): Wali, Booking, Dispute, baseline endpoint.
- **Session 5** (3 hrs, Day 5 AM): Polish, deploy, trace export.

Anything more than 5 sessions means we are off track — escalate to TL.
