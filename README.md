# ExamOps

ExamOps is a session-authenticated examination operations workspace for departments, students, invigilators, and HODs. This repository contains a TypeScript Express API, React/Vite client, direct PostgreSQL access through `pg`, Docker setup, tests, and GitHub Actions deployment configuration.

## Run locally

Prerequisites: Node 22+, Docker Desktop, and an Aiven PostgreSQL service. Copy the Aiven service connection string into `DATABASE_URL` in `.env`; keep `sslmode=require`.

```bash
cp .env.example .env
npm install
psql "$DATABASE_URL" -f apps/api/db/migrations/20261016182221_init/migration.sql
npm run db:seed
npm run dev
```

The database schema is applied with the checked-in SQL migration; Prisma is not required. The Aiven connection string must include `sslmode=require`.

The adaptive operations module adds the Change desk and Risk radar views. Apply `apps/api/db/migrations/20261017_adaptive_ops.sql` after the base schema to enable disruption history, ranked room/invigilator alternatives, HOD approval records, decision history, and post-examination reviews.

Open `http://localhost:5173` for the Vite client. The local API health check is `http://localhost:4000/health`; the Compose-served app uses `http://localhost:5173/health`.

Development seed credentials use the fictional password `ExamOps-Demo-2026!` for `admin@examops.local`, `hod@examops.local`, and `student1@examops.local`. Never reuse these credentials outside local development.

## Checks

```bash
npm run typecheck
npm test
npm run build
docker build -t examops:local .
```

The API uses server-side PostgreSQL sessions, HTTP-only SameSite cookies, Argon2 password hashes, Zod validation, Helmet, CORS allowlisting, rate limiting on login, and backend role middleware. Students and invigilators are scoped to their own issue reports; HOD data is department-scoped.

## Production deployment

1. Install Docker Compose on a Linux VPS and create a private application directory.
2. Copy `docker-compose.prod.yml` and a server-only `.env.production` containing `APP_IMAGE`, Aiven `DATABASE_URL`, `SESSION_SECRET`, `WEB_ORIGIN`, and `SESSION_COOKIE_SAMESITE=none` when the frontend is on GitHub Pages.
3. Put Caddy or Nginx in front of `127.0.0.1:4000` for HTTPS; do not expose Postgres publicly.
4. Configure GitHub environment secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `VPS_APP_DIR`, `GHCR_USERNAME`, and `GHCR_TOKEN`. Give the token read-only package access.
5. Push a version tag such as `v1.0.0` or run the Deploy workflow manually.
6. Verify the reverse-proxied `/health` endpoint, then back up from a trusted machine with `pg_dump "$DATABASE_URL" > backup.sql`.

The deployment workflow starts the tagged image, waits for the local health endpoint, and uses a concurrency lock so two production deploys cannot overlap. A rollback is performed by setting `APP_IMAGE` to the previous SHA and running `docker compose -f docker-compose.prod.yml up -d`.

## Repository layout

`apps/api` contains Express routes, middleware, PostgreSQL data access, SQL schema/seed, and integration tests. `apps/web` contains the React client. `Dockerfile`, Compose files, and `.github/workflows` define packaging and delivery.

## Known manual steps

The SQL schema must be applied once against the Aiven PostgreSQL service with `DATABASE_URL` set; schema changes are intentionally not performed by application startup. `AIVEN_API_TOKEN` is only for external Aiven provisioning scripts and is not read by the application. A public VPS, DNS record, TLS certificate, and GitHub repository secrets are environment-owned resources and cannot be verified from this workspace.

## GitHub Pages frontend

GitHub Pages hosts only the compiled React frontend. The Express API must be deployed separately on a public HTTPS host, with Aiven as its database. In repository settings, enable Pages with **GitHub Actions** as the source and add the repository variable `VITE_API_URL`, for example `https://api.example.com/api/v1`. The workflow in `.github/workflows/pages.yml` builds `/exam-ops/` and deploys it automatically from `main`.

Set the API's `WEB_ORIGIN` to the Pages origin, such as `https://kaivan005.github.io`, and keep `DATABASE_URL`, `SESSION_SECRET`, and all Aiven credentials only in the API host's environment. Do not put `DATABASE_URL`, `SESSION_SECRET`, or `AIVEN_API_TOKEN` in GitHub Pages variables because Vite variables are public.
