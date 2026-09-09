import { randomUUID } from 'node:crypto'
import type { NodeStatus, PrismaClient } from '@prisma/client'
import { DomainError } from '@/lib/errors'

export const TRANSPARENT_GRAPH_MODEL = { name: 'TransparentGraphModel', version: '1.0.0', description: 'Explainable graph traversal using observed load, health, capacity, criticality, dependency strength, propagation probability, and delay.' }

type GraphNode = { id: string; name: string; code: string; criticality: number; health: number; capacity: number; currentLoad: number; failureThreshold: number }
type GraphDependency = { id: string; fromNodeId: string; toNodeId: string; strength: number; propagationProbability: number; propagationDelay: number; relationship: string }
type Trigger = { nodeId: string; severity: number; eventType: string }
type NodeState = { probability: number; hop: number; delay: number; previousNodeId?: string; reason: string }

export type Evaluation = {
  affected: Map<string, NodeState>
  riskScore: number
  cascadeProbability: number
  impactScore: number
  criticalEndpoints: number
  timeToImpact: number
  reasoning: string
}

function bounded(value: number) { return Math.max(0, Math.min(1, value)) }

export function evaluateGraph(nodes: GraphNode[], dependencies: GraphDependency[], triggers: Trigger[], blockedDependencyIds = new Set<string>()): Evaluation {
  if (!nodes.length) throw new DomainError('NETWORK_EMPTY', 'The selected dataset has no normalized network nodes.', 409, {}, ['Import a compatible edge-list dataset or create a network.'])
  if (!triggers.length) throw new DomainError('SCENARIO_TRIGGER_MISSING', 'A scenario needs at least one trigger event.', 422)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, GraphDependency[]>()
  for (const dependency of dependencies) {
    if (blockedDependencyIds.has(dependency.id)) continue
    outgoing.set(dependency.fromNodeId, [...(outgoing.get(dependency.fromNodeId) ?? []), dependency])
  }
  const affected = new Map<string, NodeState>()
  for (const trigger of triggers) {
    const node = byId.get(trigger.nodeId)
    if (!node) continue
    const loadPressure = node.capacity > 0 ? bounded(node.currentLoad / node.capacity) : 1
    const triggerProbability = bounded(trigger.severity * (0.72 + loadPressure * 0.18 + (1 - node.health) * 0.1))
    affected.set(node.id, { probability: triggerProbability, hop: 0, delay: 0, reason: `${trigger.eventType.toLowerCase()} trigger; severity ${Math.round(trigger.severity * 100)}%, health ${Math.round(node.health * 100)}%, load ${Math.round(loadPressure * 100)}%.` })
  }
  let frontier = [...affected.keys()]
  for (let hop = 0; hop < nodes.length && frontier.length; hop += 1) {
    const next = new Set<string>()
    for (const sourceId of frontier) {
      const source = affected.get(sourceId)!
      for (const dependency of outgoing.get(sourceId) ?? []) {
        const target = byId.get(dependency.toNodeId)
        if (!target) continue
        const capacityPressure = target.capacity > 0 ? bounded(target.currentLoad / target.capacity) : 1
        const vulnerability = bounded((1 - target.health) * 0.55 + capacityPressure * 0.3 + target.criticality * 0.15)
        const probability = bounded(source.probability * dependency.strength * dependency.propagationProbability * (0.5 + vulnerability))
        if (probability < 0.025) continue
        const current = affected.get(target.id)
        if (!current || probability > current.probability) {
          affected.set(target.id, {
            probability,
            hop: source.hop + 1,
            delay: source.delay + dependency.propagationDelay,
            previousNodeId: sourceId,
            reason: `${dependency.relationship}: ${Math.round(dependency.strength * 100)}% strength × ${Math.round(dependency.propagationProbability * 100)}% propagation × ${Math.round((0.5 + vulnerability) * 100)}% target exposure.`,
          })
          next.add(target.id)
        }
      }
    }
    frontier = [...next]
  }
  const possibleImpact = nodes.reduce((total, node) => total + Math.max(node.criticality, 0.05), 0)
  const weightedImpact = [...affected.entries()].reduce((total, [nodeId, state]) => total + state.probability * (byId.get(nodeId)?.criticality ?? 0), 0)
  const riskScore = Math.round((weightedImpact / Math.max(possibleImpact, 0.01)) * 10000) / 100
  const critical = [...affected.entries()].filter(([nodeId, state]) => (byId.get(nodeId)?.criticality ?? 0) >= 0.8 && state.probability >= 0.1)
  const cascadeProbability = critical.length ? Math.max(...critical.map(([, state]) => state.probability)) : Math.max(...[...affected.values()].map((state) => state.probability), 0)
  const timeToImpact = critical.length ? Math.min(...critical.map(([, state]) => state.delay)) : 0
  return {
    affected,
    riskScore,
    cascadeProbability,
    impactScore: Math.round(weightedImpact * 10000) / 100,
    criticalEndpoints: critical.length,
    timeToImpact,
    reasoning: `${TRANSPARENT_GRAPH_MODEL.name} evaluated ${dependencies.length - blockedDependencyIds.size} active dependencies. Risk is a criticality-weighted aggregation of propagation probability; each path uses the recorded dependency strength, propagation probability, target health, and capacity pressure.`,
  }
}

