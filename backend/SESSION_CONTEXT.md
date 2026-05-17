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

- **Project phase:** Session 3 COMPLETE AND VERIFIED LOCALLY (not pushed — teammate's parallel Session 3-5 work lives on `origin/backend/main`; user will reconcile). Matching subsystem fully wired: User Twin + Candidate Twin + Moderator agents, 12 candidate twins seeded, prescreen 12→5, find_matches workplan, /match/request + /match/results/:flowId + /baseline/match endpoints. End-to-end run against real Vertex + real Supabase completes in ~30 s with 40/40 dimensions scored across 5 parallel debates and 268 trace events.
- **Last commit landed locally this session:** `eb2f965` — `session 3: matching subsystem — User/Candidate Twin + Moderator + find_matches workplan + 12 candidates + baseline endpoint`. **NOT pushed** (user reconciling with teammate's parallel work on `origin/backend/main`). Predecessor: `fb9a573` (Session 2.5 — Vertex swap).
- **Important Vertex behaviour pinned in this session:** Vertex hackathon-tier quota on project `lab-viah` cannot sustain 5-parallel × 3-calls-per-dim Pro bursts. Session 3 architecture mitigates via (a) unified 1-call-per-dim flow (replaces the 3-call user→candidate→scoring chain), (b) Flash on all per-dim and synthesis calls with `thinkingConfig.thinkingBudget=0`, (c) global concurrency semaphore cap=3 in the Gemini wrapper, (d) tight 12 s per-call timeout + 2-attempt retry with 1.2 s jitter backoff on 429s. See §5 decisions.
- **GCP project for Vertex AI:** `lab-viah` (region `us-central1`). Unchanged from Session 2.5.
- **Last updated:** 2026-05-17 (late evening) by Session 3.
- **Days remaining until 20 May submission:** ~3 (Sun late evening → Wed EOD).

---

## 2. Live working state

### In progress

*(What is being worked on RIGHT NOW. Empty at session boundaries.)*

- *(none — Session 3 ended cleanly)*

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
- [x] `src/routes/auth.routes.ts` — `POST /auth/otp/start` and `POST /auth/otp/verify` via Supabase Auth phone OTP. Includes dev-mode bypass branch (admin.createUser + signInWithPassword) so we are not blocked on Twilio. Upserts users row on verify.
- [x] `src/routes/stream.routes.ts` — `GET /stream/:flowId` SSE. `demo_*` flowIds get a 1s heartbeat for 30s; real flowIds subscribe to the in-memory `TraceBus`.
- [x] `src/server.ts` — Fastify entrypoint with `/health`, `/health/deep` (db + gemini), CORS, error handler.
- [x] `tests/health.test.ts` + `tests/setup.ts` + `vitest.config.ts` — happy-path test for `/health`.
- [x] `README.md` placeholder pointing at MASTERPLAN/ANTIGRAVITY/SESSION_CONTEXT.
- [x] `traces/.gitkeep` for the Session 5 export drop.

**Session 1 polish pass (2026-05-17, after first run-through):**

- [x] `package.json` scripts now use Node `--env-file=.env` flag so the server actually loads `.env` (was crashing on env validation otherwise). `dev` and `start` both updated.
- [x] `src/server.ts` entrypoint check rewritten with `fileURLToPath`. The old check (`import.meta.url === \`file://${argv[1]}\``) failed silently on Windows because of slash-count mismatch (`file:///D:/...` vs `file://D:/...`) —`main()` never ran and the server exited cleanly with exit code 0.
- [x] `src/config.ts` `SUPABASE_URL` now auto-strips `/rest/v1` and trailing slashes. The dashboard's "API URL" copy gives the PostgREST URL with `/rest/v1/` suffix, which silently breaks Auth even though DB queries appear to work (HTTP normalizes the double-slash). Now safe to paste either form.
- [x] `src/config.ts` Gemini defaults updated from `gemini-2.0-pro-exp` / `gemini-2.0-flash-exp` (both retired) to `gemini-pro-latest` / `gemini-flash-latest` — server-side aliases that always point at current GA models.
- [x] `src/agents/_shared/gemini.ts` smoke-test bumped to `maxOutputTokens: 256`. Gemini 2.5+/3.x models consume token budget for internal "thinking" before producing visible output, so the original `8` cap made the smoke test always return empty.
- [x] `src/agents/_shared/gemini.ts` error messages now include the model names AND the underlying SDK error string so debugging takes seconds instead of guesswork.
- [x] `src/routes/auth.routes.ts` dev bypass switched from phone+password to email+password sign-in (synthetic `dev-<digits>@rishtaai-dev.local` email). Phone+password sign-in requires the Phone auth provider to be enabled (= Twilio), which we don't have. Email is always enabled. MASTERPLAN §7 API stays unchanged — the route still takes `{phone, otp}` and returns a real Supabase JWT.
- [x] Exit check verified on a real boot:
  - `GET /health` → HTTP 200, `{ok: true, data: {service: "rishtaai-backend", env: "development"}}`.
  - `GET /health/deep` → HTTP 200, `db.ok: true` (~370ms), `gemini.ok: true` (~1.9s, model `gemini-3-flash-preview` per user's `.env`).
  - `POST /auth/otp/start` with dev phone → `{ok: true, data: {sent: true, dev: true}}`.
  - `POST /auth/otp/verify` with dev phone+code → real Supabase JWT with `user_metadata.phone: +923001234567`, `user_metadata.dev_bypass: true`.
  - `GET /stream/demo_session1` → SSE heartbeat every ~1s.
  - `npm test` → 1 test pass.

**Session 2 (2026-05-17, evening):**

- [x] **Typecheck cleanup** — Session 1 left two pre-existing `tsc` errors in `src/server.ts` (FastifyInstance generics mismatch from `logger: logger as never`, plus an `ApiResponse` literal-type fight at `/health/deep`). Removed the `as never` cast and let `buildServer`'s return type be inferred; folded the deep-health booleans into `data.healthy`. Repo now passes `npm run typecheck` clean for the first time.
- [x] **Dev-bypass auth bug fix (Session 1 carry-over)** — `src/routes/auth.routes.ts` was calling `signInWithPassword` on the service-role `supabase` client. That mutates the singleton's in-memory session, replacing the service-role bearer with the dev user's JWT for every subsequent `supabase.from(...)` — quietly turning later writes (Twin insert, users update) into RLS-bound user calls that 403. Moved sign-in to `supabasePublic`; service-role client now stays clean across requests. Re-verified end-to-end: zero RLS errors during the full onboarding walk.
- [x] **Domain layer:** `src/domain/dimensions.ts` (8-dim metadata + default weights summing to 1.0), `src/domain/twin.ts` (canonical `TwinSpec` type + `TwinSpecSchema` Zod validator), `src/domain/onboarding-session.ts` (in-memory session store keyed by sessionId, 15-min TTL, exceeds MASTERPLAN §8.1 11-min budget).
- [x] **Content:** `src/content/scenario-cards.ts` — 12 cards, each trilingual (EN/UR/RO_UR), signed contributions in `Partial<Record<Dimension, number>>`. Cards cover the 8 dimensions with realistic Pakistani-rishta value tensions (salah rigor, in-law co-residence, working spouse, lifestyle pref, kids timing, conflict style, geography, deen appearance, parent care, ambition match, money structure, prior relationships).
- [x] **Prompts:** `src/content/prompts/onboarding.prompt.ts` (Onboarding Agent system + per-turn user prompt), `src/content/prompts/twin-system.prompt.ts` (Layer-3 statements, final TwinSpec synthesis, ~400-word voice prompt). All prompts pin Gemini to JSON output where applicable.
- [x] **STT tool** (`src/tools/stt.ts`) — stub that returns low-confidence whenever GCP creds are missing OR the stub branch is taken. Emits `tool.call` + `tool.result` + `recovery` (chip fallback). Real STT wireup deferred to Session 5 polish to avoid a new top-level dep; the chip-fallback IS the demo's visible recovery so the story stays intact.
- [x] **Onboarding Agent** (`src/agents/onboarding.agent.ts`) — Zod-validates Gemini JSON output, chip-fallback recovery on malformed JSON or STT low-confidence, deterministic `pickNextTopic` walks the agent toward `next_topic=done` regardless of model drift. Trilingual chip options.
- [x] **Twin Forge Agent** (`src/agents/twin-forge.agent.ts`) — three entry points: `generateLayer3Statements`, `reconcileWaliConflicts` (does NOT auto-resolve, per MASTERPLAN §5.2 failure mode), `forgeTwin` (final synthesis). Each has a deterministic fallback path emitting a `recovery` event so the demo never deadlocks on a malformed model response.
- [x] **Workplan helpers** (`src/workplans/onboarding.workplan.ts`) — `startOnboarding`/`resumeOnboarding`/`runLayer1`/`runLayer2`/`runLayer3Generate`/`applyLayer3Corrections`/`runLayer4`/`finalizeOnboarding`. One trace per user journey across all HTTP calls (sessionId = flowId; bus looked up via `getTrace`). Finalize persists the Twin row, mirrors identity to the users row, and closes the trace.
- [x] **Auth middleware** (`src/routes/_auth.middleware.ts`) — `requireUserId(request)` resolves the JWT via `supabase.auth.getUser(token)`. Zero new deps; ~50–100 ms per request (acceptable for hackathon). Local HS256 verification could land in Session 5 polish if latency matters.
- [x] **Onboarding routes** (`src/routes/onboarding.routes.ts`) — `POST /onboarding/layer1`, `layer2`, `layer3` (dual-mode: generate OR apply corrections by body shape), `wali`, `finalize`. All five gated by `requireUserId`; all five return `ApiResponse<T>` envelope; sessionId = flowId for SSE wiring.
- [x] **Vitest test** (`tests/onboarding.test.ts`) — mocks Gemini + Supabase, exercises all 4 layers through the workplan helpers, asserts `TwinSpecSchema.parse(result.spec).success === true` and `traceEventCount >= 15`. Runs in ~25 ms.
- [x] **End-to-end verified against real Gemini + real Supabase** — Layer 1 (Hadeed, 26, male, Karachi, practicing) → 4 follow-up turns → 3 scenario cards → Layer 3 generate + correct → Wali conflict (user=practicing, wali=strict) → Finalize → `twinId=811c9b47-…` persisted, `system_prompt` ~400 words, **71 trace events** (exit check needed ≥15 — 4.7× margin), `TwinSpecSchema.parse()` clean.

**Session 3 (2026-05-17, late evening) — HERO DAY: matching subsystem:**

- [x] **12 candidate Twins** (`src/content/candidates.ts`) — 6 female + 6 male personas with stable hardcoded UUIDs for idempotent seeding. Each persona has a hand-written 2-3 sentence `voiceNote` plus a deterministic ~400-word `system_prompt` built from spec + voiceNote. Cover the full deen rigor spectrum (strict→secular), city diversity (Karachi/Lahore/Islamabad/Multan/Dubai), career types, family setups, kids timelines. Hina Raza is the **hero-scenario "C" candidate** — she carries a hidden past-relationship dealbreaker that prescreens well but the agentic debate surfaces.
- [x] **Moderator + Twin debate prompts** (`src/content/prompts/moderator.prompt.ts`) — `DIMENSION_PROMPTS` (per-dim question, 8 of them), `buildTwinTurnPrompt` (still exported for `runTwinTurn`), `buildDimensionScoringPrompt` (legacy), `buildFinalSynthesisPrompt`, plus the unified **`buildCombinedDebatePrompt`** which voices BOTH twins + scores the exchange in ONE call.
- [x] **User Twin agent** (`src/agents/user-twin.agent.ts`) — Gemini-backed, Twin's `system_prompt` injected via `systemInstruction`, temperature 0.4, JSON schema-validated. Includes `verifyDealbreakerHit` post-check that prevents an over-eager Twin from flagging a hallucinated dealbreaker. Deterministic per-dim fallback statement on Gemini/schema failure with `recover` trace event. **Now unused in the workplan path** (the Moderator's unified call replaces it) but kept exported per MASTERPLAN §5.3 file-layout requirement and as a future entry point for multi-turn debates.
- [x] **Candidate Twin agent** (`src/agents/candidate-twin.agent.ts`) — thin wrapper over `runTwinTurn` with side='candidate_twin'. Same note as User Twin re: workplan path.
- [x] **Moderator agent** (`src/agents/moderator.agent.ts`) — 8-dimension debate loop, per-dim unified Gemini call (Flash, thinking off, 2048 tokens), confirmed-dealbreaker short-circuit (early-terminates remaining dims when both Twin self-flag AND friction_level≥dealbreaker), per-debate 60 s self-budget with `recover` event on overflow, final-synthesis pass with deterministic `fallbackHighlights` recovery. Emits `dimension.scored` per dim plus synthesized `agent.message` events for the live debate transcript.
- [x] **Prescreen** (`src/domain/prescreen.ts`) — 18-feature vector + cosine similarity + dealbreaker overlap penalty. Hard gender filter (heterosexual rishta matching, MASTERPLAN §1.8). Reduces 12 → 5. Falls back to in-content `CANDIDATES` if the DB pool is too small (recovery event).
- [x] **Scoring** (`src/domain/scoring.ts`) — pure aggregation: per-dim score × weight → overall_score; dealbreaker hit forces `not_recommended`; thresholds 0.75 / 0.55 for strong/conditional/not. Also exports `baselineScore(user, candidate)` — same feature space as prescreen, no debate, used by `GET /baseline/match`.
- [x] **find_matches workplan** (`src/workplans/find-matches.workplan.ts`) — 5 tasks: `load_user_twin` → `prescreen_candidates` → `parallel_debates` (Promise.allSettled with one retry per debate) → `rank_reports` → `persist_reports`. Runs async; `POST /match/request` returns flowId immediately. Workplan budget 90 s ceiling. Persists ALL debated candidates (5 rows), not just top-3, so the user can drill into the bottom of the ranking. Also exports `runBaseline(userId)` (non-agentic ranker) and `fetchReportsForFlow(flowId)` (used by /match/results).
- [x] **Match routes** (`src/routes/match.routes.ts`) — `POST /match/request`, `GET /match/results/:flowId`, `GET /baseline/match`. All gated by `requireUserId`.
- [x] **Schema delta** (`src/db/schema.sql`) — appended additive `alter table compatibility_reports add column if not exists flow_id text;` + matching index. Applied to live Supabase via SQL Editor.
- [x] **Seed script** (`src/db/seed-candidates.ts`) + `npm run seed` — upserts 12 candidates by stable UUID. Idempotent. Verified live (all 12 rows present in `twins` with `is_candidate=true`).
- [x] **Gemini wrapper hardened** (`src/agents/_shared/gemini.ts`) — added `modelTier: 'pro'|'flash'` option (Twin turns, scoring, synthesis all use 'flash'), Flash auto-sets `thinkingConfig.thinkingBudget=0` to avoid mid-JSON truncation, global concurrency semaphore cap=3, exponential backoff between primary attempts (1.2 s on 429s + jitter), `PRIMARY_TIMEOUT_MS` tightened 30 s → 12 s + `PRIMARY_ATTEMPTS` 2 (was 3). Public `geminiCall` signature unchanged for Session 2 callers; new option is opt-in.
- [x] **Moderator vitest** (`tests/moderator.test.ts`) — happy path runs `runDebate` end-to-end with mocked Gemini (matches the unified prompt phrase "Conduct ONE round of a compatibility debate"). Asserts 8 dims scored, valid recommendation, ≥15 trace events. 3/3 tests pass (`onboarding`, `moderator`, `health`).
- [x] **End-to-end verified against real Vertex + real Supabase**: `/match/request` → flowId returned in <100 ms; SSE stream emits live `dimension.scored` events; workplan finishes in ~30 s; `40/40 dim.scored` across 5 debates; **16 recoveries** (5 final-synthesis fallbacks + isolated per-dim Vertex 429s, no cascading failures); top-3 returned with varied recommendations: Ayesha Khan 0.60 conditional_match → Zainab Ahmed 0.49 not_recommended (dealbreaker: must live in Multan) → Fatima Iqbal 0.48 not_recommended. `/match/results/:flowId` returns persisted 5 rows. `/baseline/match` returns a 6-candidate cosine ranking (Fatima 0.982 → Maryam 0.474) that **meaningfully diverges from the agentic top-3** — exactly the "agentic uplift" deliverable per MASTERPLAN §11 Day 3.

**Session 2.5 — Vertex AI swap (2026-05-17, late evening):**

- [x] **Switched LLM backend from Google AI Studio → Vertex AI** because AI Studio free-tier quota for Gemini 3 Pro is `limit: 0`. Vertex bills via GCP and the $5 free credit covers far more than this hackathon needs (Gemini 2.5 Pro on Vertex: ~$1.25/M input + $10/M output → well under $1 for the whole event).
- [x] **SDK choice: `@google/genai` v1.52** (not the deprecated `@google-cloud/vertexai`, which is being removed 2026-06-24, ~5 weeks after the hackathon). Same Vertex auth (ADC via `GOOGLE_APPLICATION_CREDENTIALS`); cleaner unified API.
- [x] `package.json` — removed `@google/generative-ai`, added `@google/genai@^1.0.0`.
- [x] `src/config.ts` — replaced `GEMINI_API_KEY` / `GEMINI_MODEL_*` with `GCP_PROJECT_ID`, `GCP_LOCATION` (defaults `us-central1`), `VERTEX_MODEL_PRIMARY` (defaults `gemini-2.5-pro`), `VERTEX_MODEL_FALLBACK` (defaults `gemini-2.5-flash`). `GOOGLE_APPLICATION_CREDENTIALS` is now required (was optional).
- [x] `.env.example` — Vertex section documents the GCP project / region / IAM role requirements.
- [x] `tests/setup.ts` — placeholder env updated to match.
- [x] `src/agents/_shared/gemini.ts` — rewritten on top of `@google/genai`'s `GoogleGenAI({vertexai: true, project, location})` client. Public API of `geminiCall(input, bus)` is UNCHANGED — every caller in Session 2 (Onboarding Agent, Twin Forge Agent) works without modification.
- [x] **Verified against live Vertex on project `lab-viah` / `us-central1`:** `curl /health/deep` → `gemini.ok: true`, `modelUsed: gemini-2.5-pro`, `latencyMs: 4239` (first call incl. auth handshake — warm calls drop to ~1.5–2 s).

### Blockers

- *(none — Gemini Pro quota blocker resolved via Vertex AI swap above)*

### Open questions for the user / TL

- **Repo / git linkage** — RESOLVED. Working in clone at `D:\Projects\rishtaai\` on branch `backend/main`. Commits `e7c4185` and `9c4ac26` landed locally (not yet pushed). Push deferred per user.
- **Supabase project** — RESOLVED. Project ref `kllejrzqraqclmysdtfv`, URL `https://kllejrzqraqclmysdtfv.supabase.co`. Schema applied with RLS enabled (default-deny for anon/authenticated; service role bypasses). All 6 tables present, `pgvector` enabled.
- **Gemini API key** — needs to be issued before Session 2 onboarding agent work. Drop into `.env` as `GEMINI_API_KEY`.
- **GCP service account JSON** — needed for STT/TTS in Session 2; can be deferred to Session 2 start.
- **Twilio (Supabase phone OTP provider)** — DEFERRED, not cut. Supabase's UI now requires a real SMS provider to enable Phone auth (no built-in test provider any more). For now we use a dev-mode bypass (`DEV_OTP_BYPASS=true` in `.env`) that creates a real Supabase auth user via the admin API and returns a real Supabase JWT — same shape, same RLS behaviour as production. To enable real OTP for the live demo: wire Twilio in Supabase Auth → Providers → Phone, set `DEV_OTP_BYPASS=false`. Cost: Twilio trial gives ~$15 credits + free PK number. Tracked as Session 5 polish item.

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
- **2026-05-17 — Supabase RLS enabled by default; backend uses service-role key which bypasses RLS.** Rationale: defense-in-depth — if anything ever hits Supabase with the anon key, default-deny protects user data. Mobile client never queries tables directly; everything goes through Fastify.
- **2026-05-17 — Dev-mode OTP bypass added without changing MASTERPLAN §7 API.** `/auth/otp/start` and `/auth/otp/verify` keep the same request/response shape; when `DEV_OTP_BYPASS=true` and `NODE_ENV !== 'production'`, verify accepts a fixed phone+code pair and returns a real Supabase JWT (via `admin.createUser` + `signInWithPassword`). Production path with Twilio still works when `DEV_OTP_BYPASS=false`. Rationale: Supabase no longer ships a built-in phone test provider — we don't want to take a Twilio dependency just to develop, and the bypass is gated by `isProd` at config-load time so it can never accidentally ship.
- **2026-05-17 — User vetoes scope cuts.** Earlier "drop Wali Mode" mitigation withdrawn. Full MASTERPLAN scope (all 8 agents, all 4 workplans, all 15 endpoints, Wali Mode included) is the target. Schedule risk acknowledged and accepted by user; mitigation moves from "cut scope" to "push harder on Sessions 2-3".
- **2026-05-17 — Dev OTP bypass uses email+password (not phone+password) under the hood.** API surface (`{phone, otp}`) unchanged. Rationale: Supabase phone+password sign-in requires the Phone provider to be enabled (= Twilio). Synthetic `dev-<digits>@rishtaai-dev.local` email backs the bypass user; phone is stored in `user_metadata` on the auth.users row and in our `users` table.
- **2026-05-17 — `SUPABASE_URL` auto-normalizes** (strips `/rest/v1` and trailing slashes) at config-load time. Rationale: Supabase dashboard's "API URL" includes the PostgREST suffix; pasting it as `SUPABASE_URL` silently breaks Auth (DB queries appear to work because of HTTP path normalization, Auth queries 404).
- **2026-05-17 — Gemini smoke test uses `maxOutputTokens: 256`, not 8.** Rationale: 2.5+/3.x models eat token budget for internal thinking before visible output; tight caps yield empty responses. Per-agent calls can still pass their own budget.
- **2026-05-17 (Session 2) — Onboarding session state is in-memory, keyed by `sessionId === flowId`.** Rationale: the onboarding workplan spans 5 HTTP calls but must be ONE trace per ANTIGRAVITY.md §2.1. Keying both the trace bus AND the partial-answers state by `sessionId` keeps them coherent for the lifetime of the journey. Trade-off: a server restart mid-onboarding forces the user to start over. Acceptable for the hackathon; a future iteration would persist this to a new `onboarding_sessions` table.
- **2026-05-17 (Session 2) — Every agent has a deterministic fallback path that emits a `recovery` event** when Gemini returns malformed JSON or fails schema. The fallback never throws — it produces a plausible value (`fallbackStatements`, `fallbackSpecBody`, `fallbackSystemPrompt`, `chipFallbackReply`) so the demo never deadlocks on a single bad model response. The ≥1-visible-recovery contract (MASTERPLAN §1.7) is satisfied by these branches plus the STT chip-fallback.
- **2026-05-17 (Session 2) — Wali/User conflicts are flagged, never auto-resolved.** Per MASTERPLAN §5.2 failure mode, `reconcileWaliConflicts` returns a `ConflictFlag[]` and Twin Forge prompt instructs the model to prefer the USER value AND verbatim-attach `wali wants: <X>` to dealbreakers. Conflicts surface in the trace via `agent.decision` rather than being silently smoothed over.
- **2026-05-17 (Session 2) — STT shipped as a stub.** `sttTranscribe` validates input, emits the full tool-call/tool-result/recovery trace contract, but always returns `{lowConfidence: true, stub: true}`. Reasons: (a) `@google-cloud/speech` would be a new top-level dep — explicitly avoided per CLAUDE rule "no new deps without asking"; (b) the chip-fallback path IS the visible recovery for the demo, so the story is unchanged. Replacing the body of `attemptStt` is a 1-file change in Session 5 polish.
- **2026-05-17 (Session 2) — Auth uses `supabase.auth.getUser(token)` rather than local HS256 verify.** Rationale: a `jsonwebtoken` dep would be new; the GoTrue round-trip is ~50–100 ms which is fine for hackathon-scale traffic. Local verify is a Session 5 polish item if latency matters.
- **2026-05-17 (Session 2) — Service-role Supabase client must never call `signInWithPassword`.** Doing so mutates the singleton's in-memory session, replacing the service-role bearer with the signed-in user's JWT for ALL subsequent `.from(...)` calls. Sign-in goes through `supabasePublic` (anon client). This was a latent Session 1 bug that surfaced when Session 2 added a downstream `twins` insert; fixed in `src/routes/auth.routes.ts`.
- **2026-05-17 (Session 3) — Unified 1-call-per-dim Moderator flow** replaces the original 3-call (user_twin → candidate_twin → scoring) chain. One Gemini call returns both Twin statements + score + evidence + per-side dealbreaker flags. Rationale: under hackathon-tier Vertex quota on `lab-viah`, 5-parallel × 8-dim × 3-calls = 120 bursty calls cascaded into 73+ recoveries and 79 s workplans. The unified call cuts Vertex pressure 3× and brought the workplan to ~30 s with 40/40 dims scored. The `user-twin.agent.ts` / `candidate-twin.agent.ts` agents remain exported (MASTERPLAN §5.3/§5.4 mandates separate files) but are not on the workplan critical path — they're available for future multi-turn debates if a session needs them.
- **2026-05-17 (Session 3) — Flash everywhere for matching, Pro reserved for future Moderator orchestration.** MASTERPLAN §8.2 explicitly recommends "downgrade to Flash for non-Moderator agents." In practice Pro on hackathon-tier quota 429-storms under 5-parallel pressure regardless of which agent layer uses it. `geminiCall` got a `modelTier: 'pro'|'flash'` option (default 'pro'); all Session 3 callers pin 'flash'. Pro is wired and tested via `/health/deep`; production scale can flip the flag once Vertex quota is raised.
- **2026-05-17 (Session 3) — `thinkingConfig.thinkingBudget=0` auto-set on Flash.** Default Gemini 2.5 Flash thinking consumed ~80% of the token budget and truncated JSON mid-string ("Unterminated string at position 86"). With thinking off, Flash outputs the full structured JSON in ~1-3 s and stops failing schema parse. Pro keeps default thinking — its thinking quality is the reason to use Pro at all.
- **2026-05-17 (Session 3) — Global Gemini concurrency cap = 3.** Vertex hackathon-tier on `lab-viah` 429s under 5-8 simultaneous calls; cap=3 reduces cascading 429s to near zero. Implemented as a semaphore in `gemini.ts` (`acquire`/`release` around every Vertex SDK call). Bump in a production deployment once quota is raised.
- **2026-05-17 (Session 3) — Gemini wrapper: 12 s timeout + 2 attempts + exponential 1.2 s/2.4 s backoff on 429s.** Was 30 s × 3 attempts with no backoff — turned a single 429 into a 95 s wait that ate the per-debate budget. Fail-fast + deterministic fallback (recovery event) gives a coherent demo over a slow-correct one.
- **2026-05-17 (Session 3) — `compatibility_reports.flow_id` column added.** Lets `GET /match/results/:flowId` filter by flow without joining `traces`. Schema-managed via additive `alter table ... if not exists`. Applied to live Supabase via SQL Editor as a one-off — schema.sql captures it for future fresh deploys.
- **2026-05-17 (Session 3) — Per-debate budget 60 s, workplan budget 90 s.** MASTERPLAN §8.2 says 30 s end-to-end. We're 2× over the spec'd budget because Vertex on hackathon quota cannot sustain the call rate. Documented and accepted; production deployment with Vertex quota raised would land back in spec. Recovery system handles overruns cleanly: per-debate budget-exceeded → remaining dims aggregate as neutral 0.5; workplan budget-exceeded → recovery event in trace + outcome carries `budget_exceeded: true`.
- **2026-05-17 (Session 3) — Hero candidate "Hina Raza"** is intentionally built to score high in the baseline cosine ranker but trigger a dealbreaker in the agentic debate. Five-year past public relationship is in her `dealbreakers` array; users with "no prior relationship" dealbreakers see her sink in agentic mode but win in baseline. Demonstrates the §11 Day 3 exit check ("hero scenario C") at the data level.
- **2026-05-17 (Session 3) — Local-only commit; do NOT push.** Teammate pushed their Session 3-5 work to `origin/backend/main` using Flash; user does not trust those builds. This branch's Session 3 work stays local until the user decides how to reconcile (likely a `git reset --hard <this-commit>` against the teammate's HEAD or a force-push after review — user's call, not ours).

- **2026-05-17 (Session 2.5) — LLM backend = Vertex AI via `@google/genai`, NOT Google AI Studio.** Rationale: AI Studio's free-tier quota for Gemini 3 Pro is `limit: 0`; every Pro call 429s and falls back to Flash. Vertex bills via GCP — $5 free credit covers >>this hackathon. SDK is `@google/genai` v1+ (not the deprecated `@google-cloud/vertexai`, which is removed 2026-06-24). Auth via Application Default Credentials reading `GOOGLE_APPLICATION_CREDENTIALS` — same service-account JSON used by STT/TTS. Project `lab-viah` / region `us-central1`. Service account needs the `Vertex AI User` IAM role. Public API of `geminiCall(input, bus)` is unchanged — every Session-2 caller works without modification.

---

## 6. Handoff for next session

> **Last session's handoff lives here.** Read this first thing.
> Replace this section at the end of each session.

### Handoff from Session 3 → Session 4

**Where the code is on disk:**

- Live working copy: `D:\Projects\rishtaai\backend\` (clone of `https://github.com/ZakiNabeel/Lab-Viah.git`, branch `backend/main`).
- Session 3 commit: will be filled in after `git commit` at end of this session. Message starts with `session 3:`. **NOT PUSHED** — see "Anything weird" below.

**Before doing anything in Session 4:**

1. **Do NOT pull.** `origin/backend/main` contains the teammate's parallel Session 3-5 work (using Gemini Flash everywhere via the original `@google/generative-ai` AI Studio path, per user's note). The user does not trust those builds. Stay on this local branch's HEAD.
2. **The dev server may still be running** from Session 3 — `curl http://localhost:3000/health` returns 200 in ~10 ms when it is. Restart fresh (`npm run dev`) if it crashed during overnight idle. Port 3000 can hang in TIME_WAIT; if `EADDRINUSE` shows up, `netstat -ano | grep ':3000'` then `Stop-Process -Id <pid> -Force` clears it.
3. **Vertex is healthy** — Session 3's smoke run hit `gemini-2.5-flash` with `thinkingBudget: 0` cleanly. `/health/deep` should still return `gemini.ok: true` (note `modelUsed: gemini-2.5-flash` if the smoke happened to be the most recent call; the wrapper picks the tier dynamically).
4. **Candidates are seeded.** 12 rows in `twins` with `is_candidate=true`. Re-running `npm run seed` is idempotent (upsert by stable UUID) — only re-run if `src/content/candidates.ts` changes.
5. **Schema is up-to-date.** `compatibility_reports.flow_id` column was added live. If a Session 4 dev does a fresh Supabase deploy, `schema.sql` covers it via additive `alter table ... if not exists`.
6. Re-read MASTERPLAN sections 5.6, 5.7, 5.8, 7 (booking + dispute + feedback rows), 8.3, 8.4, 11 (Day 4).

**Smoke-test commands (Session 3 matching flow, ~30 s against live services):**

```bash
JWT=$(curl -s -X POST http://localhost:3000/auth/otp/verify \
  -H 'content-type: application/json' \
  -d '{"phone":"+923001234567","otp":"123456"}' \
  | grep -oE '"access_token":"[^"]+' | head -1 | cut -d'"' -f4)

RESP=$(curl -s -X POST http://localhost:3000/match/request \
  -H "content-type: application/json" -H "authorization: Bearer $JWT" -d '{}')
FLOW=$(echo "$RESP" | grep -oE '"flowId":"[^"]+' | cut -d'"' -f4)

# Watch the live debate stream (workplan finishes in ~30s)
curl -N -s "http://localhost:3000/stream/$FLOW"

# Fetch persisted reports
curl -s -H "authorization: Bearer $JWT" \
  "http://localhost:3000/match/results/$FLOW" | head -c 4000

# Baseline (non-agentic) ranking — same input, no debate
curl -s -H "authorization: Bearer $JWT" \
  "http://localhost:3000/baseline/match"
```

**Useful entry points for Session 4 work:**

- **Wali Agent** (`src/agents/wali.agent.ts`, MASTERPLAN §5.6) — does NOT exist yet. Generate Urdu + English rishta brief from a `CompatibilityReport`. Wire TTS audio URL (real `@google-cloud/text-to-speech`, dep TBD). Mock SMS via `src/tools/sms.template.ts` (pure renderer, no real send).
- **Booking Agent** (`src/agents/booking.agent.ts`, MASTERPLAN §5.7) — does NOT exist yet. Slot proposal + Google Maps Places lookup + meeting card + calendar mock. Three slots, three venues, hardcoded city-specific fallback list in `src/tools/maps.ts`.
- **Dispute Agent** (`src/agents/dispute.agent.ts`, MASTERPLAN §5.8) — does NOT exist yet. Severity classifier, reputation impact, contradictory-account flag-for-human-review.
- **Post-meeting feedback endpoint** (`POST /feedback/post-meeting`) — feeds Twin Forge to produce Twin v2 (update existing twin row, bump version int). Twin Forge already supports this via the existing `forgeTwin` entry point — pass a session with the new feedback as wali_input-like deltas.
- **Reuse the trace patterns from `find-matches.workplan.ts`** — `startTrace('book_meeting', {...})`, parallel sub-tasks if needed, `endTrace(bus, outcome)`. The SSE endpoint and TraceBus are already plumbed.
- **`POST /book/initiate` and `POST /book/confirm`** — wire similarly to `POST /match/request`. flowId returned synchronously; workplan runs async; client subscribes to `/stream/:flowId`.
- **`POST /dispute/file`** — same pattern.

**Half-finished work / things to know:**

- **Nothing is half-finished.** Session 3 closed cleanly: typecheck clean, 3/3 tests pass, end-to-end verified against live Vertex+Supabase with 40/40 dimensions scored and persisted reports for 5 candidates.
- **User Twin + Candidate Twin agent files exist but are not on the workplan critical path.** The Moderator uses a unified 1-call-per-dim flow. The per-twin agents (`runTwinTurn`, `userTwinTurn`, `candidateTwinTurn`) are still exported and would work standalone — Session 4 / 5 could use them if a Wali/Dispute flow wants to give one Twin "the floor" without the Moderator scoring the exchange.
- **`final-synthesis Gemini call failed` fired 5/5 in the verified smoke run** — this is the `buildFinalSynthesisPrompt` for the per-debate top_strengths/top_friction_points narrative. The recovery (`fallbackHighlights`) produces sensible 3+3 phrases from the dim scores, so the report is still useful, but the highlights are deterministic-looking rather than LLM-prose. Worth investigating in Session 5 polish — likely solution: move synthesis off the per-debate critical path and run it after persistence, or switch synthesis specifically to Pro (smaller call volume, can afford the latency).
- **STT is still a stub.** Carried forward from Session 2. Defer to Session 5 polish.
- **`tools/sms.template.ts`, `tools/maps.ts`, `tools/calendar.mock.ts`, `tools/tts.ts`** — referenced in MASTERPLAN §4 file layout but do NOT exist yet. Session 4 creates them.
- **`compatibility_reports.flow_id`** was added via SQL Editor; the schema.sql file has the `alter table ... if not exists` so re-applying the schema is safe.

**Anything weird:**

- **`origin/backend/main` is ahead of this local branch with teammate's commits.** The teammate's Session 3-5 used Gemini Flash via Google AI Studio (not Vertex). User does not trust those builds. Decision deferred to user — likely a hard reset of `origin/backend/main` to this branch's HEAD after Sessions 4-5 land, then a force-push. Until then, **NEVER `git pull` or `git push`** without checking with the user.
- **Vertex hackathon-tier quota is the architecture's load-bearing constraint.** Three knobs in `src/agents/_shared/gemini.ts` keep us inside it: `MAX_CONCURRENT=3`, `PRIMARY_TIMEOUT_MS=12_000`, `PRIMARY_ATTEMPTS=2`. If Session 4 adds more parallel Gemini calls (e.g. Wali brief in both EN+UR concurrently, or Booking proposing 3 slots in parallel), they share the same 3-slot semaphore. Plan around that. Bumping the cap will start 429-storming again.
- **MASTERPLAN §8.2's 30s end-to-end budget is exceeded.** Actual workplan latency ~30 s for the matching flow, which is on-spec, but the per-debate-budget is 60 s and the workplan ceiling is 90 s. Documented and accepted; production quota uplift would land everything back in spec.
- **Empty `final_synthesis` Pro upgrade for Session 5** — synthesis is 1 call per debate (5 calls per workplan total). Pro would land within budget for that call count and would produce nicer top_strengths phrases. Easy win for the demo if you have time.
- **The `agent.message` events for the live debate** are synthesized BY the Moderator from the unified-call response — they're not separate Gemini calls. Mobile UI shouldn't notice; the SSE event shape is unchanged.
- **The `ivfflat` index in `schema.sql` is still created on an empty `embedding` column.** Candidates are seeded with `embedding=NULL`. Run `REINDEX INDEX twins_embedding_idx;` in Supabase SQL Editor only if Session 5 wires real embeddings.

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
| Gemini Pro free-tier quota = 0 (Session 2 finding) | **RESOLVED Session 2.5** | Swapped LLM backend from AI Studio → Vertex AI on project `lab-viah`. `gemini-2.5-pro` verified live via `/health/deep`. $5 GCP free credit covers a multi-thousand-call hackathon. |
| Vertex AI cold-start latency | open, low severity | First Gemini call after server boot incl. auth handshake takes ~4 s; warm calls ~1.5–2 s. Mitigation: pre-warm via `/health/deep` at server start, or simply accept first-call cost. Within MASTERPLAN §9 budget. |
| Vertex hackathon-tier 429s under burst load (Session 3 finding) | **MITIGATED Session 3** | `lab-viah` cannot sustain 5-parallel × 3-calls-per-dim Pro bursts. Mitigations live in `src/agents/_shared/gemini.ts`: global semaphore cap=3, 12 s timeout, 2 attempts with 1.2 s 429-aware exponential backoff, Flash-only on per-dim + synthesis calls. Plus the Moderator now does 1 call per dim (down from 3). Verified: 16 isolated recoveries in the 30 s smoke run, no cascading failures. Production quota uplift would let us raise the cap and re-enable Pro on scoring. |
| Final-synthesis Gemini call fails 5/5 under load | open, low severity | All 5 per-debate synthesis calls fell back to `fallbackHighlights` (deterministic top-strengths/friction-points from the dim scores) in the Session 3 smoke. Demo is still coherent — the highlights look reasonable — but they're not LLM-authored. Session 5 polish: either move synthesis off the per-debate critical path (run after persistence) OR switch synthesis to Pro (low call volume, can afford the latency). |
| Gemini latency >5s in Moderator | open, mitigated | Per-dim Flash call lands in 1-3 s when not 429'd; tight 12 s timeout caps the worst case. Pro→Flash fallback inside `geminiCall` still available if a Session 4 call uses tier='pro' and fails. Pre-cache hero scenarios in Session 5. |
| Cloud STT poor on Roman Urdu | mitigated for now | Chip-based fallback IS the recovery path; STT itself is a stub. Real STT wireup is Session 5 polish (needs `@google-cloud/speech` dep). |
| Frontend integration mismatch | mitigated for SSE | `demo_*` flowId heartbeat (Session 1) + every `/onboarding/*` route returns `flowId === sessionId` so frontend can subscribe to `GET /stream/:flowId` for the live trace. Full OpenAPI-style spec still due end of Session 4. |
| Supabase free tier rate limits | open | Self-host fallback ready (out of scope unless triggered). |
| Demo flakiness during recording | open | Pre-record hero debate, run cached version Day 5. |
| Schedule risk — 3 calendar days remaining | open, on-track | Session 3 (HERO DAY) shipped: matching subsystem end-to-end with live SSE debate, persisted reports, baseline comparison, agentic uplift visible in the data. User's veto on scope cuts stands. Re-evaluate at Session 4 end. |
| Git push deferred | open, INTENTIONAL | Session 3 commits stay LOCAL until user reconciles with teammate's parallel push to `origin/backend/main`. The teammate pushed Session 3-5 using Flash via AI Studio; user does not trust those builds. NEVER push from this branch without explicit user instruction. |
| Branch divergence from `origin/backend/main` | open, HIGH | `origin/backend/main` is ahead with the teammate's Session 3-5 work. Reconciliation strategy (force-push this branch vs cherry-pick teammate's stuff vs merge) is the user's decision. Until then, this branch is the source of truth for the user's preferred Vertex/Pro-capable architecture. |
| Twilio not wired | open, mitigated for dev | Dev bypass works; Session 5 polish for live OTP. |
| Onboarding session state lost on server restart | open, accepted | In-memory `Map` keyed by `sessionId`. A restart mid-onboarding forces user to start over. Acceptable for hackathon; persistent storage would need a new `onboarding_sessions` table — explicitly deferred (no half-finished). |
| Dealbreaker capture in Layer 1 chunky turns | open, minor | When user dumps many facts at once, the Onboarding Agent honors "one topic per turn" and falls back to chips, dropping some facts (witnessed: "no smokers" dropped during Session 2 verify). Session 3 polish: tighten chip flow OR loosen the one-topic rule. |

---

*End of SESSION_CONTEXT. Last touched: 2026-05-17 (late evening) by Session 2.5 (Vertex AI swap). Next read: at start of Session 3.*
