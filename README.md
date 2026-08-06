# OpenBuild Gallery

A **hiring sandbox**: a small, deployed, open-source gallery of tiny working app-clones. Candidates pick a feature from the wishlist, open a PR, get a live preview + an automated review, and the strongest implementations get merged to production and credited. PR quality is the interview signal.

This repo is the **v0 seed** plus sibling clones: a **Poll** (seed) and a **Shortlink** (bounty #3), both built to the bar we grade against — correct under concurrent load, tested from a clean checkout, migrated, observable.

## Why the Poll clone looks the way it does

The one endpoint that matters is `POST /polls/:id/votes`. Its job is to stay correct when many requests race:

- **Votes are append-only; the tally is a `COUNT`.** There is no mutable counter to race on, so lost updates are impossible by construction.
- **Two unique constraints** enforce the invariants: one vote per `(poll, voter)`, and one effect per `idempotencyKey`.
- **Collisions become clean responses, never 5xx.** A concurrent writer that loses a unique index gets a `409` (already voted / key conflict) or a `200` idempotent replay — the API translates the DB's `P2002`, it never leaks a 500.

The live probe (`probes/concurrency.mjs`) fires 50 concurrent votes and asserts the invariant holds with **zero 5xx**. That same probe is the PR gate and what the reviewer bot runs against each preview.

## Layout

```
apps/api        Fastify + Prisma + Postgres. Poll + Shortlink clones and their gates.
probes          concurrency.mjs (live gate for poll + shortlink) + wait-ready.sh
.github         pr-checks.yml — green-from-clean-checkout + the live probe
```

## Run it locally

Requires Node 20+ and a reachable Postgres. With pnpm (`corepack enable`):

```bash
pnpm install
cp .env.example .env                       # point DATABASE_URL at your Postgres
pnpm --filter api exec prisma migrate deploy
pnpm --filter api exec prisma db seed
pnpm -w run test                           # the invariant suite
pnpm --filter api start                    # then, in another shell:
node probes/concurrency.mjs http://localhost:3000
```

## The loop (what candidates experience)

1. Pick a **bounty** (a labeled Issue) → open a PR.
2. CI runs the gate; the PR gets a **preview URL**; the reviewer bot posts a structured review.
3. If it clears the bar and wins the bounty, it's **merged to production** and credited.

See `../CONTRIBUTING.md`, `../BOUNTIES.md`, and `../REVIEWER-BOT.md` for the process, backlog, and grading.

> Non-commercial hiring sandbox. Contributions are an **optional evaluation**, credited under MIT, AI-use disclosed. See `../CONTRIBUTOR-TERMS-and-INVITE.md`.
