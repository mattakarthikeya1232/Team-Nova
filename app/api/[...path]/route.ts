import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { DomainError, failure, recordError, requestId, success } from '@/lib/errors'
import { observe } from '@/lib/observability'
import { compatibilityFor, inferMapping, inspectDataset, normalizeDataset, persistRawFile, type Mapping } from '@/lib/ingestion'
import { importSnapCatalog, resolveSnapDownload } from '@/lib/snap'
import { activateDataset, createProjectCopy, createScenario, getWorkspace } from '@/lib/project'
import { runCascade } from '@/lib/cascade'
import { applyIntervention, calculateInterventions } from '@/lib/intervention'
import { analyzeDatasetObservations } from '@/lib/anomaly'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ path: string[] }> }

function withoutStorageLocation<T extends { storageLocation?: unknown }>(value: T) {
  const { storageLocation: _storageLocation, ...publicValue } = value
  return publicValue
}

function asString(value: unknown, name: string) {
  const result = String(value ?? '').trim()
  if (!result) throw new DomainError('VALIDATION_ERROR', `${name} is required.`, 422, { field: name })
  return result
}

async function jsonBody(request: Request) {
  try { return await request.json() } catch { return {} }
}

async function dashboard() {
  const project = await getWorkspace()
  const [dataset, scenario, datasetCount, diagnostics, latestPrediction] = await Promise.all([
    project.activeDatasetId ? prisma.dataset.findUnique({ where: { id: project.activeDatasetId } }) : null,
    prisma.scenario.findFirst({ where: { projectId: project.id }, orderBy: { updatedAt: 'desc' }, include: { events: true } }),
    prisma.dataset.count(),
    prisma.errorEvent.findMany({ where: { resolved: false }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.cascadePrediction.findFirst({ where: { scenario: { projectId: project.id } }, orderBy: { createdAt: 'desc' }, include: { paths: { include: { node: true }, orderBy: [{ hop: 'asc' }, { delayMinutes: 'asc' }] } } }),
  ])
  const [nodeCount, edgeCount, observationCount, scenarios, recentRuns] = dataset ? await Promise.all([
    prisma.node.count({ where: { datasetId: dataset.id } }),
    prisma.dependency.count({ where: { datasetId: dataset.id } }),
    prisma.nodeObservation.count({ where: { node: { datasetId: dataset.id } } }),
    prisma.scenario.findMany({ where: { projectId: project.id }, orderBy: { updatedAt: 'desc' }, take: 12, include: { events: true, predictions: { orderBy: { createdAt: 'desc' }, take: 1 } } }),
    prisma.simulationRun.findMany({ where: { scenario: { projectId: project.id } }, orderBy: { startedAt: 'desc' }, take: 8, include: { scenario: true, results: { where: { affected: true }, select: { id: true } } } }),
  ]) : [0, 0, 0, [], []]
  return { project, activeDataset: dataset ? { ...withoutStorageLocation(dataset), sizeBytes: dataset.sizeBytes?.toString() ?? null, nodes: nodeCount, edges: edgeCount, observations: observationCount } : null, activeScenario: scenario, latestPrediction, scenarios, recentRuns, datasetCount, diagnostics, model: { name: 'TransparentGraphModel', version: '1.0.0', type: 'Explainable graph-based cascade model' } }
}

async function health() {
  const startedAt = performance.now()
  await prisma.$queryRaw`SELECT 1`
  const [datasets, projects] = await Promise.all([prisma.dataset.count(), prisma.project.count()])
  return {
    database: { status: 'ONLINE', latencyMs: Math.round(performance.now() - startedAt), datasets, projects },
    api: { status: 'ONLINE' },
    datasetStorage: { status: 'ONLINE', mode: 'server file storage + PostgreSQL metadata' },
    cascadeEngine: { status: 'ONLINE', model: 'TransparentGraphModel 1.0.0' },
    simulationEngine: { status: 'ONLINE' },
    ingestionEngine: { status: 'ONLINE' },
    checkedAt: new Date().toISOString(),
  }
}

async function downloadDataset(datasetId: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } })
  if (!dataset) throw new DomainError('DATASET_NOT_FOUND', 'The requested dataset was not found.', 404)
  if (!dataset.sourceUrl) throw new DomainError('DATASET_SOURCE_MISSING', 'This dataset has no server-side source URL.', 422)
  const sourceUrl = dataset.provider === 'Stanford SNAP' ? await resolveSnapDownload(dataset.sourceUrl) : dataset.sourceUrl
  const importRun = await prisma.datasetImport.create({ data: { datasetId, status: 'DOWNLOADING' } })
  await prisma.dataset.update({ where: { id: datasetId }, data: { status: 'DOWNLOADING' } })
  try {
    const response = await fetch(sourceUrl, { cache: 'no-store', headers: { 'User-Agent': 'ChainReactionDatasetDownloader/1.0' } })
    if (!response.ok || !response.body) throw new DomainError('DATASET_DOWNLOAD_FAILED', 'The dataset source did not return a readable file.', 502, { sourceUrl, httpStatus: response.status }, ['Retry the download or inspect the source documentation.'])
    const total = Number(response.headers.get('content-length') ?? 0) || undefined
    if (total && total > 25 * 1024 * 1024) throw new DomainError('DATASET_REQUIRES_HYBRID_WORKER', 'This raw file exceeds the synchronous import limit.', 413, { bytes: total, storageStrategy: 'HYBRID' }, ['Configure a background object-storage ingestion worker, then import a selected subset.'])
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytesRead = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytesRead += part.value.byteLength
      if (bytesRead > 25 * 1024 * 1024) throw new DomainError('DATASET_REQUIRES_HYBRID_WORKER', 'The streamed file exceeded the synchronous import limit.', 413, { bytesRead, storageStrategy: 'HYBRID' }, ['Configure a background object-storage ingestion worker, then import a selected subset.'])
      chunks.push(part.value)
      if (bytesRead % (1024 * 1024) < part.value.byteLength) await prisma.datasetImport.update({ where: { id: importRun.id }, data: { bytesRead: BigInt(bytesRead), bytesTotal: total ? BigInt(total) : undefined } })
    }
    const buffer = Buffer.concat(chunks)
    const filename = new URL(sourceUrl).pathname.split('/').pop() || `${dataset.id}.txt`
    await persistRawFile({ datasetId, filename, buffer, mimeType: response.headers.get('content-type') ?? undefined })
    await prisma.datasetImport.update({ where: { id: importRun.id }, data: { status: 'PROCESSING', bytesRead: BigInt(bytesRead), bytesTotal: total ? BigInt(total) : undefined } })
    return await normalizeDataset({ datasetId, buffer, filename, importId: importRun.id })
  } catch (error) {
    await prisma.datasetImport.update({ where: { id: importRun.id }, data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown download error', completedAt: new Date() } })
    await prisma.dataset.update({ where: { id: datasetId }, data: { status: 'FAILED' } })
    throw error
  }
}

async function getDataset(id: string) {
  const dataset = await prisma.dataset.findUnique({
    where: { id },
    include: {
      sources: true,
      files: { orderBy: { createdAt: 'desc' } },
      imports: { orderBy: { startedAt: 'desc' }, take: 10 },
      schemas: { orderBy: { detectedAt: 'desc' }, take: 1 },
      mappings: { orderBy: { updatedAt: 'desc' }, take: 5 },
      _count: { select: { nodes: true, dependencies: true, versions: true } },
    },
  })
  if (!dataset) throw new DomainError('DATASET_NOT_FOUND', 'The requested dataset was not found.', 404)
  return { ...withoutStorageLocation(dataset), sizeBytes: dataset.sizeBytes?.toString() ?? null, files: dataset.files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString(), storagePath: undefined })), imports: dataset.imports.map((record) => ({ ...record, bytesRead: record.bytesRead.toString(), bytesTotal: record.bytesTotal?.toString() ?? null })) }
}

