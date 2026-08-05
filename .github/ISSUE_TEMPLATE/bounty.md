---
name: Bounty
about: A scoped feature candidates can claim and ship as a PR
title: '[bounty] '
labels: [bounty]
---

## Feature

<!-- One or two sentences: what to build. -->

## Tier & area

<!-- tier:junior | tier:mid | tier:senior · area:backend | area:frontend | area:infra -->

## Acceptance criteria (the bar)

- [ ] **Correctness gate:** the concurrency/invariant probe passes on the preview — **zero 5xx**
- [ ] **Whole test suite green from a clean checkout**, including a real test for the invariant
- [ ] **Deploy/observe:** migrations apply; the key events are logged; health endpoints work
- [ ] **No regression:** existing clones' probes still pass
- [ ] **Honesty:** the PR description matches what actually runs; AI use disclosed

## The invariant / gate

<!-- e.g. "50 concurrent same-voter votes → counts once; distinct voters → exact tally; zero 5xx" -->

## Notes

Multiple people may claim this bounty — the strongest implementation gets merged; everyone gets feedback.
Comment "claiming" to take it.
