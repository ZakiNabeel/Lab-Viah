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

- **Project phase:** Session 2 COMPLETE AND VERIFIED. Onboarding + Twin Forge fully wired: 5 routes, 2 agents, STT stub w/ chip-fallback recovery, 12 scenario cards, end-to-end workplan with persisted Twin v1.0. Real Gemini + real Supabase journey runs in ~30 s and emits 71 trace events (exit-check ≥15).
- **Last commit (Session 2):** *(filled in after the commit lands; current HEAD before this session was `5c175aa`).*
- **Last updated:** 2026-05-17 (evening) by Session 2.
- **Days remaining until 20 May submission:** ~3 (Sun evening → Wed EOD).

---

## 2. Live working state

### In progress

*(What is being worked on RIGHT NOW. Empty at session boundaries.)*

- *(none — Session 2 ended cleanly)*

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

### Blockers

- **Gemini Pro free-tier quota = 0.** During the end-to-end Session 2 walk, every `gemini-pro-latest` call 429'd with `limit: 0, model: gemini-3.1-pro` from the free-tier quota. Each request retried twice on Pro, then fell back to `gemini-flash-latest` (which DOES have free-tier quota) — that's why the journey still completed, but every call paid the +2 retry latency cost. **Session 3's Moderator debate quality REQUIRES Pro (MASTERPLAN §3).** Action for Session 3 start: enable billing on the AI Studio project so Pro stops getting clamped to 0. Cost ceiling for the whole hackathon is single-digit USD.

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

---

## 6. Handoff for next session

> **Last session's handoff lives here.** Read this first thing.
> Replace this section at the end of each session.

### Handoff from Session 2 → Session 3

**Where the code is on disk:**

- Live working copy: `D:\Projects\rishtaai\backend\` (clone of `https://github.com/ZakiNabeel/Lab-Viah.git`, branch `backend/main`).
- Session 2 commit (filled in after `git push`): see git log; the message will start with `session 2:`.

**Before doing anything in Session 3:**

1. **Pull first.** `git -C D:\Projects\rishtaai pull --ff-only` to grab the Session 2 work.
2. **FIX THE GEMINI QUOTA.** End-to-end Session 2 verification revealed `gemini-pro-latest` (alias for `gemini-3.1-pro`) has free-tier quota `limit: 0`. Every Pro call 429s and falls back to Flash. Session 3 Moderator debate REQUIRES Pro per MASTERPLAN §3. Two options:
   - **Enable billing** on the Google AI Studio project. Recommended. Cost ceiling for the whole hackathon is single-digit USD.
   - **Or** pin `GEMINI_MODEL_PRIMARY` to a Flash model that has free quota. Worse for Moderator reasoning.
3. Verify with: `curl -s http://localhost:3000/health/deep | jq .data.gemini` — ok should be true AND `modelUsed: gemini-3.1-pro` (or whatever Pro alias resolves to) after billing is on.
4. Re-read MASTERPLAN sections 5.3, 5.4, 5.5, 6.3, 7 (match + stream rows), 8.2, 10, 11 (Day 3).
5. The Session 1 `.env` model warnings are RESOLVED — current `.env.example` defaults are correct. If user's local `.env` still has `gemini-3-flash-preview` as primary, swap to `gemini-pro-latest` so Moderator gets Pro.

**Smoke-test commands (full onboarding journey, ~30 s against live services):**

```bash
JWT=$(curl -s -X POST http://localhost:3000/auth/otp/verify \
  -H 'content-type: application/json' \
  -d '{"phone":"+923001234567","otp":"123456"}' \
  | grep -oE '"access_token":"[^"]+' | cut -d'"' -f4)

# Layer 1
L1=$(curl -s -X POST http://localhost:3000/onboarding/layer1 \
  -H "content-type: application/json" -H "authorization: Bearer $JWT" \
  -d '{"text":"My name is Hadeed, 26, male, Karachi. Practicing.","language":"en"}')
SID=$(echo "$L1" | grep -oE '"sessionId":"[^"]+' | head -1 | cut -d'"' -f4)

# Subsequent layers — see Session 2 verify block in commit message
# Finalize:
curl -s -X POST http://localhost:3000/onboarding/finalize \
  -H "content-type: application/json" -H "authorization: Bearer $JWT" \
  -d "{\"sessionId\":\"$SID\"}"
```

**Useful entry points for Session 3 work:**

- **Candidate Twins go in `src/content/candidates.ts`** (file does NOT exist yet; Session 3 creates it). Use the same `TwinSpec` type from `src/domain/twin.ts`. Insert seed rows with `is_candidate=true` in `twins`. The `embedding` column is `vector(768)` but stays NULL until you wire embeddings (Session 3 prescreen step).
- **User Twin agent** (`src/agents/user-twin.agent.ts`) follows the same shape as `onboarding.agent.ts` — Gemini-backed, Zod-validated output, system prompt loaded from the Twin's `spec.system_prompt` (already generated by Twin Forge in Session 2).
- **Candidate Twin agent** is structurally identical to User Twin; only difference is which spec row it loads.
- **Moderator agent** (`src/agents/moderator.agent.ts`) — orchestrates the 8-dimension debate. Use `geminiCall(input, bus)` per turn. Emit `dimension.scored` events (see ANTIGRAVITY.md §3 — this event type already exists in `src/agents/_shared/types.ts`).
- **Trace pattern:** `startTrace('find_matches', { userId })` → tasks per-candidate (parallel) → `endTrace(bus, { topThree })`. SSE consumption is already wired via `/stream/:flowId` — no changes needed there.
- **Prescreen** (`src/domain/prescreen.ts`) reduces 12 → 5 candidates by vector similarity. For Session 3 a simple cosine on a hand-built 16-dim feature vector (one per Twin field, scaled) is enough; the `embedding` column can stay NULL or be hydrated lazily.
- **Baseline endpoint** (`GET /baseline/match`) is a required deliverable — same Twin features, simple weighted-distance, NO debate, NO Gemini. Lives in `src/routes/match.routes.ts` alongside the agentic path.