export async function GET(request: Request, context: Context) {
  const id = requestId()
  const { path } = await context.params
  try {
    const data = await observe({ requestId: id, route: request.url, operation: async () => {
      if (path[0] === 'health') return health()
      if (path[0] === 'dashboard') return dashboard()
      if (path[0] === 'datasets') {
        if (path[1]) return getDataset(path[1])
        const query = new URL(request.url).searchParams.get('q')?.trim()
        const where = query ? { OR: [{ name: { contains: query, mode: 'insensitive' as const } }, { description: { contains: query, mode: 'insensitive' as const } }, { provider: { contains: query, mode: 'insensitive' as const } }, { category: { contains: query, mode: 'insensitive' as const } }] } : {}
        const datasets = await prisma.dataset.findMany({ where, orderBy: [{ isProjectCopy: 'desc' }, { updatedAt: 'desc' }], take: 100, include: { _count: { select: { nodes: true, dependencies: true } } } })
        return datasets.map((dataset) => ({ ...withoutStorageLocation(dataset), sizeBytes: dataset.sizeBytes?.toString() ?? null }))
      }
      if (path[0] === 'network') {
        const datasetId = new URL(request.url).searchParams.get('datasetId') || (await getWorkspace()).activeDatasetId
        if (!datasetId) throw new DomainError('NO_ACTIVE_DATASET', 'Choose a dataset before viewing its network.', 409)
        const [nodes, dependencies] = await Promise.all([prisma.node.findMany({ where: { datasetId }, include: { observations: { orderBy: { observedAt: 'desc' }, take: 3 } } }), prisma.dependency.findMany({ where: { datasetId } })])
        return { nodes, dependencies }
      }
      if (path[0] === 'scenarios') {
        if (path[1]) return prisma.scenario.findUnique({
          where: { id: path[1] },
          include: {
            events: { include: { node: true } },
            predictions: { orderBy: { createdAt: 'desc' }, take: 5, include: { paths: { include: { node: true } } } },
            runs: { orderBy: { startedAt: 'desc' }, take: 8, include: { results: { include: { node: true }, orderBy: { probability: 'desc' } } } },
            interventions: { include: { candidates: true, applied: true }, orderBy: { createdAt: 'desc' } },
          },
        })
        const project = await getWorkspace()
        return prisma.scenario.findMany({ where: { projectId: project.id }, include: { events: true, predictions: { orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: { updatedAt: 'desc' } })
      }
      if (path[0] === 'diagnostics') return prisma.errorEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
      if (path[0] === 'anomalies') {
        const datasetId = new URL(request.url).searchParams.get('datasetId') || (await getWorkspace()).activeDatasetId
        if (!datasetId) throw new DomainError('NO_ACTIVE_DATASET', 'Choose a dataset before running temporal analysis.', 409)
        return analyzeDatasetObservations(datasetId)
      }
      if (path[0] === 'interventions' && path[1]) return prisma.intervention.findMany({ where: { scenarioId: path[1] }, include: { candidates: { include: { dependency: true } }, applied: true }, orderBy: { createdAt: 'desc' } })
      if (path[0] === 'ingestion-runs') return prisma.dataIngestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 100 })
      throw new DomainError('ROUTE_NOT_FOUND', 'The requested API route does not exist.', 404)
    } })
    return success(data, 200, id)
  } catch (error) {
    return failure(await recordError({ requestId: id, error, component: 'API', operation: `GET /${path.join('/')}` }), id)
  }
}

