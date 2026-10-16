# ExamOps

ExamOps is a session-authenticated examination operations workspace for departments, students, invigilators, and HODs. This repository contains a TypeScript Express API, React/Vite client, Prisma/PostgreSQL schema, Docker setup, tests, and GitHub Actions deployment configuration. Prisma ORM 8 is the deployment CLI and contract layer; the existing Prisma 7 client is isolated as `prisma7` compatibility tooling while routes are migrated.

## Run locally

Prerequisites: Node 22+, Docker Desktop, and a reachable PostgreSQL instance (Docker Compose supplies one).

```bash
cp .env.example .env
npm install
npm run db:generate
docker compose up -d db
npx prisma migrate dev --schema apps/api/prisma/schema.prisma --name init
npm run db:seed
npm run dev
```

Prisma 8 checks are available with `npm run db:contract` and `npm run db:verify` after the database has been adopted by the Prisma 8 contract. Existing schema migrations still run through the explicit `prisma7` compatibility command until the staged route and migration handoff is complete.

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
2. Copy `docker-compose.prod.yml` and a server-only `.env.production` containing `APP_IMAGE`, `DATABASE_URL`, `SESSION_SECRET`, `WEB_ORIGIN`, and Postgres variables.
3. Put Caddy or Nginx in front of `127.0.0.1:4000` for HTTPS; do not expose Postgres publicly.
4. Configure GitHub environment secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `VPS_APP_DIR`, `GHCR_USERNAME`, and `GHCR_TOKEN`. Give the token read-only package access.
5. Push a version tag such as `v1.0.0` or run the Deploy workflow manually.
6. Verify the reverse-proxied `/health` endpoint, then back up with `docker compose -f docker-compose.prod.yml exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`.

The deployment workflow runs migrations before starting the tagged image, waits for the local health endpoint, and uses a concurrency lock so two production deploys cannot overlap. A rollback is performed by setting `APP_IMAGE` to the previous SHA and running `docker compose -f docker-compose.prod.yml up -d`.

## Repository layout

`apps/api` contains Express routes, middleware, Prisma schema/seed, and integration tests. `apps/web` contains the React client. `Dockerfile`, Compose files, and `.github/workflows` define packaging and delivery.

## Known manual steps

The first Prisma migration must be generated against a reachable PostgreSQL server with the command shown above; migration generation is intentionally not performed by application startup. A public VPS, DNS record, TLS certificate, and GitHub repository secrets are environment-owned resources and cannot be verified from this workspace.
