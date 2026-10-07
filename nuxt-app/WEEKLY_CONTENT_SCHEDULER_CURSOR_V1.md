# Weekly Content Scheduler Cursor V1

This is a bounded local engineering correction to the existing weekly approval pipeline, not permission to enable operations or publish. The previous global worker repeatedly loaded the first 50 owner configuration rows and could permanently exclude later active clients. The owner UI's bounded read must not be used as the scheduler's candidate source.

## Storage and candidate transaction

`weeklyContentSchedulerCursors` contains exactly an owner primary/foreign key, a nonnegative `afterConfigId`, and a millisecond `updatedAt`. It contains no customer identity, tokens, draft, consent, provider material or model data. `0050` is additive; generation does not apply it. The deployment must keep the global scheduler disabled until the exact migration is reviewed and applied.

The repository validates positive safe owner IDs and an integral client limit in 1..10 before storage work. It atomically creates the owner row without resetting an existing cursor, locks that exact row, reads only that owner's active configurations with IDs after the cursor in ascending order, and wraps with IDs at or before it if needed. At most two bounded configuration queries and ten returned configurations are allowed. Sparse or deleted IDs do not consume slots; paused/revoked/foreign configurations cannot enter the batch. Duplicate, unordered, out-of-range, malformed, foreign or oversized storage projections fail the transaction. The final selected configuration ID becomes the durable cursor, preserving keyset order; an empty active set uses a safe zero position.

The transaction contains storage only and returns candidates after commit. Cursor progress is not a work reservation, draft approval, budget, policy or provider authority. Concurrent ticks serialize owner cursor decisions; normal work remains subject to the canonical entry/job reservations. A failed transaction must return no actionable batch. After a worker crash, candidates eventually recur on wrap; advancing the cursor cannot mark an article completed. No in-process cursor or time-modulo window is used by the global production path.

## Runtime authority remains unchanged

Feature, global scheduler and static LINE readiness checks still precede dependency construction. Exact-client runs continue to read the requested owner/client directly and never advance the global cursor. Before processing a selected candidate, the worker rereads its current configuration and compares owner/client/configuration IDs, active status, target, policy and both configuration fingerprints. Any drift stops that candidate before calendar, generation or publication work. Current recipient binding, policy expiry and fingerprint, target, sources, risk, quality, exact draft, budgets and latest customer approval continue through the canonical workflow and publication reservation.

The per-invocation ceiling stays ten clients and ten notifications, including caller-supplied limits. The LINE webhook records consent only; it never publishes, generates or sends. No source/model approval, production model activation or paid provider call is added by this change. Default-off execution must do no cursor/database/provider I/O.

## Calendar history is not a global UI list

Weekly runtime and both planner paths request calendars by the server-resolved owner/client before SQL limiting. Owner-only workbench reads remain capped at 100. Client-scoped reads inspect at most 101; a 101st calendar blocks the workflow rather than hiding used topics, pending articles or monthly cost. Archived calendars still consume their original topics and applicable cost; blocked history is not empty or unused history. General pagination and unlimited customer history are not supplied by this increment.

## Verification and operational boundary

Safe tests must cover >50 active configurations, a paused/revoked prefix, sparse IDs, owner separation, wrap, persistence across repository reconstruction, concurrent cursor decisions, rollback, invalid input/projections and configuration drift with zero provider work. Exact SQL predicates, limits and locking must be verified; a separately opt-in disposable MySQL rehearsal may prove actual transactions and migration, but is not TiDB production acceptance.

The new migration, production cursor writes, real LINE/generation/publication and host scheduling require their own explicit approval and acceptance. Render Free sleep, missed ticks, actual message receipt, real data rights and production model quality are not fixed or proven by fair candidate selection. Existing mail increments 0048/0049 and their local evidence remain separate.
