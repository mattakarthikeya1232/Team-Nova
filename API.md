# API

Every response has a request ID:

```json
{ "success": true, "data": {}, "requestId": "…" }
```

Errors use:

```json
{ "success": false, "error": { "code": "DATASET_SCHEMA_INVALID", "message": "…", "details": {}, "suggestedActions": [] }, "requestId": "…" }
```

## Read endpoints

- `GET /api/health` — runs `SELECT 1`; returns real dependency status and database latency.
- `GET /api/dashboard` — active workspace, dataset, latest prediction, runs, and unresolved diagnostics.
- `GET /api/datasets?q=` and `GET /api/datasets/:id`
- `GET /api/network?datasetId=`
- `GET /api/anomalies?datasetId=` — rolling mean, standard deviation, and rate-of-change analysis over recorded temporal observations; returns an explicit unavailable state when no qualifying series exists.
- `GET /api/scenarios` and `GET /api/scenarios/:id`
- `GET /api/interventions/:scenarioId`
- `GET /api/diagnostics`, `GET /api/ingestion-runs`

## Write endpoints

- `POST /api/datasets/snap/catalog` imports metadata from the official SNAP catalog.
- `POST /api/datasets/upload` accepts a multipart `file` and inspects/normalizes it server-side.
- `POST /api/datasets/:id/download`, `/use`, `/copy`, `/mapping`
- `POST /api/nodes`, `PATCH|DELETE /api/nodes/:id`
- `POST /api/dependencies`, `PATCH|DELETE /api/dependencies/:id`
- `POST /api/scenarios`
- `POST /api/cascade/run`
- `POST /api/interventions/calculate`, `POST /api/interventions/:id/apply`

The handlers log request ID, route, duration, and success/failure without connection strings, credentials, or raw secrets.
