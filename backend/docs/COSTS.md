# Cost & Scalability — RishtaAI Backend

Last updated: 2026-05-18

## 1. Unit pricing (Vertex AI, us-central1, May 2026)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.5-flash | $0.075 | $0.30 |

| Service | Price |
|---|---|
| Cloud Text-to-Speech (WaveNet) | $16 per 1M chars |
| Cloud Speech-to-Text (standard) | $0.024 per minute |
| Supabase Postgres (Pro tier above 500MB / 50k MAU) | $25 / month |
| Google Maps Places API (Text Search SKU) | $32 per 1k requests (post-$200 monthly credit) |

(Sources: cloud.google.com/vertex-ai/generative-ai/pricing, cloud.google.com/text-to-speech/pricing, supabase.com/pricing as of 2026-05.)

Model names are `gemini-2.5-pro` (primary) and `gemini-2.5-flash` (fallback/flash tier), as configured in `src/config.ts:30-31`. Every agent reaches Gemini only through `src/agents/_shared/gemini.ts`; callers that omit `modelTier` default to `'pro'` (`gemini.ts:109`).

---

## 2. Per-operation cost breakdown

Token estimates derived from observed run logs (Session 4) + prompt audit of `src/agents/*.ts` and `src/agents/_shared/gemini.ts`.

### 2.1 Onboarding (one user, end-to-end)

> **Audit note — deviations from initial estimate:**
> - Layer 1 chat uses **Pro** (not Flash): `onboarding.agent.ts:157` calls `geminiCall` with no `modelTier`, which defaults to `'pro'` (`gemini.ts:109`). `maxOutputTokens: 768`.
> - Layer 3 statement generation also uses **Pro** (`twin-forge.agent.ts:52`, no `modelTier`).
> - "Layer 4 Wali reconcile" is **fully deterministic** (zero LLM calls): `reconcileWaliConflicts` at `twin-forge.agent.ts:125-165` compares payload fields with plain JS logic, no `geminiCall`.
> - `forgeTwin` makes **2 Pro calls**: one for the spec body (`maxOutputTokens: 1500`, `twin-forge.agent.ts:212`) and one for the voice/system_prompt (`maxOutputTokens: 900`, `twin-forge.agent.ts:242`).
> - `MAX_TURNS = 5` (not 4) per `onboarding.agent.ts:96`.

| Step | Model | Input tok | Output tok | Cost |
|---|---|---|---|---|
| Layer 1 — chat (avg 5 turns) | Pro | 5×800=4000 | 5×300=1500 | $0.020 |
| Layer 2 — card scoring (deterministic, no LLM) | — | 0 | 0 | $0 |
| Layer 3 — generate 3 statements | Pro | 1500 | 600 | $0.008 |
| Layer 3 — apply corrections (same `runOnboardingTurn` path) | Pro | 800 | 400 | $0.005 |
| Layer 4 — Wali reconcile | — | 0 | 0 | $0 (deterministic) |
| Twin Forge spec body synthesis | Pro | 2000 | 1200 | $0.015 |
| Twin Forge voice/system_prompt | Pro | 1000 | 800 | $0.009 |
| **Onboarding total** | | | | **~$0.057** |

### 2.2 find_matches workplan (one user, one match request)

> **Audit note:** Per-dim unified debate call confirmed as Flash (`moderator.agent.ts:282`, `modelTier: 'flash'`, `maxOutputTokens: 2048`). Final synthesis confirmed as Pro (`moderator.agent.ts:431`, `modelTier: 'pro'`, `maxOutputTokens: 1024`). 5 candidates × 8 dims = 40 Flash calls; 5 Pro synthesis calls. Prescreen remains cosine similarity (deterministic).

| Step | Model | Calls | Tok in/call | Tok out/call | Cost |
|---|---|---|---|---|---|
| Prescreen | — | 0 (cosine, deterministic) | — | — | $0 |
| Unified per-dim debate (5 candidates × 8 dims) | Flash | 40 | 1800 | 800 | $0.015 |
| Per-debate final synthesis | Pro | 5 | 1500 | 900 | $0.054 |
| **find_matches total** | | | | | **~$0.069** |

(The MASTERPLAN §14 placeholder of ~$0.004 per match assumed Flash everywhere + smaller per-debate output. The actual synthesis uses Pro; real cost is ~17× that placeholder.)

### 2.3 book_meeting workplan (one couple, propose + confirm)

> **Audit note:** 2 Pro calls confirmed (`wali.agent.ts:157`, `modelTier: 'pro'`, `maxOutputTokens: 1400`). TTS `MAX_TEXT_CHARS = 1500` per call (`tts.ts:103`); 2 TTS calls per meeting. Maps Places call uses `GOOGLE_MAPS_API_KEY` (optional, graceful fallback if absent).

| Step | Model | Calls | Tok in/call | Tok out/call | Cost |
|---|---|---|---|---|---|
| Wali brief (EN + native, parallel) | Pro | 2 | 1500 | 1200 | $0.030 |
| TTS WaveNet (EN + native, ≤1500 chars each) | TTS | 2 | — | — | $0.048 |
| Calendar mock | — | 0 | — | — | $0 |
| Maps Places search | Places | 1 | — | — | $0.032 (within $200/mo free tier → effectively $0) |
| **book_meeting total** | | | | | **~$0.078** |

