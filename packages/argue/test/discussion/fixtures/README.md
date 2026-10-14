# Frozen peer baseline fixtures

Captured from the unchanged `af34aaceb40155d010e0e9f7e8abd1f4945c6a0d` core on 2026-10-13, before the stage 0 extraction. These are synthetic offline sessions, not real model output or user transcripts. `sourceCommit: baseline` is a fixture label.

`peer-baseline.json` stores 50 request digests and input hashes: peer-v1 through peer-v5, both members, opening, three discussion snapshots and review. Construction uses `makeConfig("baseline-" + promptVersion)`, one source `Option A\nA caveat`, identical opening claims (`Choose A`, `Fits`, empty assumptions/sourceRefs), then `makeDiscussionTurn()` until review. Each digest is SHA256 of the complete `JSON.stringify(buildMemberRequest(...))`, so messages, output schema and domain fields are covered. Review hashes are captured too.

`peer-v5-paused.json` uses `makeConfig("baseline-paused-v5")`, prompt peer-v5 and the same source. The original PeerSessionDriver ran with a fixed clock at `2026-10-13T00:00:01.000Z`; both runtimes threw the synthetic retryable `transport_error` / `Synthetic failure`. It contains original frozen inputs, jobs, attempts and hashes, and is read and resumed by the storage regression.

These fixtures are compatibility evidence. Do not regenerate them from changed protocol code to make a failure pass; inspect any difference against the captured baseline first.
