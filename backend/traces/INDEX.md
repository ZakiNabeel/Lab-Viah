# Trace Export Index

Generated: 2026-05-18T07:01:11.158Z

| File | Trace ID | Workplan | Events | Recoveries | Started | Outcome |
|---|---|---|---|---|---|---|
| onboarding_flow__01.jsonl | e08fb2a2-dadb-49ee-ac8c-f084744db882 | onboarding_flow | 71 | 10 | 2026-05-17 13:22 | name=Hadeed, twinId=811c9b47-b998-4f49-a7ad-f7566829f7c7, version=1 |
| find_matches__hero_scenario_C.jsonl | a0ea0a63-e307-4fdd-b6cf-0832dc32ada8 | find_matches | 286 | 0 | 2026-05-17 19:55 | flowId=match_083408d2-fcc4-4b91-85b2-e6abf80521, topThree=[array:3], allDebated=[array:5], … |
| book_meeting__01.jsonl | 673b9a8e-119d-4f0c-a83d-93ce5284c8cf | book_meeting | 18 | 0 | 2026-05-18 06:28 | flowId=book_confirm_ef0d7ae6-89e9-4a8f-bfb5-3b7, finalized={...}, meetingId=4b38351a-d2df-4bff-8907-ba23a26ea898, … |
| handle_dispute__01.jsonl | 6430c750-18f7-43a7-8d21-827c5b3adc34 | handle_dispute | 31 | 1 | 2026-05-18 06:28 | flowId=dispute_0fc24635-1457-494d-81d0-a5b970e0, disputeId=194962c1-42f7-44cc-ae2f-0758971f1a8b, resolution={...} |
| recovery__moderator_timeout.jsonl | 7aad0e0c-7ec5-4ece-a74c-cef0437ecee2 | find_matches | 478 | 73 | 2026-05-17 16:31 | flowId=match_82c88def-ee71-4f8e-be07-d36799882e, topThree=[array:3], allDebated=[array:5], … |

## Selection criteria

Each trace was selected by the following criteria, in order:

1. **onboarding_flow__01.jsonl** — Latest `traces` row where `workplan='onboarding_flow'` AND `outcome` contains a `twinId` key (successful twin creation, no error outcome). Ordered by `started_at desc`, limit 1.

2. **find_matches__hero_scenario_C.jsonl** — Latest `traces` row where `workplan='find_matches'` AND `outcome` contains a `topThree` key AND `outcome.budgetExceeded != true` (clean run, zero budget errors). Ordered by `started_at desc`, limit 1. Targets the Session 4 burst-smoke run.

3. **book_meeting__01.jsonl** — Latest `traces` row where `workplan='book_meeting'` AND `outcome` contains a `meetingId` key (successful booking). Ordered by `started_at desc`, limit 1.

4. **handle_dispute__01.jsonl** — Latest `traces` row where `workplan='handle_dispute'` AND `outcome` contains a `disputeId` key (dispute opened). Ordered by `started_at desc`, limit 1.

5. **recovery__moderator_timeout.jsonl** — The `find_matches` row with the most recoveries (recovery exemplar demonstrating the system's resilience). Selected by sorting all `find_matches` rows by `recoveries` array length descending. Targets the Session 3 Vertex burst meltdown row.

All criteria can be overridden per-file via environment variables:
`EXPORT_ONBOARDING_FLOW_ID`, `EXPORT_FIND_MATCHES_FLOW_ID`, `EXPORT_BOOK_MEETING_FLOW_ID`,
`EXPORT_HANDLE_DISPUTE_FLOW_ID`, `EXPORT_RECOVERY_FLOW_ID`.
Set any of these to a specific `flow_id` to pin an exact trace.
