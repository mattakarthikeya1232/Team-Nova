# Chain Reaction

**Predict the cascade. Stop it before it spreads.**

Chain Reaction is a PostgreSQL-backed control plane for importing network data, modelling dependency cascades, and comparing intervention outcomes. It does not use browser-local mock data as application state.

## Run locally

1. Copy `.env.example` to `.env` and set the existing Neon `DATABASE_URL`. Keep it server-only; never use a `NEXT_PUBLIC_` prefix.
2. For an empty existing Neon database, apply the checked-in migration with `npx prisma migrate deploy`. If Neon already contains prototype tables created outside Prisma migrations, first take a backup and inspect it with `npx prisma db pull`; do not run an initial migration against unknown populated tables.
3. Seed the clearly labelled controlled synthetic fixture with `npm run db:seed` (optional but useful for a demo).
4. Start the app with `npm run dev`.

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` uses Next's Webpack builder because this environment's Turbopack CSS worker cannot bind its internal IPC socket.

## Product workflow

1. Load the official Stanford SNAP catalog, or upload CSV, TSV, JSON, JSONL, TXT, or GZIP data.
2. Download/import on demand. Raw files are stored server-side and metadata, schemas, mappings, normalized nodes, and dependencies are stored in PostgreSQL.
3. Confirm the source/target mapping when it is not inferable.
4. Use a `READY` dataset in the active project, create a scenario, and run the TransparentGraphModel.
5. Calculate scored intervention candidates, apply one, and compare the saved runs.

All source modes are labelled: PUBLIC CATALOG, USER UPLOADED, PROJECT COPY, or SYNTHETIC. The controlled seed fixture is never presented as live data.

## Limitations

- The synchronous in-process importer is deliberately capped at 25 MB / 250,000 rows. Larger files are marked for a Hybrid object/file-storage worker rather than falsely reported as fully imported.
- ZIP archives are safely rejected in this deployment; extract the supported member first.
- A real Neon `DATABASE_URL` is required for the database, catalog, upload, and simulation workflows. Without it, the UI shows a structured diagnostic instead of fabricated results. This delivery could not inspect or migrate the existing Neon instance because no connection string was provided to the execution environment.