> **TTS note:** `MAX_TEXT_CHARS = 1500` per call (`tts.ts:103`), 2 calls = up to 3000 chars. At $16/1M chars that is $0.048 per meeting in the worst case (full 1500-char briefs both languages). In practice Urdu briefs run 600-900 chars; typical cost ≈$0.020.

### 2.4 handle_dispute workplan

> **Audit note:** 1 Pro call confirmed (`dispute.agent.ts:136`, `modelTier: 'pro'`, `maxOutputTokens: 1400`).

| Step | Model | Calls | Tok in/call | Tok out/call | Cost |
|---|---|---|---|---|---|
| Mediation | Pro | 1 | 1500 | 800 | $0.010 |
| **handle_dispute total** | | | | | **~$0.010** |

### 2.5 Post-meeting feedback (Twin v2)

> **Audit note:** 1 Pro call confirmed (`twin-forge.agent.ts:443`, `modelTier: 'pro'`, `maxOutputTokens: 1200`). Weight adjustment is deterministic (`adjustWeightsFromFeedback`, no LLM).

| Step | Model | Calls | Tok in/call | Tok out/call | Cost |
|---|---|---|---|---|---|
| Deterministic weight adjustment | — | 0 | — | — | $0 |
| system_prompt refresh | Pro | 1 | 2000 | 900 | $0.011 |
| **feedback total** | | | | | **~$0.011** |

### 2.6 Full happy-path journey (onboarding → match → book → feedback)

~$0.215 per user, end-to-end (onboarding $0.057 + one find_matches $0.069 + book_meeting $0.078 + feedback $0.011). Dispute path is sporadic; add $0.010 if filed.

---

## 3. Scale projections

Assume one user completes onboarding once, requests matches ~5× per month, books ~1 meeting per month, files a dispute in 5% of meetings, leaves feedback after every meeting.

Monthly cost per active user:

```
onboarding (amortized 1/12) + 5×find_matches + 1×book_meeting + 0.05×dispute + 1×feedback
= 0.057/12 + 5×0.069 + 0.078 + 0.05×0.010 + 0.011
≈ $0.44 per MAU / month
```

| Scale | MAUs | Monthly LLM cost | Monthly infra cost | Total | Architecture changes |
|---|---|---|---|---|---|
| MVP / hackathon | 1 (you) | <$1 | Supabase free | <$1 | None |
| 1× | 1,000 | $440 | Supabase free + Railway hobby $5 | ~$445 | None |
| 10× | 10,000 | $4,400 | Supabase Pro $25, Redis cache for twins, Railway scaled $20 | ~$4,450 | Cache Twin specs (5min TTL), batch-overnight prescreen, batch TTS |
| 100× | 100,000 | $44,000 | Supabase Team $599, Redis $100, multi-region | ~$44,750 | Pinecone or pgvector-at-scale for prescreen; background workers; pre-compute compatibility for inactive users overnight |
| 1000× | 1,000,000 | $440,000 | Multi-region active-active, dedicated SREs, custom vector DB | ~$460k+ | Move Pro→Flash on cold paths; serve top-K cached reports; LLM only on freshly active candidates |

---

## 4. Bottleneck analysis

- **Latency:** Moderator debate end-to-end ~30s with `MAX_CONCURRENT=10` and Vertex 300 RPM quota (`gemini.ts:76`). At 100× we'd batch-prescore overnight; live debates only for top-5 freshly-active candidates.
- **Throughput:** Vertex hackathon-tier ~60 RPM was the original Session 3 bottleneck (cap was 3). Production at 100× needs negotiated quota (1000+ RPM) or multi-project sharding.
- **Storage:** `traces` table grows ~50KB per match request × 5 matches/month/MAU = 3MB/MAU/year. At 100k MAUs that is 300GB/year — needs S3 archival of old traces.
- **TTS cost:** WaveNet at $16/M chars is the highest per-op unit cost. The `MAX_TEXT_CHARS = 1500` cap (`tts.ts:103`) limits runaway billing; at 100× we would cache TTS output by content hash (most rishta briefs share boilerplate sections).
- **Pro vs Flash split:** All onboarding turns, all synthesis calls, all wali briefs, dispute, and feedback use Pro. Flash is used only for the 8-dim debate body (the highest-volume operation). Switching onboarding Layer 1 to Flash would save ~$0.018/user and is the highest-ROI cold-path downgrade.

---

## 5. Pricing-model notes

- Free tier covers MVP demo entirely. A $5 Vertex credit alone runs approximately 28k Flash debate calls or ~1400 full find_matches workplans.
- Real economic cost per successful match (one match leading to a booked meeting): ~$2.70 (covers prescreen + 5 debates + Wali briefs + dispute amortized). Pakistan rishta-matchmaker fees are typically PKR 50,000-100,000 (USD $180-360) per successful introduction — our LLM cost is well under 1.5% of that market rate, leaving ample margin for hosting, team, and acquisition.
- The single largest lever for cost reduction at scale is moving onboarding Layer 1 chat turns from Pro to Flash (`modelTier: 'flash'`), which requires a one-line change in `src/agents/onboarding.agent.ts:157`. This was intentionally left as Pro for hackathon quality; re-evaluate post-demo.

---

End of cost & scalability analysis.
