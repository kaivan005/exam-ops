Apply the checked-in SQL schema once to Aiven PostgreSQL:

```bash
psql "$DATABASE_URL" -f apps/api/db/migrations/20261016182221_init/migration.sql
```

The API uses parameterized `pg` queries after that. The session store creates its `session` table automatically on first startup.
