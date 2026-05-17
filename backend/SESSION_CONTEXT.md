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

- **Project phase:** Session 1 COMPLETE AND VERIFIED. Foundation skeleton in place; pushed to `origin/backend/main`; full exit check green.
- **Last commit:** `2672f6e` — `session 1: polish pass — fix env loading, Windows entrypoint, SUPABASE_URL, Gemini thinking budget, dev-bypass auth method; verified exit check green`. Pushed to `origin/backend/main`. Any commits after this are doc-only touch-ups.
- **Last updated:** 2026-05-17 by Session 1 (post-verification polish)
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
- [x] `src/routes/auth.routes.ts` — `POST /auth/otp/start` and `POST /auth/otp/verify` via Supabase Auth phone OTP. Includes dev-mode bypass branch (admin.createUser + signInWithPassword) so we are not blocked on Twilio. Upserts users row on verify.
- [x] `src/routes/stream.routes.ts` — `GET /stream/:flowId` SSE. `demo_*` flowIds get a 1s heartbeat for 30s; real flowIds subscribe to the in-memory `TraceBus`.
- [x] `src/server.ts` — Fastify entrypoint with `/health`, `/health/deep` (db + gemini), CORS, error handler.
- [x] `tests/health.test.ts` + `tests/setup.ts` + `vitest.config.ts` — happy-path test for `/health`.
- [x] `README.md` placeholder pointing at MASTERPLAN/ANTIGRAVITY/SESSION_CONTEXT.
- [x] `traces/.gitkeep` for the Session 5 export drop.

**Session 1 polish pass (2026-05-17, after first run-through):**
- [x] `package.json` scripts now use Node `--env-file=.env` flag so the server actually loads `.env` (was crashing on env validation otherwise). `dev` and `start` both updated.
- [x] `src/server.ts` entrypoint check rewritten with `fileURLToPath`. The old check (`import.meta.url === \`file://${argv[1]}\``) failed silently on Windows because of slash-count mismatch (`file:///D:/...` vs `file://D:/...`) — `main()` never ran and the server exited cleanly with exit code 0.
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

### Blockers

- _(none)_

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
1. **Push first.** `git -C D:\Projects\rishtaai push -u origin backend/main` so the team sees the work and the local repo isn't a single point of failure.
2. `cd D:\Projects\rishtaai\backend` and run `npm install`.
3. Supabase is already set up. Project ref: `kllejrzqraqclmysdtfv`. URL: `https://kllejrzqraqclmysdtfv.supabase.co`. Schema applied with RLS on. Confirm `.env` has all 4 `SUPABASE_*` keys.
4. **Dev OTP bypass setup:** make sure `.env` has these (defaults are fine, but `DEV_OTP_PASSWORD` MUST be set):
   - `DEV_OTP_BYPASS=true`
   - `DEV_OTP_PHONE=+923001234567`
   - `DEV_OTP_CODE=123456`
   - `DEV_OTP_PASSWORD=<generate via openssl rand -base64 32>`
5. Add `GEMINI_API_KEY` to `.env`. Verify with `curl http://localhost:3000/health/deep` — both `db.ok` and `gemini.ok` should be `true`.
6. Add `GOOGLE_APPLICATION_CREDENTIALS` pointing at a GCP service account JSON with Cloud Speech-to-Text + TTS enabled (Session 2 onboarding agent needs STT).
7. Smoke-test auth bypass:
   ```bash
   curl -s -X POST http://localhost:3000/auth/otp/start -H 'content-type: application/json' -d '{"phone":"+923001234567"}'
   # → { "ok": true, "data": { "sent": true, "dev": true } }
   curl -s -X POST http://localhost:3000/auth/otp/verify -H 'content-type: application/json' -d '{"phone":"+923001234567","otp":"123456"}'
   # → { "ok": true, "data": { "access_token": "...", "user_id": "..." } }
   ```
8. Re-read MASTERPLAN sections 5.1, 5.2, 6.2, 8.1.

**Useful entry points for Session 2 work:**
- New agent goes in `src/agents/onboarding.agent.ts`. Use the `geminiCall(input, bus)` helper from `src/agents/_shared/gemini.ts` — it automatically traces.
- Trace emissions in agent code should use the helpers from `src/agents/_shared/trace.ts`: `obs(bus, 'onboarding', '…')`, `decide(bus, 'onboarding', 'go layer 2', 'confidence > 0.8')`, `recover(bus, '…', '…')`.
- Workplan entry-point: `startTrace('onboarding_flow', { userId })` → returns a `TraceBus`. At end, call `endTrace(bus, { twinId })`. The trace persists to Supabase automatically.
- Route registration pattern is in `src/routes/auth.routes.ts`. Use Zod for body validation, return `ApiResponse<T>`.

**Half-finished work / things to know:**
- Nothing is half-finished. Session 1 closed cleanly, all exit-check probes green.
- **User's `.env` has a stale `GEMINI_MODEL_FALLBACK=gemini-2.0-flash-exp`** (404 dead). Primary `gemini-3-flash-preview` works so the bug is hidden — but if primary ever rate-limits, fallback will 404. **Session 2: update `.env` to `GEMINI_MODEL_FALLBACK=gemini-flash-latest`.**
- **Per MASTERPLAN §3 ("Gemini 3 Pro for orchestration"), `GEMINI_MODEL_PRIMARY` should be `gemini-pro-latest` (or pin to `gemini-3-pro-preview` for reproducibility).** User currently has `gemini-3-flash-preview` — that's a Flash model, smaller/faster but weaker reasoning. The Moderator debate quality benefits from Pro. Suggest swap before Session 3 hero work.
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
| Schedule risk — 3 calendar days remaining | open, user accepts | MASTERPLAN §11 budgets 5 days starting Fri 15 May; we started Sun 17 May. User vetoed any scope cuts (2026-05-17). Mitigation: Session 2 needs to be tight on onboarding + Twin Forge with no detours; if Day 3 hero work slips, pull from Session 5 polish budget rather than dropping features. Re-evaluate at Session 3 end. |
| Git push deferred | open | Commits `e7c4185` + `9c4ac26` are local-only on `backend/main`. If the local repo dies before Session 2's first push, we lose ~4 hours of work. Push at the very start of Session 2. |
| Twilio not wired | open, mitigated for dev | Dev bypass (`DEV_OTP_BYPASS=true`) returns real Supabase JWTs without Twilio. For live OTP on a real Pakistani SIM during the demo, sign up for Twilio trial (~10 min, free) and flip `DEV_OTP_BYPASS=false`. Tracked as Session 5 polish item, not a scope cut. |

---

*End of SESSION_CONTEXT. Last touched: 2026-05-17 by Session 1. Next read: at start of Session 2.*
