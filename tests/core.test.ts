import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@prisma/client'
import { inspectDataset, inferMapping, compatibilityFor } from '@/lib/ingestion'
import { parseSnapCatalog } from '@/lib/snap'
import { evaluateGraph } from '@/lib/cascade'
import { DomainError, safeDiagnosticDetails, safeTechnicalDetails, success, toErrorPayload } from '@/lib/errors'
import { detectRollingAnomalies } from '@/lib/anomaly'

test('dataset inspection detects a delimited graph schema and mapping', () => {
  const inspected = inspectDataset(Buffer.from('source,target,timestamp,weight\nA,B,2026-01-01T00:00:00Z,0.8\nB,C,2026-01-01T00:05:00Z,0.6\n'), 'edges.csv')
  const mapping = inferMapping(inspected.headers)
  const compatibility = compatibilityFor(mapping, inspected.fields)
  assert.equal(inspected.format, 'csv')
  assert.equal(mapping.source, 'source')
  assert.equal(mapping.target, 'target')
  assert.equal(compatibility.status, 'READY')
  assert.equal(compatibility.supportedCapabilities.graphSimulation, true)
})

test('dataset inspection preserves uncertainty when relationships cannot be inferred', () => {
  const inspected = inspectDataset(Buffer.from('station,region\nA,north\nB,south\n'), 'stations.csv')
  const compatibility = compatibilityFor(inferMapping(inspected.headers), inspected.fields)
  assert.equal(compatibility.status, 'READY_WITH_MAPPING')
  assert.deepEqual(compatibility.requiredMapping, ['source', 'target'])
})

test('dataset inspection recognizes a headerless whitespace edge list used by SNAP downloads', () => {
  const inspected = inspectDataset(Buffer.from('# Directed graph\n0 1\n1 2\n2 4\n'), 'email-Eu-core.txt')
  const mapping = inferMapping(inspected.headers)
  const compatibility = compatibilityFor(mapping, inspected.fields)
  assert.equal(inspected.delimiter, 'whitespace')
  assert.deepEqual(inspected.headers, ['column_1', 'column_2'])
  assert.equal(mapping.source, 'column_1')
  assert.equal(mapping.target, 'column_2')
  assert.equal(compatibility.status, 'READY')
})

test('dataset inspection rejects malformed JSONL with record context', () => {
  assert.throws(() => inspectDataset(Buffer.from('{"source":"A","target":"B"}\nnot-json\n'), 'edges.jsonl'), (error: unknown) => error instanceof DomainError && error.code === 'JSONL_INVALID' && error.details.line === 2)
})

test('SNAP parser extracts real table metadata and only accepts official data detail pages', () => {
  const catalog = parseSnapCatalog('<h3>Social networks</h3><table><tr><td><a href="ego-Facebook.html">ego-Facebook</a></td><td>Undirected</td><td>4,039</td><td>88,234</td><td>Social circles from Facebook (anonymized)</td></tr></table><a href="https://example.com/other.html">Not SNAP</a>')
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'ego-Facebook')
  assert.equal(catalog[0].category, 'Social networks')
  assert.equal(catalog[0].sourceUrl, 'https://snap.stanford.edu/data/ego-Facebook.html')
  assert.equal(catalog[0].nodeCount, 4039)
  assert.equal(catalog[0].edgeCount, 88234)
  assert.equal(catalog[0].description, 'Social circles from Facebook (anonymized)')
})

test('SNAP parser excludes the catalog index statistics link', () => {
  const catalog = parseSnapCatalog('<h3>Network statistics</h3><table><tr><th colspan="2"><a href="index.html#netStat">Dataset statistics</a></th></tr><tr><td><a href="ca-GrQc.html">ca-GrQc</a></td><td>Undirected</td><td>5,242</td><td>14,496</td></tr></table>')
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'ca-GrQc')
})

test('SNAP parser accepts an official detail row whose type cell is absent', () => {
  const catalog = parseSnapCatalog('<h3>Other networks</h3><table><tr><td><a href="wiki-meta.html">wiki-meta</a></td><td></td><td>2,300,000</td><td>250,000,000</td><td>Wikipedia edit history</td></tr></table>')
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'wiki-meta')
  assert.equal(catalog[0].isDirected, false)
})