export async function evaluateScenario(prisma: PrismaClient, scenarioId: string, blockedDependencyIds: string[] = []) {
  const scenario = await prisma.scenario.findUnique({ where: { id: scenarioId }, include: { events: true } })
  if (!scenario) throw new DomainError('SCENARIO_NOT_FOUND', 'The requested scenario was not found.', 404)
  const [nodes, dependencies] = await Promise.all([
    prisma.node.findMany({ where: { datasetId: scenario.datasetId } }),
    prisma.dependency.findMany({ where: { datasetId: scenario.datasetId } }),
  ])
  return { scenario, nodes, dependencies, evaluation: evaluateGraph(nodes, dependencies, scenario.events, new Set(blockedDependencyIds)) }
}

export async function runCascade(prisma: PrismaClient, scenarioId: string, options: { isBaseline?: boolean; blockedDependencyIds?: string[] } = {}) {
  const { scenario, nodes, dependencies, evaluation } = await evaluateScenario(prisma, scenarioId, options.blockedDependencyIds)
  const model = await prisma.modelVersion.upsert({ where: { name_version: { name: TRANSPARENT_GRAPH_MODEL.name, version: TRANSPARENT_GRAPH_MODEL.version } }, update: { description: TRANSPARENT_GRAPH_MODEL.description }, create: TRANSPARENT_GRAPH_MODEL })
  const runId = randomUUID()
  const predictionId = randomUUID()
  const completedAt = new Date()
  const results = nodes.map((node) => {
    const state = evaluation.affected.get(node.id)
    return {
      id: randomUUID(),
      runId,
      nodeId: node.id,
      affected: Boolean(state),
      state: (state ? (state.probability >= node.failureThreshold ? 'FAILED' : 'DEGRADED') : 'OPERATIONAL') as NodeStatus,
      impactScore: state ? state.probability * node.criticality * 100 : 0,
      probability: state?.probability ?? 0,
      critical: node.criticality >= 0.8,
      reason: state?.reason ?? 'No qualifying incoming propagation path.',
      timeOffset: state?.delay ?? 0,
      sourceData: { health: node.health, currentLoad: node.currentLoad, capacity: node.capacity, criticality: node.criticality },
    }
  })
  const paths = [...evaluation.affected.entries()].map(([nodeId, state]) => ({
    id: randomUUID(),
    predictionId,
    nodeId,
    previousNodeId: state.previousNodeId,
    hop: state.hop,
    delayMinutes: state.delay,
    probability: state.probability,
    reason: state.reason,
  }))

  // Prisma's default five-second interactive transaction expires on a
  // high-latency Neon connection while this run writes hundreds of result/path
  // records. Explicit IDs let the dependent writes stay in one database batch
  // transaction without keeping a client-side transaction lease open.
  await prisma.$transaction([
    prisma.simulationRun.create({
      data: {
        id: runId,
        scenarioId,
        status: 'RUNNING',
        isBaseline: options.isBaseline ?? false,
        modelName: `${model.name} ${model.version}`,
        inputSnapshot: { datasetId: scenario.datasetId, blockedDependencyIds: options.blockedDependencyIds ?? [], dependencyCount: dependencies.length },
      },
    }),
    prisma.simulationResult.createMany({ data: results }),
    prisma.cascadePrediction.create({
      data: {
        id: predictionId,
        scenarioId,
        modelVersionId: model.id,
        probability: evaluation.cascadeProbability,
        impactScore: evaluation.impactScore,
        riskScore: evaluation.riskScore,
        confidence: Math.min(0.95, 0.55 + Math.min(0.35, dependencies.length / 1000)),
        criticalEndpoints: evaluation.criticalEndpoints,
        timeToImpact: evaluation.timeToImpact,
        reasoning: evaluation.reasoning,
      },
    }),
    ...(paths.length ? [prisma.cascadePath.createMany({ data: paths })] : []),
    prisma.simulationRun.update({ where: { id: runId }, data: { status: 'COMPLETED', completedAt } }),
    prisma.scenario.update({ where: { id: scenarioId }, data: { status: 'COMPLETED' } }),
  ])
  const [run, prediction] = await Promise.all([
    prisma.simulationRun.findUniqueOrThrow({ where: { id: runId }, include: { results: { include: { node: true }, orderBy: { probability: 'desc' } } } }),
    prisma.cascadePrediction.findUniqueOrThrow({ where: { id: predictionId }, include: { paths: { include: { node: true }, orderBy: [{ hop: 'asc' }, { delayMinutes: 'asc' }] } } }),
  ])
  return { run, prediction }
}
