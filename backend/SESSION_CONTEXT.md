# Session Context — RishtaAI Backend

> **Read this file at the start of EVERY session, before doing anything else.**
> **Update this file at the END of EVERY session, before committing.**
> This is the working memory across all sessions. Do not skip the update step.

---

## How to use this file

1. **At session start:**
   - Read sections 1, 2, 3 in order.
   - Confirm with the user which session number you are about to run.
   - Read the relevant "Session N goals" block in section 4.
   - Read MASTERPLAN.md sections referenced for this session.
   - Begin only after you have stated your plan back to the user.

2. **During the session:**
   - Update "In Progress" in section 2 whenever you switch tasks.
   - Append to "Blockers" in section 2 whenever something is blocked.
   - Append to "Decisions Made" in section 5 for every architecturally meaningful choice.

3. **At session end:**
   - Move completed items from "In Progress" to "Done in this session" with one-line description.
   - Write "Handoff for next session" in section 6: what is the next session's starting state.
   - Update "Last updated" with timestamp.
   - Commit with message `session N: <summary>`.

---

## 1. Current status snapshot

- **Project phase:** Session 1 COMPLETE. Foundation skeleton in place; committed locally on `backend/main`; not yet pushed; no deploys yet.
- **Last commit:** `e7c4185` — `session 1: backend foundation (Fastify + Supabase + trace bus + SSE)` (local on `backend/main`, not pushed).
- **Last updated:** 2026-05-17 by Session 1
- **Days remaining until 20 May submission:** 3 (Sun → Wed EOD)

---

## 2. Live working state

### In progress
*(What is being worked on RIGHT NOW. Empty at session boundaries.)*

- _(none — Session 1 ended cleanly)_

### Done (cumulative, across all sessions)

