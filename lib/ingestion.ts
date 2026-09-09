import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from '@/lib/prisma'
import { DomainError, safeTechnicalDetails } from '@/lib/errors'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_NORMALIZED_ROWS = 250_000
const NORMALIZATION_BATCH_SIZE = 1_000
const STORAGE_ROOT = path.join(process.cwd(), 'storage', 'datasets')

type RecordRow = Record<string, string | number | boolean | null>
export type FieldInfo = { name: string; inferredType: 'string' | 'number' | 'boolean' | 'datetime'; nullable: boolean; sample: string | null }
export type Mapping = { source?: string; target?: string; timestamp?: string; weight?: string; label?: string }
type Delimiter = ',' | '\t' | ';' | '|' | 'whitespace'

function batches<T>(items: T[], size = NORMALIZATION_BATCH_SIZE) {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size))
  return result
}

function safeFilename(filename: string) {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  if (!base || base === '.' || base === '..') throw new DomainError('INVALID_FILENAME', 'The uploaded filename is not valid.', 422)
  return base
}

function cleanValue(value: unknown) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' || /^null$/i.test(text) || /^na$/i.test(text) ? null : text
}

function splitDelimited(line: string, delimiter: Delimiter) {
  if (delimiter === 'whitespace') return line.trim().split(/\s+/)
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (char === delimiter && !quoted) { values.push(value.trim()); value = '' } else value += char
  }
  values.push(value.trim())
  return values
}

function delimiterFor(text: string, extension: string) {
  if (extension === 'tsv') return '\t'
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).slice(0, 15)
  const candidates: Array<Exclude<Delimiter, 'whitespace'>> = [',', '\t', ';', '|']
  const scored = candidates.map((candidate) => ({
    candidate,
    columns: lines.reduce((total, line) => total + Math.max(0, splitDelimited(line, candidate).length - 1), 0),
  })).sort((left, right) => right.columns - left.columns)
  if ((scored[0]?.columns ?? 0) > 0) return scored[0]!.candidate
  return lines.some((line) => /\S+\s+\S+/.test(line)) ? 'whitespace' : ','
}

function inferType(values: Array<string | null>): FieldInfo['inferredType'] {
  const present = values.filter((value): value is string => value !== null)
  if (!present.length) return 'string'
  if (present.every((value) => /^(true|false)$/i.test(value))) return 'boolean'
  if (present.every((value) => Number.isFinite(Number(value)))) return 'number'
  if (present.length >= 2 && present.every((value) => !Number.isNaN(Date.parse(value)))) return 'datetime'
  return 'string'
}

