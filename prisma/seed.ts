import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const nodeDefinitions = [
  { name: 'North Grid Power', code: 'POWER-01', type: 'POWER' as const, criticality: 0.98, health: 0.45, currentLoad: 94 },
  { name: 'Pump P1', code: 'WATER-01', type: 'WATER' as const, criticality: 0.82, health: 0.68, currentLoad: 81 },
  { name: 'Metro Water Plant', code: 'WATER-02', type: 'WATER' as const, criticality: 0.9, health: 0.61, currentLoad: 78 },
  { name: 'St. Mary Hospital', code: 'HEALTH-01', type: 'HEALTHCARE' as const, criticality: 1, health: 0.9, currentLoad: 63 },
  { name: 'Critical Care', code: 'HEALTH-02', type: 'HEALTHCARE' as const, criticality: 1, health: 0.94, currentLoad: 77 },
  { name: 'Civic Telecom', code: 'TEL-01', type: 'TELECOM' as const, criticality: 0.72, health: 0.73, currentLoad: 71 },
  { name: 'Emergency Response', code: 'EM-01', type: 'EMERGENCY' as const, criticality: 0.95, health: 0.91, currentLoad: 35 },
]

async function main() {
  const owner = await prisma.user.upsert({ where: { email: 'workspace@chainreaction.local' }, update: { displayName: 'Chain Reaction Workspace' }, create: { email: 'workspace@chainreaction.local', displayName: 'Chain Reaction Workspace' } })
  const project = (await prisma.project.findFirst({ orderBy: { createdAt: 'asc' } })) ?? await prisma.project.create({ data: { ownerId: owner.id, name: 'Operations workspace', description: 'Persistent Chain Reaction workspace' } })
  let dataset = await prisma.dataset.findFirst({ where: { projectId: project.id, provider: 'Chain Reaction synthetic fixture' } })
  if (!dataset) {
    dataset = await prisma.dataset.create({
      data: {
        projectId: project.id,
        name: 'Synthetic municipal resilience fixture',
        description: 'Controlled synthetic demonstration network. It is not live infrastructure data.',
        provider: 'Chain Reaction synthetic fixture',
        category: 'Synthetic',
        datasetType: 'Directed network',
        format: 'seed',
        nodeCount: nodeDefinitions.length,
        edgeCount: 8,
        status: 'IMPORTED',
        storage: 'POSTGRESQL',
        compatibility: 'READY',
        provenance: { label: 'SYNTHETIC', purpose: 'controlled demo fixture' },
      },
    })
  }
  const ids = new Map<string, string>()
  for (const definition of nodeDefinitions) {
    const node = await prisma.node.upsert({
      where: { datasetId_code: { datasetId: dataset.id, code: definition.code } },
      update: { name: definition.name, type: definition.type, criticality: definition.criticality, health: definition.health, currentLoad: definition.currentLoad, capacity: 100, metadata: { label: 'SYNTHETIC', source: 'seed fixture' } },
      create: { datasetId: dataset.id, ...definition, capacity: 100, metadata: { label: 'SYNTHETIC', source: 'seed fixture' } },
    })
    ids.set(definition.code, node.id)
    if (!await prisma.nodeObservation.count({ where: { nodeId: node.id } })) await prisma.nodeObservation.create({ data: { nodeId: node.id, metric: 'availability', value: definition.health * 100, unit: '%', source: 'SYNTHETIC / controlled fixture' } })
  }
  const dependencyDefinitions = [
    ['POWER-01', 'WATER-01', 'backup power supply', 0.96, 0.91, 5],
    ['POWER-01', 'TEL-01', 'telecommunications power', 0.72, 0.7, 8],
    ['WATER-01', 'WATER-02', 'pump feed', 0.94, 0.89, 7],
    ['WATER-02', 'HEALTH-01', 'water service', 0.91, 0.86, 12],
    ['WATER-02', 'HEALTH-02', 'critical water service', 0.96, 0.9, 21],
    ['HEALTH-01', 'HEALTH-02', 'clinical dependency', 0.7, 0.62, 6],
    ['TEL-01', 'EM-01', 'emergency dispatch link', 0.56, 0.58, 11],
    ['POWER-01', 'EM-01', 'emergency response power', 0.64, 0.65, 10],
  ] as const
  for (const [from, to, relationship, strength, propagationProbability, propagationDelay] of dependencyDefinitions) {
    await prisma.dependency.upsert({
      where: { datasetId_fromNodeId_toNodeId: { datasetId: dataset.id, fromNodeId: ids.get(from)!, toNodeId: ids.get(to)! } },
      update: { relationship, strength, propagationProbability, propagationDelay },
      create: { datasetId: dataset.id, fromNodeId: ids.get(from)!, toNodeId: ids.get(to)!, relationship, strength, propagationProbability, propagationDelay },
    })
  }
  if (!project.activeDatasetId) await prisma.project.update({ where: { id: project.id }, data: { activeDatasetId: dataset.id } })
  const existingScenario = await prisma.scenario.findFirst({ where: { projectId: project.id, datasetId: dataset.id, name: 'Synthetic grid disruption' } })
  if (!existingScenario) {
    await prisma.scenario.create({ data: { projectId: project.id, datasetId: dataset.id, name: 'Synthetic grid disruption', description: 'Controlled synthetic scenario; not a live alert.', triggerNodeId: ids.get('POWER-01'), triggerSeverity: 0.92, triggerType: 'FAILURE', events: { create: { nodeId: ids.get('POWER-01')!, eventType: 'FAILURE', severity: 0.92 } } } })
  }
  await prisma.modelVersion.upsert({ where: { name_version: { name: 'TransparentGraphModel', version: '1.0.0' } }, update: {}, create: { name: 'TransparentGraphModel', version: '1.0.0', description: 'Explainable graph-based cascade model' } })
  console.info('Seed complete: controlled synthetic fixture is explicitly labelled and persisted.')
}

main().finally(() => prisma.$disconnect())
