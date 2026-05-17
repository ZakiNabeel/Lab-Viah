# RishtaAI Backend

> 8-agent matchmaking orchestrated inside Google Antigravity.
> Google Antigravity Hackathon 2026 — Challenge 2 (AI Service Orchestrator for Informal Economy).

This README is a placeholder. The full README — architecture diagram, schemas, tools/APIs, Antigravity role, setup, cost/scalability, baseline comparison — lands at the end of Session 5.

## Read these first
- [`MASTERPLAN.md`](./MASTERPLAN.md) — single source of truth for the build.
- [`ANTIGRAVITY.md`](./ANTIGRAVITY.md) — how the workplan / agent / tool / trace contract works.
- [`SESSION_CONTEXT.md`](./SESSION_CONTEXT.md) — rolling memory across sessions.

## Local setup

```bash
# 1. Install deps
npm install

# 2. Copy env template and fill in real keys
cp .env.example .env

# 3. Apply DB schema to your Supabase project
#    Paste src/db/schema.sql into the Supabase SQL Editor and run.

# 4. Start dev server
npm run dev

# 5. Smoke checks
curl http://localhost:3000/health
curl -N http://localhost:3000/stream/demo_session1     # heartbeat every 1s for 30s
```

## Layout

```
src/
├── server.ts                Fastify entrypoint
├── config.ts                Zod-validated env
├── db/
│   ├── client.ts            Supabase client + retry-wrapped read/write
│   └── schema.sql           Authoritative schema (apply via SQL Editor)
├── routes/
│   ├── auth.routes.ts       /auth/otp/{start,verify}
│   └── stream.routes.ts     /stream/:flowId  (SSE)
├── agents/
│   └── _shared/
│       ├── types.ts         TraceEvent + Dimension + ApiResponse
│       ├── trace.ts         TraceBus, startTrace, endTrace
│       └── gemini.ts        Gemini wrapper, Pro→Flash fallback
└── utils/                   logger.ts · errors.ts · retry.ts
```

## Sessions
Five planned sessions. Session 1 (foundation) ships the skeleton above; everything else
(onboarding agents, Twin debate, Wali/Booking/Dispute, deploy) lands in Sessions 2-5.
See [`SESSION_CONTEXT.md`](./SESSION_CONTEXT.md) §4.