export function inspectDataset(buffer: Buffer, filename: string) {
  const safeName = safeFilename(filename)
  const lower = safeName.toLowerCase()
  let data = buffer
  const compressed = lower.endsWith('.gz')
  if (compressed) {
    try { data = gunzipSync(buffer) } catch { throw new DomainError('GZIP_INVALID', 'The GZIP file could not be decompressed.', 422, { filename: safeName }, ['Upload a valid .gz file or an uncompressed CSV/TSV/JSON file.']) }
  }
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new DomainError('FILE_TOO_LARGE', 'The extracted dataset exceeds the 25 MB processing limit.', 413, { bytes: data.byteLength, limitBytes: MAX_UPLOAD_BYTES }, ['Upload a smaller subset or use a server-side source import.'])
  if (lower.endsWith('.zip')) throw new DomainError('ZIP_REQUIRES_EXTRACTION', 'ZIP archives require extraction before import in this deployment.', 422, { filename: safeName }, ['Extract the archive locally and upload its CSV, TSV, JSON, JSONL, TXT, or GZIP member.'])

  const extension = lower.replace(/\.gz$/, '').split('.').pop() ?? 'txt'
  const text = data.toString('utf8').replace(/^\uFEFF/, '')
  let rows: RecordRow[] = []
  let headers: string[] = []
  let delimiter: Delimiter | undefined

  if (extension === 'json') {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new DomainError('JSON_INVALID', 'The JSON file could not be parsed.', 422, { filename: safeName }, ['Validate the JSON syntax and upload again.']) }
    const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])
    if (!list.length || !list.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) throw new DomainError('JSON_SHAPE_UNSUPPORTED', 'JSON must be an array of object records.', 422, { filename: safeName }, ['Convert the graph to an array of edge objects, such as [{"source":"A","target":"B"}].'])
    headers = [...new Set(list.flatMap((entry) => Object.keys(entry as Record<string, unknown>)))].slice(0, 100)
    rows = list.map((entry) => Object.fromEntries(headers.map((header) => [header, cleanValue((entry as Record<string, unknown>)[header])])))
  } else if (extension === 'jsonl') {
    rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        const parsed = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('record must be object')
        return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, cleanValue(value)]))
      } catch { throw new DomainError('JSONL_INVALID', `JSONL record ${index + 1} could not be parsed.`, 422, { line: index + 1 }, ['Ensure every line is a JSON object.']) }
    })
    headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 100)
  } else {
    delimiter = delimiterFor(text, extension)
    const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'))
    if (lines.length < 2) throw new DomainError('DATASET_EMPTY', 'At least a header and one record are required.', 422, { filename: safeName }, ['Upload a non-empty edge list or table.'])
    const first = splitDelimited(lines[0], delimiter)
    const hasHeader = first.some((value) => /[A-Za-z_]/.test(value))
    headers = hasHeader ? first.map((value, index) => value || `column_${index + 1}`) : first.map((_, index) => `column_${index + 1}`)
    const dataLines = hasHeader ? lines.slice(1) : lines
    rows = dataLines.map((line) => {
    const values = splitDelimited(line, delimiter!)
      return Object.fromEntries(headers.map((header, index) => [header, cleanValue(values[index])]))
    })
  }

  if (!rows.length) throw new DomainError('DATASET_EMPTY', 'No data records were found in the uploaded file.', 422, { filename: safeName })
  if (rows.length > MAX_NORMALIZED_ROWS) throw new DomainError('DATASET_TOO_LARGE', 'This file exceeds the synchronous import limit.', 413, { rows: rows.length, limit: MAX_NORMALIZED_ROWS }, ['Create a smaller subset, or configure a background object-storage ingestion worker.'])
  const fields: FieldInfo[] = headers.map((name) => {
    const values = rows.slice(0, 200).map((row) => cleanValue(row[name]))
    return { name, inferredType: inferType(values), nullable: values.some((value) => value === null), sample: values.find((value) => value !== null) ?? null }
  })
  return { rows, fields, headers, delimiter, format: compressed ? `${extension}.gz` : extension, bytes: data.byteLength }
}

export function inferMapping(headers: string[]): Mapping {
  const find = (candidates: string[]) => headers.find((header) => candidates.includes(header.toLowerCase().replace(/[\s_-]/g, '')))
  // SNAP and other graph collections frequently use a headerless two-column edge
  // list. inspectDataset names those fields predictably, so map them without
  // pretending that arbitrary named columns are a graph.
  const positional = (column: number) => headers.find((header) => header.toLowerCase() === `column_${column}`)
  return {
    source: find(['source', 'src', 'from', 'fromnode', 'sourceid', 'node1', 'u']) ?? positional(1),
    target: find(['target', 'dst', 'to', 'tonode', 'targetid', 'node2', 'v']) ?? positional(2),
    timestamp: find(['timestamp', 'time', 'date', 'datetime', 'createdat']),
    weight: find(['weight', 'strength', 'value', 'count']),
    label: find(['label', 'type', 'category', 'node_type']),
  }
}

export function compatibilityFor(mapping: Mapping, fields: FieldInfo[]) {
  const hasEdges = Boolean(mapping.source && mapping.target)
  const hasTemporal = Boolean(mapping.timestamp && fields.find((field) => field.name === mapping.timestamp)?.inferredType === 'datetime')
  const hasWeight = Boolean(mapping.weight && fields.find((field) => field.name === mapping.weight)?.inferredType === 'number')
  const missingFields = ['source', 'target'].filter((key) => !mapping[key as keyof Mapping])
  return {
    status: hasEdges ? 'READY' as const : fields.length ? 'READY_WITH_MAPPING' as const : 'NOT_COMPATIBLE' as const,
    compatible: hasEdges,
    warnings: hasEdges ? [] : ['No source/target relationship fields were detected.'],
    requiredMapping: missingFields,
    missingFields,
    supportedCapabilities: {
      graphSimulation: hasEdges,
      temporalSimulation: hasEdges && hasTemporal,
      anomalyDetection: hasTemporal,
      weightedSimulation: hasEdges && hasWeight,
      directedCascade: hasEdges,
      undirectedCascade: hasEdges,
      interventionModeling: hasEdges,
    },
  }
}

