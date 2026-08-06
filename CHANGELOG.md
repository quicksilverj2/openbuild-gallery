# Changelog

## Unreleased

- **Shortlink clone (bounty #3):** `POST /shorten` + `GET /:code` redirect.
  Identical URLs dedupe to one code; concurrent same URL/alias races resolve to
  exactly one row with zero 5xx. Codes are random (non-enumerable). Migration
  `0001_shortlink`, seed entry, web demo, and probe scenarios included.
- **Poll clone (seed):** create a poll, vote once, live tally. Correct under a
  concurrent burst — one vote per voter, idempotent retries, zero 5xx under race.
- **The gate:** invariant test suite + a re-runnable live concurrency probe
  (`probes/concurrency.mjs`), wired into CI (green-from-clean-checkout + live probe).