export async function POST(request: Request, context: Context) {
  const id = requestId()
  const { path } = await context.params
  try {
    const data = await observe({ requestId: id, route: request.url, operation: async () => {
      if (path[0] === 'datasets' && path[1] === 'snap' && path[2] === 'catalog') return importSnapCatalog()
      if (path[0] === 'datasets' && path[1] === 'upload') {
        const form = await request.formData()
        const upload = form.get('file')
        if (!(upload instanceof File)) throw new DomainError('FILE_REQUIRED', 'Choose a dataset file to upload.', 422)
        if (upload.size > 25 * 1024 * 1024) throw new DomainError('FILE_TOO_LARGE', 'The uploaded file exceeds the 25 MB limit.', 413, { sizeBytes: upload.size, limitBytes: 25 * 1024 * 1024 })
        const buffer = Buffer.from(await upload.arrayBuffer())
        const inspected = inspectDataset(buffer, upload.name)
        const mapping = inferMapping(inspected.headers)
        const compatibility = compatibilityFor(mapping, inspected.fields)
        const dataset = await prisma.dataset.create({ data: { name: upload.name, description: 'User-uploaded dataset', provider: 'User upload', category: 'User data', datasetType: 'Uploaded file', format: inspected.format, sizeBytes: BigInt(buffer.byteLength), isTemporal: Boolean(mapping.timestamp), isWeighted: Boolean(mapping.weight), isUserUpload: true, status: 'PROCESSING', storage: 'HYBRID', compatibility: compatibility.status, compatibilityDetails: compatibility, provenance: { source: 'USER_UPLOADED', originalFilename: upload.name } } })
        const importRun = await prisma.datasetImport.create({ data: { datasetId: dataset.id, status: 'PROCESSING', bytesRead: BigInt(buffer.byteLength), bytesTotal: BigInt(buffer.byteLength) } })
        await persistRawFile({ datasetId: dataset.id, filename: upload.name, buffer, mimeType: upload.type })
        try {
          return await normalizeDataset({ datasetId: dataset.id, buffer, filename: upload.name, importId: importRun.id })
        } catch (error) {
          if (error instanceof DomainError) error.details.datasetId = dataset.id
          throw error
        }
      }
      if (path[0] === 'datasets' && path[1] && path[2] === 'download') return downloadDataset(path[1])
      if (path[0] === 'datasets' && path[1] && path[2] === 'use') return activateDataset(path[1])
      if (path[0] === 'datasets' && path[1] && path[2] === 'copy') return createProjectCopy(path[1])
      if (path[0] === 'datasets' && path[1] && path[2] === 'mapping') {
        const body = await jsonBody(request)
        const dataset = await prisma.dataset.findUnique({ where: { id: path[1] }, include: { files: { orderBy: { createdAt: 'desc' }, take: 1 } } })
        if (!dataset) throw new DomainError('DATASET_NOT_FOUND', 'The requested dataset was not found.', 404)
        const mapping = body.mapping as Mapping
        if (!mapping?.source || !mapping?.target) throw new DomainError('MAPPING_INCOMPLETE', 'Both Source Node and Target Node must be mapped.', 422, { mapping }, ['Choose a source and target field, then save the mapping.'])
        const file = dataset.files[0]
        if (!file) throw new DomainError('RAW_FILE_UNAVAILABLE', 'The original raw file is not available for remapping.', 409, {}, ['Upload the dataset again, then save the mapping.'])
        const buffer = await readFile(file.storagePath)
        await prisma.datasetMapping.updateMany({ where: { datasetId: dataset.id }, data: { isActive: false } })
        return normalizeDataset({ datasetId: dataset.id, buffer, filename: file.originalName, mapping })
      }
      if (path[0] === 'scenarios') {
        const body = await jsonBody(request)
        return createScenario({ name: asString(body.name, 'name'), nodeId: asString(body.nodeId, 'nodeId'), severity: Number(body.severity), triggerType: body.triggerType, description: body.description, durationMinutes: body.durationMinutes ? Number(body.durationMinutes) : undefined, affectedParameter: body.affectedParameter })
      }
      if (path[0] === 'cascade' && path[1] === 'run') { const body = await jsonBody(request); return runCascade(prisma, asString(body.scenarioId, 'scenarioId'), { isBaseline: true }) }
      if (path[0] === 'interventions' && path[1] === 'calculate') { const body = await jsonBody(request); return calculateInterventions(asString(body.scenarioId, 'scenarioId')) }
      if (path[0] === 'interventions' && path[1] && path[2] === 'apply') return applyIntervention(path[1])
      if (path[0] === 'nodes') {
        const body = await jsonBody(request); const { dataset } = await activateDataset(asString(body.datasetId, 'datasetId'))
        return prisma.node.create({ data: { datasetId: dataset.id, name: asString(body.name, 'name'), code: asString(body.code, 'code'), type: body.type ?? 'OTHER', criticality: Number(body.criticality ?? 0.5), capacity: Number(body.capacity ?? 100), health: Number(body.health ?? 1), currentLoad: Number(body.currentLoad ?? 0), metadata: body.metadata } })
      }
      if (path[0] === 'dependencies') {
        const body = await jsonBody(request); const datasetId = asString(body.datasetId, 'datasetId')
        return prisma.dependency.create({ data: { datasetId, fromNodeId: asString(body.fromNodeId, 'fromNodeId'), toNodeId: asString(body.toNodeId, 'toNodeId'), relationship: asString(body.relationship, 'relationship'), strength: Number(body.strength ?? 0.7), propagationProbability: Number(body.propagationProbability ?? 0.7), propagationDelay: Number(body.propagationDelay ?? 5) } })
      }
      throw new DomainError('ROUTE_NOT_FOUND', 'The requested API route does not exist.', 404)
    } })
    return success(data, 201, id)
  } catch (error) {
    return failure(await recordError({ requestId: id, error, component: 'API', operation: `POST /${path.join('/')}` }), id)
  }
}