test('Prisma constraint errors do not masquerade as a database outage', () => {
  const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.19.3', meta: { target: ['Node', 'code'] } })
  const normalized = toErrorPayload(error)
  assert.equal(normalized.status, 409)
  assert.equal(normalized.payload.code, 'UNIQUE_CONSTRAINT_CONFLICT')
})

test('Prisma transaction timeouts preserve their real category', () => {
  const error = new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: '6.19.3' })
  const normalized = toErrorPayload(error)
  assert.equal(normalized.status, 503)
  assert.equal(normalized.payload.code, 'TRANSACTION_TIMEOUT')
})

test('transparent cascade model changes its calculated result when a dependency is blocked', () => {
  const nodes = [
    { id: 'a', name: 'Source', code: 'A', criticality: 0.5, health: 0.3, capacity: 100, currentLoad: 95, failureThreshold: 0.8 },
    { id: 'b', name: 'Critical endpoint', code: 'B', criticality: 1, health: 0.35, capacity: 100, currentLoad: 90, failureThreshold: 0.8 },
  ]
  const edges = [{ id: 'edge', fromNodeId: 'a', toNodeId: 'b', strength: 0.98, propagationProbability: 0.95, propagationDelay: 5, relationship: 'power supply' }]
  const initial = evaluateGraph(nodes, edges, [{ nodeId: 'a', severity: 0.95, eventType: 'FAILURE' }])
  const blocked = evaluateGraph(nodes, edges, [{ nodeId: 'a', severity: 0.95, eventType: 'FAILURE' }], new Set(['edge']))
  assert.equal(initial.affected.has('b'), true)
  assert.equal(blocked.affected.has('b'), false)
  assert.ok(initial.riskScore > blocked.riskScore)
})

test('API error contract never returns a raw database connection string', () => {
  const normalized = toErrorPayload(new Error('P1001: postgresql://user:very-secret@host/db unreachable'))
  assert.equal(normalized.payload.code, 'DATABASE_UNAVAILABLE')
  assert.equal(normalized.technicalDetails.includes('very-secret'), false)
})

test('diagnostic sanitization redacts bearer, JSON, and nested secret values', () => {
  const technical = safeTechnicalDetails('authorization: Bearer bearer-secret token="json-secret" api_key=api-secret')
  const details = safeDiagnosticDetails({ token: 'nested-secret', nested: { database_url: 'postgresql://user:db-secret@host/db' } }) as Record<string, unknown>
  assert.equal(technical.includes('bearer-secret'), false)
  assert.equal(technical.includes('json-secret'), false)
  assert.equal(technical.includes('api-secret'), false)
  assert.equal(details.token, '***')
  assert.deepEqual(details.nested, { database_url: '***' })
})

test('API success responses serialize persisted BigInt metadata safely', async () => {
  const response = success({ sizeBytes: BigInt(79_754) }, 200, 'response-test')
  const body = await response.json() as { success: boolean; data: { sizeBytes: string }; requestId: string }
  assert.equal(body.success, true)
  assert.equal(body.data.sizeBytes, '79754')
  assert.equal(body.requestId, 'response-test')
})

test('temporal anomaly detection derives a critical signal from recorded values', () => {
  const started = new Date('2026-01-01T00:00:00Z').getTime()
  const signals = detectRollingAnomalies([10, 11, 10, 9, 10, 40].map((value, index) => ({ nodeId: 'node-a', nodeName: 'Node A', metric: 'edge_weight', value, observedAt: new Date(started + index * 60_000) })))
  assert.equal(signals.length, 1)
  assert.equal(signals[0].level, 'CRITICAL')
  assert.equal(signals[0].value, 40)
})

test('database connection check is available when explicitly enabled', { skip: process.env.RUN_DATABASE_TESTS !== 'true' }, async () => {
  const { prisma } = await import('@/lib/prisma')
  const value = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`
  assert.equal(value[0]?.ok, 1)
  await prisma.$disconnect()
})