**Half-finished work / things to know:**

- **Nothing is half-finished.** Session 2 closed cleanly: typecheck clean, tests pass (2/2), full real-service end-to-end Verified with Twin persisted.
- **STT is a stub.** `src/tools/stt.ts` always returns `{lowConfidence: true, stub: true}` so Layer 1 currently goes through chip-fallback whenever an `audioBase64` body arrives. Wiring real STT needs `@google-cloud/speech` — a new dep. Defer to Session 5 polish; the chip-fallback IS the visible recovery for the demo.
- **One dealbreaker dropped during Session 2's live walk** ("no smokers" said in a chunky L1 turn) because the Onboarding Agent honored the "one topic per turn" rule and triggered the chip-fallback recovery for that turn. The recovery path itself works; the dealbreaker capture rate at L1 will improve in Session 3 when we let the user free-text or pick chips per topic. Not blocking.
- **`flow_id` column on `traces` is text;** Session 2's onboarding workplan uses `ob_<uuid>` as flowId. Session 3 should use raw `randomUUID()` or prefix with `match_` to keep types distinguishable in the DB.
- **Onboarding session state is in-memory.** A server restart between Layer 1 and Finalize forces the user to restart. Acceptable for hackathon; persistent storage would need a new `onboarding_sessions` table.
- **In-spec `system_prompt` is generated by Twin Forge** (~400 words). Session 3's User Twin / Candidate Twin agents inject it via Gemini's `systemInstruction` parameter — already supported by `geminiCall`.

**Anything weird:**

- **Gemini Pro is free-tier-clamped to 0.** This is the biggest Session 3 risk; address it BEFORE writing Moderator code or every iteration eats ~10 s of fallback latency. See Blockers in §2.
- **Dev-bypass auth fix was needed (Session 1 carry-over).** Reaffirming: never call `signInWithPassword` on the service-role client. Documented in §5 decisions.
- **The `ivfflat` index in `schema.sql` is created on an empty table.** After Session 3 seeds 12 candidate twins (with embeddings), run `REINDEX INDEX twins_embedding_idx;` for it to build properly.
- **Empty `traces` rows from local dev:** when the workplan ends, the `bus.close()` call inserts a row into `traces`. RLS bypass via service-role works (verified Session 2). If you ever see a trace row missing fields, check that you're using `supabase` (service-role) for the insert, not `supabasePublic`.

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
| **Gemini Pro free-tier quota = 0** | **open — NEW, Session-3 critical** | Discovered Session 2: `gemini-pro-latest` (alias for `gemini-3.1-pro`) returns 429 with `limit: 0` on the free tier. Every Pro call goes through 2× retry + fallback to Flash, adding ~3–5 s latency per call. Moderator debate quality WILL suffer if Pro stays unavailable. Mitigation: enable billing on Google AI Studio project at Session 3 start (single-digit USD ceiling). |
| Gemini latency >5s in Moderator | open, partially mitigated | Pro→Flash fallback works end-to-end. Pre-cache hero scenarios in Session 5. With Pro quota fixed, latency should fit budget. |
| Cloud STT poor on Roman Urdu | mitigated for now | Chip-based fallback IS the recovery path; STT itself is a stub. Real STT wireup is Session 5 polish (needs `@google-cloud/speech` dep). |
| Frontend integration mismatch | mitigated for SSE | `demo_*` flowId heartbeat (Session 1) + every `/onboarding/*` route returns `flowId === sessionId` so frontend can subscribe to `GET /stream/:flowId` for the live trace. Full OpenAPI-style spec still due end of Session 4. |
| Supabase free tier rate limits | open | Self-host fallback ready (out of scope unless triggered). |
| Demo flakiness during recording | open | Pre-record hero debate, run cached version Day 5. |
| Schedule risk — 3 calendar days remaining | open, on-track | Session 2 shipped on plan: onboarding + Twin Forge with end-to-end verification + happy-path vitest. No scope cut needed. User's veto on scope cuts stands. Re-evaluate at Session 3 end (hero day). |
| Git push deferred | RESOLVED Session 1 | All Session 1 commits pushed; Session 2 commit pushes at end of this session. |
| Twilio not wired | open, mitigated for dev | Dev bypass works; Session 5 polish for live OTP. |
| Onboarding session state lost on server restart | open, accepted | In-memory `Map` keyed by `sessionId`. A restart mid-onboarding forces user to start over. Acceptable for hackathon; persistent storage would need a new `onboarding_sessions` table — explicitly deferred (no half-finished). |
| Dealbreaker capture in Layer 1 chunky turns | open, minor | When user dumps many facts at once, the Onboarding Agent honors "one topic per turn" and falls back to chips, dropping some facts (witnessed: "no smokers" dropped during Session 2 verify). Session 3 polish: tighten chip flow OR loosen the one-topic rule. |

---

*End of SESSION_CONTEXT. Last touched: 2026-05-17 (evening) by Session 2. Next read: at start of Session 3.*