**Session 1 (2026-05-17):**
- [x] `ANTIGRAVITY.md` drafted — workplan/agent/tool/trace contract documented.
- [x] `package.json` (Fastify 4, @supabase/supabase-js v2, @google/generative-ai, Zod, Pino, Vitest, tsx, TS 5).
- [x] `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`.
- [x] `.env.example` with every required key (Supabase, Gemini Pro+Flash, GCP, Maps, trace dump flag).
- [x] `.gitignore` (node_modules, dist, .env, traces/*.jsonl).
- [x] `src/config.ts` — Zod-validated env loader, throws with field-level errors.
- [x] `src/utils/logger.ts` — Pino with pretty-print in dev.
- [x] `src/utils/errors.ts` — `AppError` class with code → status mapping.
- [x] `src/utils/retry.ts` — generic exponential-backoff retry with `shouldRetry` hook.
- [x] `src/db/schema.sql` — 6 tables (users, twins, compatibility_reports, meetings, disputes, traces) + pgvector + ivfflat index + updated_at trigger.
- [x] `src/db/client.ts` — service-role + anon Supabase clients, `dbRead`/`dbWrite` retry wrappers, `healthCheck`.
- [x] `src/agents/_shared/types.ts` — `TraceEvent` union, `Dimension`, `WorkplanName`, `ApiResponse`.
- [x] `src/agents/_shared/trace.ts` — `TraceBus` + `startTrace`/`endTrace`/`getTrace` + helpers (`obs`, `decide`, `recover`, `taskStart`, `taskEnd`). Persists to `traces` table on close.
- [x] `src/agents/_shared/gemini.ts` — `geminiCall` with 2× primary attempts + Pro→Flash fallback + 15s timeout. Auto-emits `tool.call`/`tool.result`/`recovery` when given a TraceBus. `geminiSmokeTest()` for /health/deep.
- [x] `src/routes/auth.routes.ts` — `POST /auth/otp/start` and `POST /auth/otp/verify` via Supabase Auth phone OTP. Upserts users row on verify.
- [x] `src/routes/stream.routes.ts` — `GET /stream/:flowId` SSE. `demo_*` flowIds get a 1s heartbeat for 30s; real flowIds subscribe to the in-memory `TraceBus`.
- [x] `src/server.ts` — Fastify entrypoint with `/health`, `/health/deep` (db + gemini), CORS, error handler.
- [x] `tests/health.test.ts` + `tests/setup.ts` + `vitest.config.ts` — happy-path test for `/health`.
- [x] `README.md` placeholder pointing at MASTERPLAN/ANTIGRAVITY/SESSION_CONTEXT.
- [x] `traces/.gitkeep` for the Session 5 export drop.

### Blockers

- _(none)_

### Open questions for the user / TL

- **Repo / git linkage** — user is deferring; needs to point this checkout at the real RishtaAI repo before Session 2 ends so commits stop being orphan.
- **Supabase project** — needs to be created and `SUPABASE_*` env vars filled before Session 2 (`src/db/schema.sql` must be applied for any user/twin write to work).
- **Gemini API key** — needs to be issued before Session 2 onboarding agent work.
- **GCP service account JSON** — needed for STT/TTS in Session 2; can be deferred to Session 2 start.
- **Twilio (Supabase phone OTP provider)** — Supabase test provider works in dev. Real Twilio creds required only if we want OTP to land on a real Pakistani SIM during demo. Out of scope unless TL says otherwise.

---

## 3. Quick reference — files & key paths

- Repo root: `D:\Projects\rishtaai\` (team monorepo). Backend code lives at `D:\Projects\rishtaai\backend\`.
- Git remote: `https://github.com/ZakiNabeel/Lab-Viah.git`. Branch: `backend/main`.
- Authoritative spec: `MASTERPLAN.md`.
- Antigravity wiring doc: `ANTIGRAVITY.md`.
- Schema: `src/db/schema.sql` (apply via Supabase SQL Editor).
- Env template: `.env.example` (copy to `.env`).
- Supabase project URL: *(to be filled when project created)*
- Railway service URL: *(filled in Session 5)*

### Smoke-check commands

```bash
npm install
npm run dev
curl http://localhost:3000/health
curl -N http://localhost:3000/stream/demo_session1   # 30s of heartbeats
npm run test
```

---

## 4. Session-by-session plan

### Session 1 — Foundation (Day 1, ~4 hrs) — DONE

(See section 2 "Done — Session 1" for the actual list of what shipped.)

---

### Session 2 — Onboarding + Twin Forge (Day 2, ~6 hrs)
**Goal:** A scripted user can complete the entire 4-layer onboarding via API calls and a Twin spec lands in Supabase.

**Reads:** MASTERPLAN sections 5.1, 5.2, 6.2, 7 (onboarding rows), 8.1, 11 (Day 2). Re-read SESSION_CONTEXT section 6 (Session 1 handoff).

**Deliverables:**
- [ ] Onboarding Agent (`src/agents/onboarding.agent.ts`): Gemini-backed, Urdu/Roman Urdu/English support, confidence scoring, chip fallback on low confidence.
- [ ] Cloud STT wired in `src/tools/stt.ts` with 1× retry.
- [ ] 12 scenario cards in `src/content/scenario-cards.ts`. Each card has 3–4 options and a personality-dimension contribution vector.
- [ ] Layer 1 endpoint `POST /onboarding/layer1`: accepts audio chunk OR text, returns next prompt + confidence + dimension hints.
- [ ] Layer 2 endpoint `POST /onboarding/layer2`: accepts card response, updates personality vector, returns radar state.
- [ ] Layer 3 endpoint `POST /onboarding/layer3`: Twin Forge generates 3 statements; user correction loop.
- [ ] Layer 4 endpoint `POST /onboarding/wali`: optional Wali Mode input; reconciliation with user input flagged not auto-resolved.
- [ ] `POST /onboarding/finalize`: locks Twin v1.0, stores spec + 768-dim embedding (pgvector).
- [ ] Trace emitter wired to every agent decision in onboarding workplan.

**Exit check:**
- Script in `tests/onboarding.test.ts` simulates a user through all 4 layers in <2 min.
- Twin spec in DB matches the shape in MASTERPLAN section 6.2.
- Trace for the onboarding flow has at least 15 events (workplan, tasks, decisions, tool calls).

---

### Session 3 — Twin debate + Moderator + find_matches (Day 3, ~6 hrs) — HERO DAY
**Goal:** `POST /match/request` triggers a full 5-candidate debate; SSE streams the debate live; top-3 reports include reasoning traces.

**Reads:** MASTERPLAN sections 5.3, 5.4, 5.5, 6.3, 7 (match + stream rows), 8.2, 10, 11 (Day 3).

**Deliverables:**
- [ ] User Twin agent (`src/agents/user-twin.agent.ts`): Gemini with Twin system prompt injected, temperature 0.4.
- [ ] Candidate Twin agent (same architecture, reads candidate spec from DB).
- [ ] Moderator Agent (`src/agents/moderator.agent.ts`): 8-dimension debate loop, per-dimension scoring with evidence text, dealbreaker detection, time-budget enforcement, re-anchor on Twin inconsistency.
- [ ] Prescreen module (`src/domain/prescreen.ts`): vector similarity on values + dealbreakers, reduces 12 → 5.
- [ ] 12 candidate Twins fully written in `src/content/candidates.ts` (rich backstories, diverse deen levels, cities, careers).
- [ ] find_matches workplan in `src/workplans/find-matches.workplan.ts`: kicks off via `/match/request`, returns flowId, streams to SSE, persists final reports.
- [ ] `GET /match/results/:flowId` returns the 3 CompatibilityReports.
- [ ] Baseline endpoint `GET /baseline/match`: same Twin features, simple weighted-distance ranker, no debate. (Required deliverable.)

**Exit check:**
- End-to-end on a real device: tap match → SSE stream of a full Twin debate visible → top-3 cards render with friction points.
- Hero scenario "C" (the hidden dealbreaker) demonstrably ranks differently in agentic vs baseline mode.
- Trace export for `find_matches` includes per-dimension decisions, dealbreaker flags, and one recovery event.

---

### Session 4 — Wali + Booking + Dispute (Day 4, ~5 hrs)
**Goal:** The full service-orchestration layer works: halal reveal, meeting booking with venues, dispute filing, post-meeting Twin update.

**Reads:** MASTERPLAN sections 5.6, 5.7, 5.8, 7 (booking + dispute + feedback rows), 8.3, 8.4, 11 (Day 4).

**Deliverables:**
- [ ] Wali Agent (`src/agents/wali.agent.ts`): generates structured + free-text rishta brief in Urdu and English. TTS audio URL.
- [ ] `POST /book/initiate`: kicks off book_meeting workplan. Generates wali briefs. Renders mock SMS to client.
- [ ] Booking Agent (`src/agents/booking.agent.ts`): proposes 3 slots, fetches Maps Places venues filtered for halal-friendly cafes, generates meeting card.
- [ ] `POST /book/confirm`: wali confirms slot, persists meeting record, schedules reminders.
- [ ] Maps Places tool (`src/tools/maps.ts`) with fallback to hardcoded city venue list.
- [ ] Calendar mock (`src/tools/calendar.mock.ts`).
- [ ] Dispute Agent (`src/agents/dispute.agent.ts`): severity classifier, reputation impact propagator, contradictory-account flag.
- [ ] `POST /dispute/file`: kicks off handle_dispute workplan.
- [ ] `POST /feedback/post-meeting`: 4-dimension rating, feeds Twin Forge update (v2 of the Twin).

**Exit check:**
- Full happy-path journey end-to-end via curl: onboard → match → book → meeting card → post-meeting feedback → Twin v2 stored.
- One dispute filed and resolved with visible trace.
- One Maps failure simulated → fallback to hardcoded venues, recovery event in trace.

---

### Session 5 — Polish, deploy, trace export (Day 5 AM, ~3 hrs) — SHIP DAY
**Goal:** Production deploy, all docs final, trace exports ready for submission.

**Reads:** MASTERPLAN sections 12, 13, 14. Re-read PRD section 17 (Deliverables Checklist).

**Deliverables (HARD STOP at 11:00 AM for new code):**
- [ ] Deploy to Railway. Configure env vars. Run schema migrations on production Supabase.
- [ ] README.md final pass: architecture diagram, data schemas, tools/APIs, Antigravity role, setup steps, assumptions, privacy note, cost/latency, scalability, baseline comparison, limitations.
- [ ] ANTIGRAVITY.md final pass: explicit description of every workplan, agent, tool, and trace artifact.
- [ ] Trace exports for the four workplans saved to `/traces/` directory in repo.
- [ ] One demonstrated failure-recovery scenario captured in a trace export.
- [ ] Cost analysis table (per-op, 10x, 100x, 1000x).
- [ ] Smoke test from real iOS and Android device against the deployed URL (frontend team validates).
- [ ] Tag release `v1.0.0-hackathon`.

**Exit check:**
- Submission ready: production URL live, traces exported, README complete, baseline comparison verifiable.
- Frontend team has confirmed they can hit production from both platforms.

---

## 5. Decisions made (architectural log)

> Append every decision that future sessions would want to know about.
> Format: `YYYY-MM-DD — decision — rationale`

- **2026-05-17 — TraceBus is the single chokepoint for all trace events.** Every agent/workplan/tool routes events through `src/agents/_shared/trace.ts`. There is no other path. Rationale: enforces ANTIGRAVITY.md §3 contract, prevents silent agent actions, makes the SSE stream and Supabase `traces` row trivially consistent.
- **2026-05-17 — Gemini wrapper centralizes retry + Pro→Flash fallback + auto-emits trace events.** Agents never construct a `GoogleGenerativeAI` client directly. Rationale: every LLM call gets uniform retry behaviour and shows up in the trace as `tool.call`/`tool.result`/`recovery` without per-agent boilerplate.
- **2026-05-17 — `traces` table stores both flattened columns AND the full ordered `events` JSONB.** Rationale: flattened columns (observations, decisions, tool_calls, recoveries) make SQL filtering cheap; full `events` array preserves chronological order for the trace export deliverable.
- **2026-05-17 — Server-side uses service-role Supabase client; OTP uses anon client.** Rationale: keeps service-role privileges away from auth flows the mobile client would also mirror, and the OTP path doesn't need RLS bypass.
- **2026-05-17 — `demo_*` flowIds get a synthetic heartbeat on `/stream/:flowId`.** Rationale: frontend team can wire SSE against the real endpoint shape in Session 1 even before any workplan exists.
- **2026-05-17 — `noUncheckedIndexedAccess: true` in tsconfig.** Rationale: catches `arr[i]` undefined access at compile time, which is exactly the kind of bug LLM-generated code introduces.
- **2026-05-17 — `bodyLimit: 10 MB` on Fastify.** Rationale: accommodates base64-encoded audio chunks for STT in Session 2; reassess if abused.
- **2026-05-17 — Backend lives under `backend/` subfolder of the team monorepo `https://github.com/ZakiNabeel/Lab-Viah`.** Frontend (Expo) gets its own top-level folder. We push to `backend/main` branch and PR into `main` at submission time.

---

## 6. Handoff for next session

> **Last session's handoff lives here.** Read this first thing.
> Replace this section at the end of each session.

### Handoff from Session 1 → Session 2

**Where the code is on disk:**
- Live working copy: `D:\Projects\rishtaai\backend\` (clone of `https://github.com/ZakiNabeel/Lab-Viah.git`, branch `backend/main`).
- Last commit (local, NOT pushed): `e7c4185` — `session 1: backend foundation (Fastify + Supabase + trace bus + SSE)`. **First task next session: push this commit so the team can see it.**
- Stale copy at `D:\Projects\lab-viah\backend\` should be deleted once you're sure the move was clean. It is not the live working copy any more.

**Before doing anything in Session 2:**
1. `cd D:\Projects\rishtaai\backend` and run `npm install`.
2. Create a Supabase project (free tier) if not done yet. Copy URL + service-role key + anon key + JWT secret into `.env`.
3. Open Supabase SQL Editor and paste the entire contents of `src/db/schema.sql`. Run it. Confirm 6 tables exist and `pgvector` is enabled.
4. Add `GEMINI_API_KEY` to `.env`. Verify with `curl http://localhost:3000/health/deep` — both `db.ok` and `gemini.ok` should be `true`.
5. Add `GOOGLE_APPLICATION_CREDENTIALS` pointing at a GCP service account JSON with Cloud Speech-to-Text + TTS enabled (Session 2 onboarding agent needs STT).
6. Re-read MASTERPLAN sections 5.1, 5.2, 6.2, 8.1.

**Useful entry points for Session 2 work:**
- New agent goes in `src/agents/onboarding.agent.ts`. Use the `geminiCall(input, bus)` helper from `src/agents/_shared/gemini.ts` — it automatically traces.
- Trace emissions in agent code should use the helpers from `src/agents/_shared/trace.ts`: `obs(bus, 'onboarding', '…')`, `decide(bus, 'onboarding', 'go layer 2', 'confidence > 0.8')`, `recover(bus, '…', '…')`.
- Workplan entry-point: `startTrace('onboarding_flow', { userId })` → returns a `TraceBus`. At end, call `endTrace(bus, { twinId })`. The trace persists to Supabase automatically.
- Route registration pattern is in `src/routes/auth.routes.ts`. Use Zod for body validation, return `ApiResponse<T>`.

**Half-finished work / things to know:**
- Nothing is half-finished. Session 1 closed cleanly.
- `/health/deep` will call Gemini on every hit — don't put it in a cronjob.
- The `traces` table has a `flow_id` column (text). `randomUUID()` is used by default but workplans can pass their own (the SSE demo path uses `demo_*` prefix).
- Vitest setup at `tests/setup.ts` stubs env vars with placeholders. Real integration tests must override these via `process.env` before importing.
- TS config uses `noUncheckedIndexedAccess` so `arr[0]` is typed as `T | undefined`. Expect lots of `if (x)` guards.
- ESM-only build (`"type": "module"`). All relative imports must end in `.js` (TS will resolve them to `.ts` files).

**Anything weird:**
- Phone OTP via `supabasePublic.auth.signInWithOtp({ phone })` depends on Supabase project having an SMS provider configured. In dev, Supabase has a test provider — set test phone numbers in the Supabase dashboard before trying to verify. Real Twilio not needed until/unless we want live OTP on the demo device.
- The `ivfflat` index in `schema.sql` is created on an empty table. After Session 3 seeds 12 candidate twins, run `REINDEX INDEX twins_embedding_idx;` for it to build properly. Note in Session 3.

---

## 7. Out-of-scope reminders

These have come up and been deferred. Do not silently build them.

- Real SMS sending — explicitly mocked per MASTERPLAN section 13.
- Reinforcement learning — explicitly rejected. Use weighted-scoring + Moderator reasoning instead.
- Reddit scraping — explicitly rejected.
- Web app — out of scope; mobile-only per Challenge 2.
- Human-to-human chat — out of scope.
- Real payments — pricing tier display only; no Stripe / payment processor.

---

## 8. Risk log

| Risk | Status | Mitigation in place? |
|---|---|---|
| Antigravity workplan auth/setup eats Day 1 | mitigated | ANTIGRAVITY.md drafted and trace contract locked in Session 1. |
| Gemini latency >5s in Moderator | open | Pro→Flash fallback baked into `geminiCall`. Pre-cache hero scenarios in Session 5. |
| Cloud STT poor on Roman Urdu | open | Chip-based fallback path to be implemented in Session 2. |
| Frontend integration mismatch | mitigated for SSE | `demo_*` flowId heartbeat lets frontend wire SSE before agents exist. Full OpenAPI-style spec still due end of Session 2. |
| Supabase free tier rate limits | open | Self-host fallback ready (out of scope unless triggered). |
| Demo flakiness during recording | open | Pre-record hero debate, run cached version Day 5. |
| **NEW: Schedule risk — 3 calendar days remaining** | open | MASTERPLAN §11 budgets 5 days starting Fri 15 May; we started Sun 17 May. Session 2 must compress onboarding + Twin Forge into one focused block, OR we drop Layer 4 Wali Mode from onboarding (it's already "optional" per MASTERPLAN §5.2) and reclaim ~90 min for Day 3 hero work. |
| **NEW: Git linkage deferred** | open | User said they will link real repo later. Risk: if delayed past Session 2, we lose the ability to checkpoint work and recover from a bad edit. Raise loudly at Session 2 start. |

---

*End of SESSION_CONTEXT. Last touched: 2026-05-17 by Session 1. Next read: at start of Session 2.*
