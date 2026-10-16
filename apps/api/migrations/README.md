Apply the checked-in SQL schema once to Aiven PostgreSQL:

Run `npm run db:init` from the repository root. It loads the root `.env`, applies the base and adaptive SQL migrations, and records applied migration names.

The API uses parameterized `pg` queries after that. The session store creates its `session` table automatically on first startup.
