# Deploy (everything on Render + Neon)

One platform. `render.yaml` defines both services; you connect the repo once.

## Your steps (~10 min, one-time)

1. **Neon** → copy your database's **pooled** connection string (starts `postgresql://…`, host contains `-pooler`). Keep it handy.
2. **Render** → **New → Blueprint** → pick `quicksilverj2/openbuild-gallery`. Render reads `render.yaml` and shows two services: `openbuild-api` and `openbuild-web`.
3. When prompted for the `openbuild-api` env var **`DATABASE_URL`**, paste the Neon pooled string. (It's `sync: false` — it lives only in Render, never in git.)
4. **Apply.** Render builds both:
   - `openbuild-api` runs `prisma migrate deploy` + `db seed`, then starts Fastify. Health check: `/healthz`.
   - `openbuild-web` builds the static gallery; `NEXT_PUBLIC_API_URL` is wired to the API automatically.
5. Ping me with the two URLs (or just say it's deployed) and I'll probe the live API and confirm the invariant holds in production.

## What you get

- Gallery: `https://openbuild-web.onrender.com` (always-on, free).
- API: `https://openbuild-api.onrender.com` (free tier sleeps after ~15 min idle → ~50s first hit; a paid instance removes that).
- Per-PR preview services are enabled; they share the one Neon DB for now (per-PR DB isolation = bounty #9, a Neon branch per preview).

## Notes

- No secrets ever go through chat or into git — `DATABASE_URL` is pasted straight into Render.
- CORS on the API reflects any origin (no cookies/credentials are used), so the gallery works out of the box.
