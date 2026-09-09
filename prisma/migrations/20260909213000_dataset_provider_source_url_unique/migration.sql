-- Catalog imports are idempotent per provider/source pair. PostgreSQL permits
-- multiple NULL source URLs, so user-created and local datasets remain valid.
CREATE UNIQUE INDEX "Dataset_provider_sourceUrl_key" ON "Dataset"("provider", "sourceUrl");
