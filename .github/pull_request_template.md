<!-- Thanks for building with us. Keep it scoped to ~a day. -->

## What this does

<!-- Which bounty (link the issue) and what you implemented. -->

Closes #

## The invariant

<!-- Which correctness/concurrency gate does this bounty have, and how did you satisfy it?
     Point to your test for it. -->

## How I verified it

<!-- Paste the output of the bounty's probe against your local/preview:
     node probes/<invariant>.mjs <url> -->

## Checklist

- [ ] Whole test suite is green from a clean checkout (`pnpm -w run test`) — including a real test for the invariant
- [ ] The concurrency/correctness probe passes with **zero 5xx**
- [ ] Migrations apply cleanly on a fresh DB; key events are logged
- [ ] No regressions to other clones' probes
- [ ] I've read `TERMS.md` — this is an optional evaluation, my work is credited under MIT

**AI usage (directed vs. decided):**
<!-- Required. What did you direct the AI to do, and what did you decide yourself? -->
