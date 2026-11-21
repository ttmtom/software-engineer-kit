# SQL Profile

## Architecture
- Design normalized schemas with explicit primary/foreign keys, nullability, check constraints, and indexes matching query patterns.
- Plan migrations to be backward-compatible and safe under live traffic (avoid long table locks; consider expand-and-contract).
- Define transaction boundaries and concurrency control (`UPDATE ... WHERE`, optimistic versioning, or `SELECT ... FOR UPDATE`).

## Implement
- Always use parameterized queries/prepared placeholders (`$1`, `?`) — never interpolate user input into SQL strings.
- Select explicit columns rather than `SELECT *` in application queries.
- Keep transactions short and bounded; avoid holding DB transactions open across network calls.
- Write deterministic, reversible migrations with matching indexes for foreign keys and high-selectivity filters.

## Test
- Test migrations cleanly (up/down or fresh schema apply) and verify constraints (`UNIQUE`, `FK`, `NOT NULL`, `CHECK`).
- Test concurrent or repeated state-transition updates (e.g., conditional `UPDATE` row counts, conflict handling).
- Inspect `EXPLAIN` / query plans on non-trivial joins or filters to catch sequential scans and N+1 loops.

## Review
- Reject any string-concatenated SQL, missing `WHERE` tenant/owner predicates, or unbounded `SELECT` without `LIMIT`/pagination.
- Flag destructive or locking schema changes (`ALTER TABLE`, `DROP`, `NOT NULL` backfill) lacking a safe rollout path.
- Verify missing indexes on new query predicates and confirm transaction rollback behavior on errors.