export async function PATCH(request: Request, context: Context) {
  const id = requestId(); const { path } = await context.params
  try {
    const body = await jsonBody(request)
    let data: unknown
    if (path[0] === 'nodes' && path[1]) data = await prisma.node.update({ where: { id: path[1] }, data: { name: body.name, criticality: body.criticality === undefined ? undefined : Number(body.criticality), capacity: body.capacity === undefined ? undefined : Number(body.capacity), health: body.health === undefined ? undefined : Number(body.health), currentLoad: body.currentLoad === undefined ? undefined : Number(body.currentLoad), status: body.status, metadata: body.metadata } })
    else if (path[0] === 'dependencies' && path[1]) data = await prisma.dependency.update({ where: { id: path[1] }, data: { relationship: body.relationship, strength: body.strength === undefined ? undefined : Number(body.strength), propagationProbability: body.propagationProbability === undefined ? undefined : Number(body.propagationProbability), propagationDelay: body.propagationDelay === undefined ? undefined : Number(body.propagationDelay) } })
    else throw new DomainError('ROUTE_NOT_FOUND', 'The requested API route does not exist.', 404)
    return success(data, 200, id)
  } catch (error) { return failure(await recordError({ requestId: id, error, component: 'API', operation: `PATCH /${path.join('/')}` }), id) }
}

export async function DELETE(request: Request, context: Context) {
  const id = requestId(); const { path } = await context.params
  try {
    let data: unknown
    if (path[0] === 'nodes' && path[1]) data = await prisma.node.delete({ where: { id: path[1] } })
    else if (path[0] === 'dependencies' && path[1]) data = await prisma.dependency.delete({ where: { id: path[1] } })
    else throw new DomainError('ROUTE_NOT_FOUND', 'The requested API route does not exist.', 404)
    return success(data, 200, id)
  } catch (error) { return failure(await recordError({ requestId: id, error, component: 'API', operation: `DELETE /${path.join('/')}` }), id) }
}
