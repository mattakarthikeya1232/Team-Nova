

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DatasetStatus" AS ENUM ('AVAILABLE', 'DOWNLOADING', 'PROCESSING', 'IMPORTED', 'PARTIALLY_IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "StorageKind" AS ENUM ('POSTGRESQL', 'FILE_STORAGE', 'HYBRID');

-- CreateEnum
CREATE TYPE "CompatibilityStatus" AS ENUM ('READY', 'READY_WITH_MAPPING', 'NOT_COMPATIBLE');

-- CreateEnum
CREATE TYPE "NodeType" AS ENUM ('POWER', 'WATER', 'HEALTHCARE', 'TELECOM', 'EMERGENCY', 'TRANSIT', 'OTHER');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('OPERATIONAL', 'DEGRADED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScenarioStatus" AS ENUM ('DRAFT', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "InterventionStatus" AS ENUM ('PROPOSED', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('FAILURE', 'DEGRADATION', 'OVERLOAD', 'ANOMALY', 'MAINTENANCE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "activeDatasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "parentDatasetId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "documentationUrl" TEXT,
    "license" TEXT,
    "category" TEXT,
    "datasetType" TEXT,
    "format" TEXT,
    "sizeBytes" BIGINT,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "isTemporal" BOOLEAN NOT NULL DEFAULT false,
    "isDirected" BOOLEAN NOT NULL DEFAULT true,
    "isWeighted" BOOLEAN NOT NULL DEFAULT false,
    "status" "DatasetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "storage" "StorageKind" NOT NULL DEFAULT 'FILE_STORAGE',
    "compatibility" "CompatibilityStatus" NOT NULL DEFAULT 'READY_WITH_MAPPING',
    "compatibilityDetails" JSONB,
    "checksum" TEXT,
    "storageLocation" TEXT,
    "provenance" JSONB,
    "isCatalog" BOOLEAN NOT NULL DEFAULT false,
    "isUserUpload" BOOLEAN NOT NULL DEFAULT false,
    "isProjectCopy" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetSource" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "url" TEXT,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetFile" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "isRaw" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetImport" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "sourceId" TEXT,
    "status" "DatasetStatus" NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "bytesRead" BIGINT NOT NULL DEFAULT 0,
    "bytesTotal" BIGINT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DatasetImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetSchema" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "importId" TEXT,
    "fields" JSONB NOT NULL,
    "delimiter" TEXT,
    "hasHeader" BOOLEAN NOT NULL DEFAULT true,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetMapping" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default mapping',
    "mapping" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatasetMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataIngestionRun" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "importId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "rowsRejected" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataIngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "NodeType" NOT NULL DEFAULT 'OTHER',
    "status" "NodeStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "criticality" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "capacity" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "currentLoad" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "health" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "failureThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dependency" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "propagationProbability" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "propagationDelay" INTEGER NOT NULL DEFAULT 15,
    "relationship" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeAttribute" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NodeAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeObservation" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "NodeObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerNodeId" TEXT,
    "triggerSeverity" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "triggerType" "EventType" NOT NULL DEFAULT 'FAILURE',
    "scheduledFor" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "affectedParameter" TEXT,
    "status" "ScenarioStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioEvent" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "severity" DOUBLE PRECISION NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationRun" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "modelName" TEXT NOT NULL,
    "inputSnapshot" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "affected" BOOLEAN NOT NULL,
    "state" "NodeStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "impactScore" DOUBLE PRECISION NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "critical" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "timeOffset" INTEGER NOT NULL DEFAULT 0,
    "sourceData" JSONB,

    CONSTRAINT "SimulationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CascadePrediction" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "modelVersionId" TEXT,
    "probability" DOUBLE PRECISION NOT NULL,
    "impactScore" DOUBLE PRECISION NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "criticalEndpoints" INTEGER NOT NULL DEFAULT 0,
    "timeToImpact" INTEGER NOT NULL DEFAULT 0,
    "reasoning" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CascadePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CascadePath" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "previousNodeId" TEXT,
    "hop" INTEGER NOT NULL,
    "delayMinutes" INTEGER NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "CascadePath_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Intervention" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "targetNodeId" TEXT,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timeToEffect" INTEGER NOT NULL DEFAULT 30,
    "feasibility" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "expectedReduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "InterventionStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Intervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterventionCandidate" (
    "id" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "dependencyId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "riskReduction" DOUBLE PRECISION NOT NULL,
    "criticalityProtected" DOUBLE PRECISION NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,

    CONSTRAINT "InterventionCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppliedIntervention" (
    "id" TEXT NOT NULL,
    "interventionId" TEXT NOT NULL,
    "baselineRunId" TEXT,
    "afterRunId" TEXT,
    "riskReduction" DOUBLE PRECISION NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppliedIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "parameters" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "datasetId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "datasetId" TEXT,
    "scenarioId" TEXT,
    "requestId" TEXT,
    "severity" "Severity" NOT NULL,
    "component" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "technicalDetails" TEXT,
    "parameters" JSONB,
    "suggestedFix" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Project_ownerId_updatedAt_idx" ON "Project"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Project_activeDatasetId_idx" ON "Project"("activeDatasetId");

-- CreateIndex
CREATE INDEX "Dataset_projectId_updatedAt_idx" ON "Dataset"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "Dataset_provider_category_idx" ON "Dataset"("provider", "category");

-- CreateIndex
CREATE INDEX "Dataset_status_compatibility_idx" ON "Dataset"("status", "compatibility");

-- CreateIndex
CREATE INDEX "Dataset_parentDatasetId_idx" ON "Dataset"("parentDatasetId");

-- CreateIndex
CREATE INDEX "DatasetSource_datasetId_idx" ON "DatasetSource"("datasetId");

-- CreateIndex
CREATE INDEX "DatasetFile_datasetId_createdAt_idx" ON "DatasetFile"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "DatasetImport_datasetId_startedAt_idx" ON "DatasetImport"("datasetId", "startedAt");

-- CreateIndex
CREATE INDEX "DatasetImport_status_startedAt_idx" ON "DatasetImport"("status", "startedAt");

-- CreateIndex
CREATE INDEX "DatasetSchema_datasetId_detectedAt_idx" ON "DatasetSchema"("datasetId", "detectedAt");

-- CreateIndex
CREATE INDEX "DatasetMapping_datasetId_isActive_idx" ON "DatasetMapping"("datasetId", "isActive");

-- CreateIndex
CREATE INDEX "DataIngestionRun_datasetId_startedAt_idx" ON "DataIngestionRun"("datasetId", "startedAt");

-- CreateIndex
CREATE INDEX "Node_datasetId_type_idx" ON "Node"("datasetId", "type");

-- CreateIndex
CREATE INDEX "Node_datasetId_status_idx" ON "Node"("datasetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Node_datasetId_code_key" ON "Node"("datasetId", "code");

-- CreateIndex
CREATE INDEX "Dependency_datasetId_fromNodeId_idx" ON "Dependency"("datasetId", "fromNodeId");

-- CreateIndex
CREATE INDEX "Dependency_datasetId_toNodeId_idx" ON "Dependency"("datasetId", "toNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Dependency_datasetId_fromNodeId_toNodeId_key" ON "Dependency"("datasetId", "fromNodeId", "toNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeAttribute_nodeId_key_key" ON "NodeAttribute"("nodeId", "key");

-- CreateIndex
CREATE INDEX "NodeObservation_nodeId_observedAt_idx" ON "NodeObservation"("nodeId", "observedAt");

-- CreateIndex
CREATE INDEX "Scenario_projectId_createdAt_idx" ON "Scenario"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Scenario_datasetId_status_idx" ON "Scenario"("datasetId", "status");

-- CreateIndex
CREATE INDEX "ScenarioEvent_scenarioId_occurredAt_idx" ON "ScenarioEvent"("scenarioId", "occurredAt");

-- CreateIndex
CREATE INDEX "SimulationRun_scenarioId_startedAt_idx" ON "SimulationRun"("scenarioId", "startedAt");

-- CreateIndex
CREATE INDEX "SimulationResult_nodeId_probability_idx" ON "SimulationResult"("nodeId", "probability");

-- CreateIndex
CREATE UNIQUE INDEX "SimulationResult_runId_nodeId_key" ON "SimulationResult"("runId", "nodeId");

-- CreateIndex
CREATE INDEX "CascadePrediction_scenarioId_createdAt_idx" ON "CascadePrediction"("scenarioId", "createdAt");

-- CreateIndex
CREATE INDEX "CascadePath_predictionId_hop_idx" ON "CascadePath"("predictionId", "hop");

-- CreateIndex
CREATE INDEX "Intervention_scenarioId_status_idx" ON "Intervention"("scenarioId", "status");

-- CreateIndex
CREATE INDEX "InterventionCandidate_interventionId_score_idx" ON "InterventionCandidate"("interventionId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "AppliedIntervention_interventionId_key" ON "AppliedIntervention"("interventionId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersion_name_version_key" ON "ModelVersion"("name", "version");

-- CreateIndex
CREATE INDEX "AuditLog_projectId_createdAt_idx" ON "AuditLog"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_datasetId_createdAt_idx" ON "AuditLog"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_createdAt_severity_idx" ON "ErrorEvent"("createdAt", "severity");

-- CreateIndex
CREATE INDEX "ErrorEvent_datasetId_resolved_idx" ON "ErrorEvent"("datasetId", "resolved");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_activeDatasetId_fkey" FOREIGN KEY ("activeDatasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_parentDatasetId_fkey" FOREIGN KEY ("parentDatasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetSource" ADD CONSTRAINT "DatasetSource_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetFile" ADD CONSTRAINT "DatasetFile_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetImport" ADD CONSTRAINT "DatasetImport_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetImport" ADD CONSTRAINT "DatasetImport_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DatasetSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetSchema" ADD CONSTRAINT "DatasetSchema_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetMapping" ADD CONSTRAINT "DatasetMapping_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataIngestionRun" ADD CONSTRAINT "DataIngestionRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataIngestionRun" ADD CONSTRAINT "DataIngestionRun_importId_fkey" FOREIGN KEY ("importId") REFERENCES "DatasetImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_fromNodeId_fkey" FOREIGN KEY ("fromNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_toNodeId_fkey" FOREIGN KEY ("toNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAttribute" ADD CONSTRAINT "NodeAttribute_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeObservation" ADD CONSTRAINT "NodeObservation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scenario" ADD CONSTRAINT "Scenario_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scenario" ADD CONSTRAINT "Scenario_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioEvent" ADD CONSTRAINT "ScenarioEvent_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioEvent" ADD CONSTRAINT "ScenarioEvent_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationResult" ADD CONSTRAINT "SimulationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationResult" ADD CONSTRAINT "SimulationResult_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CascadePrediction" ADD CONSTRAINT "CascadePrediction_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CascadePrediction" ADD CONSTRAINT "CascadePrediction_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CascadePath" ADD CONSTRAINT "CascadePath_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "CascadePrediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CascadePath" ADD CONSTRAINT "CascadePath_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionCandidate" ADD CONSTRAINT "InterventionCandidate_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterventionCandidate" ADD CONSTRAINT "InterventionCandidate_dependencyId_fkey" FOREIGN KEY ("dependencyId") REFERENCES "Dependency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppliedIntervention" ADD CONSTRAINT "AppliedIntervention_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppliedIntervention" ADD CONSTRAINT "AppliedIntervention_baselineRunId_fkey" FOREIGN KEY ("baselineRunId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppliedIntervention" ADD CONSTRAINT "AppliedIntervention_afterRunId_fkey" FOREIGN KEY ("afterRunId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

