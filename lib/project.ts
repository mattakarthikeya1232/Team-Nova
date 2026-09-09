import { prisma } from '@/lib/prisma'
import { DomainError } from '@/lib/errors'

export async function getWorkspace() {
  const existing = await prisma.project.findFirst({ orderBy: { createdAt: 'asc' } })
  if (existing) return existing
  const owner = await prisma.user.upsert({
    where: { email: 'workspace@chainreaction.local' },
    update: {},
    create: { email: 'workspace@chainreaction.local', displayName: 'Chain Reaction Workspace' },
  })
  return prisma.project.create({ data: { ownerId: owner.id, name: 'Operations workspace', description: 'Persistent Chain Reaction workspace' } })
}

export async function getActiveWorkspace() {
  const project = await getWorkspace()
  if (!project.activeDatasetId) throw new DomainError('NO_ACTIVE_DATASET', 'No active dataset is connected to this project.', 409, {}, ['Open Dataset Library and choose “Use in project”.'])
  const dataset = await prisma.dataset.findUnique({ where: { id: project.activeDatasetId } })
  if (!dataset) throw new DomainError('ACTIVE_DATASET_MISSING', 'The active dataset no longer exists.', 409, { projectId: project.id }, ['Choose another dataset from Dataset Library.'])
  return { project, dataset }
}

export async function activateDataset(datasetId: string) {
  const [project, dataset] = await Promise.all([getWorkspace(), prisma.dataset.findUnique({ where: { id: datasetId } })])
  if (!dataset) throw new DomainError('DATASET_NOT_FOUND', 'The requested dataset was not found.', 404)
  if (dataset.compatibility === 'NOT_COMPATIBLE') {
    throw new DomainError('DATASET_NOT_COMPATIBLE', 'This dataset cannot run a cascade simulation until its relationship fields are mapped.', 409, { datasetId }, ['Open the dataset and map source and target relationship fields.'])
  }
  const updated = await prisma.project.update({ where: { id: project.id }, data: { activeDatasetId: dataset.id } })
  await prisma.auditLog.create({ data: { projectId: project.id, datasetId, action: 'DATASET_ACTIVATED', entityType: 'Dataset', entityId: datasetId } })
  // Raw storage locations are an implementation detail and can reveal server
  // filesystem layout. API callers only need the dataset metadata.
  const { storageLocation: _storageLocation, ...publicDataset } = dataset
  return { project: updated, dataset: publicDataset }
}

export async function createScenario(input: {
  name: string
  nodeId: string
  severity?: number
  triggerType?: 'FAILURE' | 'DEGRADATION' | 'OVERLOAD' | 'ANOMALY' | 'MAINTENANCE'
  description?: string
  durationMinutes?: number
  affectedParameter?: string
}) {
  const { project, dataset } = await getActiveWorkspace()
  if (dataset.compatibility !== 'READY') throw new DomainError('DATASET_MAPPING_REQUIRED', 'The active dataset requires a confirmed source/target mapping before simulation.', 409, { compatibility: dataset.compatibility }, ['Save a mapping that identifies source and target node fields.'])
  const node = await prisma.node.findFirst({ where: { id: input.nodeId, datasetId: dataset.id } })
  if (!node) throw new DomainError('TRIGGER_NODE_INVALID', 'Choose a trigger node from the active dataset.', 422, { nodeId: input.nodeId, datasetId: dataset.id })
  const severity = Math.max(0.05, Math.min(1, Number(input.severity ?? 0.8)))
  return prisma.scenario.create({
    data: {
      projectId: project.id,
      datasetId: dataset.id,
      name: input.name.trim() || `${node.name} disruption`,
      description: input.description,
      triggerNodeId: node.id,
      triggerSeverity: severity,
      triggerType: input.triggerType ?? 'FAILURE',
      durationMinutes: input.durationMinutes,
      affectedParameter: input.affectedParameter,
      events: { create: { nodeId: node.id, eventType: input.triggerType ?? 'FAILURE', severity } },
    },
    include: { events: true },
  })
}

export async function createProjectCopy(datasetId: string) {
  const project = await getWorkspace()
  const source = await prisma.dataset.findUnique({
    where: { id: datasetId },
    include: { nodes: true, dependencies: true, mappings: { where: { isActive: true } } },
  })
  if (!source) throw new DomainError('DATASET_NOT_FOUND', 'The requested dataset was not found.', 404)
  const copy = await prisma.$transaction(async (tx) => {
    const dataset = await tx.dataset.create({
      data: {
        projectId: project.id,
        parentDatasetId: source.id,
        name: `${source.name} — project copy`,
        description: source.description,
        provider: source.provider,
        sourceUrl: source.sourceUrl,
        documentationUrl: source.documentationUrl,
        license: source.license,
        category: source.category,
        datasetType: source.datasetType,
        format: source.format,
        nodeCount: source.nodeCount,
        edgeCount: source.edgeCount,
        isTemporal: source.isTemporal,
        isDirected: source.isDirected,
        isWeighted: source.isWeighted,
        status: source.status,
        storage: source.storage,
        compatibility: source.compatibility,
        compatibilityDetails: source.compatibilityDetails ?? undefined,
        provenance: { parentDatasetId: source.id, type: 'PROJECT_COPY' },
        isProjectCopy: true,
      },
    })
    if (source.nodes.length) {
      await tx.node.createMany({ data: source.nodes.map(({ id, datasetId, createdAt, updatedAt, ...node }) => ({ ...node, metadata: node.metadata === null ? undefined : node.metadata as never, datasetId: dataset.id })) })
      const newNodes = await tx.node.findMany({ where: { datasetId: dataset.id } })
      const byCode = new Map(newNodes.map((node) => [node.code, node.id]))
      const oldById = new Map(source.nodes.map((node) => [node.id, node.code]))
      if (source.dependencies.length) {
        await tx.dependency.createMany({
          data: source.dependencies.map(({ id, datasetId, createdAt, updatedAt, ...dependency }) => ({
            ...dependency,
            metadata: dependency.metadata === null ? undefined : dependency.metadata as never,
            datasetId: dataset.id,
            fromNodeId: byCode.get(oldById.get(dependency.fromNodeId) ?? '')!,
            toNodeId: byCode.get(oldById.get(dependency.toNodeId) ?? '')!,
          })),
        })
      }
    }
    if (source.mappings.length) await tx.datasetMapping.createMany({ data: source.mappings.map((mapping) => ({ datasetId: dataset.id, name: mapping.name, mapping: mapping.mapping as never, isActive: mapping.isActive })) })
    return dataset
  }, { maxWait: 10_000, timeout: 60_000 })
  return activateDataset(copy.id)
}
