# Tests

Runner: Node's built-in `node:test`, with `tsx` (already a dev dependency) for TypeScript.

## Pure unit tests (no database)

```bash
pnpm test
```

## Database-backed integration tests

These TRUNCATE catalog and appointment tables, so they run only against a
dedicated test database. They never use `DATABASE_URL` / `DIRECT_URL` from `.env`.

`TEST_DATABASE_URL` must be set, its database name must contain `test`, and it
must not point at the same database as `DATABASE_URL` or `DIRECT_URL`.
Otherwise the tests are skipped (when unset) or refuse to run (when unsafe).

Example using a local Postgres (e.g. Postgres.app):

```bash
createdb yasmin_booking_test
export TEST_DATABASE_URL="postgresql://localhost:5432/yasmin_booking_test"
pnpm test:db:prepare    # prisma migrate deploy against the test DB only
pnpm test:integration
```
