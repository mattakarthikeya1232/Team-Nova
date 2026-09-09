# Architecture

```text
Next.js control plane
        ↓
Route handlers (/api/*) + structured error contract
        ↓
Dataset, project, cascade, intervention, and diagnostics services
        ↓
Prisma Client (server runtime only)
        ↓
Existing Neon PostgreSQL + server-side raw-file storage
```

`DATABASE_URL` is accessed only by Prisma on the server. The browser calls route handlers and receives a `{ success, data | error, requestId }` contract.

The checked-in migration is an initial schema for an empty database. An existing, populated prototype database must be backed up and schema-inspected before creating its data-preserving incremental migration; it must not be treated as empty.

## Persistence model

- `Dataset` is the catalog/upload/source record, with provenance, storage strategy, compatibility, and version lineage.
- `DatasetFile`, `DatasetImport`, `DatasetSchema`, `DatasetMapping`, and `DataIngestionRun` capture the ingestion lifecycle.
- Normalized network data is relational: `Node`, `Dependency`, `NodeAttribute`, and `NodeObservation`.
- `Project` selects an active dataset. A project copy is a new version and never mutates its parent source dataset.
- `Scenario`, `SimulationRun`, `SimulationResult`, `CascadePrediction`, and `CascadePath` persist explainable calculations.
- `Intervention`, `InterventionCandidate`, and `AppliedIntervention` preserve before/after decision records.
- `ErrorEvent` and `AuditLog` provide diagnostics and observability without secrets.

## Engines

`TransparentGraphModel 1.0.0` is an explainable graph traversal. Each propagation step uses recorded dependency strength and probability plus target health, load/capacity pressure, criticality, and delay. It is not a claim of live or ML-based prediction.

The intervention service re-evaluates the same scenario with candidate dependency links blocked; it does not fabricate estimated before/after values.

For temporal imports with mapped timestamp and numeric strength fields, normalized `NodeObservation` records feed a rolling-mean, standard-deviation, and rate-of-change detector. Datasets without a qualifying series return an explicit unavailable state.

## Storage policy

Small supported imports are normalized into PostgreSQL while retaining their raw file. The app reports `HYBRID` when both exist. Oversized files are rejected for an asynchronous hybrid worker rather than being incorrectly shown as imported.