export async function persistRawFile(input: { datasetId: string; filename: string; buffer: Buffer; mimeType?: string }) {
  const filename = safeFilename(input.filename)
  const checksum = createHash('sha256').update(input.buffer).digest('hex')
  const storedName = `${randomUUID()}-${filename}`
  await mkdir(STORAGE_ROOT, { recursive: true })
  const storagePath = path.join(STORAGE_ROOT, storedName)
  await writeFile(storagePath, input.buffer, { flag: 'wx' })
  const file = await prisma.datasetFile.create({ data: { datasetId: input.datasetId, originalName: filename, storedName, mimeType: input.mimeType, sizeBytes: BigInt(input.buffer.byteLength), checksum, storagePath } })
  await prisma.dataset.update({ where: { id: input.datasetId }, data: { checksum, storageLocation: storagePath, sizeBytes: BigInt(input.buffer.byteLength), storage: 'HYBRID' } })
  return file
}

export async function normalizeDataset(input: { datasetId: string; buffer: Buffer; filename: string; importId?: string; mapping?: Mapping }) {
  const inspected = inspectDataset(input.buffer, input.filename)
  const mapping = { ...inferMapping(inspected.headers), ...input.mapping }
  const compatibility = compatibilityFor(mapping, inspected.fields)
  const ingestion = await prisma.dataIngestionRun.create({ data: { datasetId: input.datasetId, importId: input.importId, status: 'RUNNING', phase: 'SCHEMA_DETECTION', message: 'Detecting fields and relationship mapping.' } })
  await prisma.datasetSchema.create({ data: { datasetId: input.datasetId, importId: input.importId, fields: inspected.fields, delimiter: inspected.delimiter } })
  await prisma.datasetMapping.updateMany({ where: { datasetId: input.datasetId, isActive: true }, data: { isActive: false } })
  await prisma.datasetMapping.create({ data: { datasetId: input.datasetId, mapping, name: 'Automatic mapping', isActive: true } })
  if (!compatibility.compatible || !mapping.source || !mapping.target) {
    await prisma.dataIngestionRun.update({ where: { id: ingestion.id }, data: { status: 'FAILED', phase: 'MAPPING_REQUIRED', message: 'A source/target relationship mapping is required.', completedAt: new Date() } })
    await prisma.dataset.update({ where: { id: input.datasetId }, data: { status: 'AVAILABLE', compatibility: 'READY_WITH_MAPPING', compatibilityDetails: compatibility, isTemporal: Boolean(mapping.timestamp), isWeighted: Boolean(mapping.weight) } })
    throw new DomainError('DATASET_SCHEMA_INVALID', 'Required source/target relationship fields could not be identified.', 422, { fields: inspected.fields.map((field) => field.name), requiredMapping: compatibility.requiredMapping, rowsProcessed: inspected.rows.length }, ['Map one field as Source Node and one field as Target Node, then retry.'])
  }

  const invalid = inspected.rows.findIndex((row) => !cleanValue(row[mapping.source!]) || !cleanValue(row[mapping.target!]))
  if (invalid >= 0) {
    await prisma.dataIngestionRun.update({ where: { id: ingestion.id }, data: { status: 'FAILED', phase: 'VALIDATION', rowsProcessed: invalid, rowsRejected: 1, message: `Missing relationship value in record ${invalid + 1}.`, completedAt: new Date() } })
    await prisma.dataset.update({ where: { id: input.datasetId }, data: { status: 'FAILED' } })
    throw new DomainError('EDGE_RELATIONSHIP_INVALID', 'An edge relationship contains a missing source or target value.', 422, { record: invalid + 1, sourceField: mapping.source, targetField: mapping.target, rowsProcessed: invalid, invalidRows: 1 }, ['Remove the invalid record or map a different source/target field, then retry.'])
  }

  const sourceField = mapping.source
  const targetField = mapping.target
  const codes = new Set<string>()
  for (const row of inspected.rows) { codes.add(cleanValue(row[sourceField])!); codes.add(cleanValue(row[targetField])!) }
  const nodes = [...codes].map((code) => ({ datasetId: input.datasetId, code, name: code, type: 'OTHER' as const, metadata: { imported: true, source: input.filename } }))
  try {
    // Do not hold an interactive transaction open while sending tens of
    // thousands of edge rows to Neon. The ordered checkpoints leave the dataset
    // in PROCESSING/FAILED on interruption and make the next retry deterministic.
    await prisma.dependency.deleteMany({ where: { datasetId: input.datasetId } })
    await prisma.node.deleteMany({ where: { datasetId: input.datasetId } })
    await prisma.node.createMany({ data: nodes })
    const storedNodes = await prisma.node.findMany({ where: { datasetId: input.datasetId }, select: { id: true, code: true } })
    const ids = new Map(storedNodes.map((node) => [node.code, node.id]))
    const dependencies = inspected.rows.map((row) => {
      const rawWeight = mapping.weight ? Number(cleanValue(row[mapping.weight])) : NaN
      const strength = Number.isFinite(rawWeight) ? Math.max(0.01, Math.min(1, rawWeight > 1 ? rawWeight / 100 : rawWeight)) : 0.7
      return { datasetId: input.datasetId, fromNodeId: ids.get(cleanValue(row[sourceField])!)!, toNodeId: ids.get(cleanValue(row[targetField])!)!, strength, propagationProbability: strength, propagationDelay: 5, relationship: 'imported relationship', metadata: mapping.timestamp ? { timestamp: cleanValue(row[mapping.timestamp]) } : undefined }
    })
    let edgesInserted = 0
    for (const batch of batches(dependencies)) {
      const inserted = await prisma.dependency.createMany({ data: batch, skipDuplicates: true })
      edgesInserted += inserted.count
    }
    if (mapping.timestamp && mapping.weight) {
      const observations = inspected.rows.flatMap((row) => {
        const observedAt = cleanValue(row[mapping.timestamp!])
        const value = Number(cleanValue(row[mapping.weight!]))
        const nodeId = ids.get(cleanValue(row[sourceField])!)
        if (!observedAt || !nodeId || !Number.isFinite(value) || Number.isNaN(Date.parse(observedAt))) return []
        return [{ nodeId, metric: mapping.weight!, value, unit: 'source value', observedAt: new Date(observedAt), source: `Imported from ${input.filename}`, metadata: { sourceField: mapping.source, targetField: mapping.target, timestampField: mapping.timestamp, weightField: mapping.weight } }]
      })
      for (const batch of batches(observations)) await prisma.nodeObservation.createMany({ data: batch })
    }
    await prisma.dataset.update({ where: { id: input.datasetId }, data: { status: 'IMPORTED', storage: 'HYBRID', format: inspected.format, nodeCount: nodes.length, edgeCount: edgesInserted, isTemporal: Boolean(mapping.timestamp), isWeighted: Boolean(mapping.weight), compatibility: 'READY', compatibilityDetails: compatibility } })
    await prisma.dataIngestionRun.update({ where: { id: ingestion.id }, data: { status: 'COMPLETED', phase: 'NORMALIZED', rowsProcessed: inspected.rows.length, message: 'Graph relationships normalized into PostgreSQL.', completedAt: new Date() } })
    if (input.importId) await prisma.datasetImport.update({ where: { id: input.importId }, data: { status: 'IMPORTED', rowCount: inspected.rows.length, bytesRead: BigInt(input.buffer.byteLength), completedAt: new Date() } })
    return { fields: inspected.fields, mapping, compatibility, rows: inspected.rows.length, nodes: nodes.length, edges: edgesInserted }
  } catch (error) {
    const errorMessage = safeTechnicalDetails(error)
    await Promise.allSettled([
      prisma.dataIngestionRun.update({ where: { id: ingestion.id }, data: { status: 'FAILED', phase: 'NORMALIZATION', message: `Normalization failed: ${errorMessage}`, completedAt: new Date() } }),
      prisma.dataset.update({ where: { id: input.datasetId }, data: { status: 'FAILED' } }),
      ...(input.importId ? [prisma.datasetImport.update({ where: { id: input.importId }, data: { status: 'FAILED', errorMessage, completedAt: new Date() } })] : []),
    ])
    throw error
  }
}
