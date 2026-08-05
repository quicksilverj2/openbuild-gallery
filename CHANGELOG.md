# Changelog

## Unreleased

- **Poll clone (seed):** create a poll, vote once, live tally. Correct under a
  concurrent burst — one vote per voter, idempotent retries, zero 5xx under race.
- **The gate:** invariant test suite + a re-runnable live concurrency probe
  (`probes/concurrency.mjs`), wired into CI (green-from-clean-checkout + live probe).
