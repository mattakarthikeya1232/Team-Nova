import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { DomainError } from '@/lib/errors'
import { evaluateGraph, evaluateScenario, runCascade } from '@/lib/cascade'

export async function calculateInterventions(scenarioId: string) {
  const baseline = await evaluateScenario(prisma, scenarioId)
  if (!baseline.dependencies.length) throw new DomainError('INTERVENTION_UNAVAILABLE', 'There are no dependencies available to intervene on.', 409)
  const candidateDependencies = [...baseline.dependencies]
    .sort((a, b) => (b.strength * b.propagationProbability) - (a.strength * a.propagationProbability))
    .slice(0, 24)
  const proposed = candidateDependencies.map((dependency) => {
    // Every candidate is evaluated against the same snapshot fetched above.
    // Re-querying a 25k-edge graph for each candidate made this operation take
    // minutes on Neon without changing its result.
    const after = evaluateGraph(baseline.nodes, baseline.dependencies, baseline.scenario.events, new Set([dependency.id]))
    const riskReduction = Math.max(0, baseline.evaluation.riskScore - after.riskScore)
    const criticalityProtected = Math.max(0, baseline.evaluation.criticalEndpoints - after.criticalEndpoints)
    const coverage = baseline.evaluation.affected.size ? Math.max(0, baseline.evaluation.affected.size - after.affected.size) / baseline.evaluation.affected.size : 0
    const cost = Math.round((1 - dependency.strength) * 40 + dependency.propagationDelay * 2 + 25)
    const feasibility = Math.max(0.35, Math.min(0.95, 1 - dependency.strength * 0.35))
    const score = Math.round((riskReduction * 0.5 + criticalityProtected * 22 + coverage * 18 + feasibility * 15 - cost * 0.08) * 100) / 100
    const id = randomUUID()
    return {
      intervention: {
        id,
        scenarioId,
        name: `Isolate ${dependency.relationship}`,
        description: `Temporarily isolate the dependency from ${dependency.fromNodeId} to ${dependency.toNodeId}; this candidate is scored from a re-evaluation of the exact same scenario graph.`,
        cost,
        timeToEffect: dependency.propagationDelay,
        feasibility,
        expectedReduction: riskReduction,
      },
      candidate: {
        id: randomUUID(),
        interventionId: id,
        dependencyId: dependency.id,
        score,
        riskReduction,
        criticalityProtected,
        coverage,
        rationale: `Blocking this link changes risk from ${baseline.evaluation.riskScore.toFixed(2)} to ${after.riskScore.toFixed(2)}.`,
      },
    }
  })
  await prisma.$transaction([
    prisma.intervention.deleteMany({ where: { scenarioId, status: 'PROPOSED' } }),
    ...(proposed.length ? [
      prisma.intervention.createMany({ data: proposed.map(({ intervention }) => intervention) }),
      prisma.interventionCandidate.createMany({ data: proposed.map(({ candidate }) => candidate) }),
    ] : []),
  ])
  return proposed
    .map(({ intervention, candidate }) => ({ ...intervention, status: 'PROPOSED' as const, candidates: [candidate] }))
    .sort((left, right) => (right.candidates[0]?.score ?? 0) - (left.candidates[0]?.score ?? 0))
}

export async function applyIntervention(interventionId: string) {
  const intervention = await prisma.intervention.findUnique({ where: { id: interventionId }, include: { candidates: true } })
  if (!intervention) throw new DomainError('INTERVENTION_NOT_FOUND', 'The selected intervention was not found.', 404)
  if (intervention.status === 'APPLIED') throw new DomainError('INTERVENTION_ALREADY_APPLIED', 'This intervention has already been applied to the scenario.', 409)
  const dependencyId = intervention.candidates[0]?.dependencyId
  if (!dependencyId) throw new DomainError('INTERVENTION_TARGET_MISSING', 'The intervention has no dependency target to apply.', 422)
  const baseline = await prisma.simulationRun.findFirst({ where: { scenarioId: intervention.scenarioId, isBaseline: true, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } })
  const after = await runCascade(prisma, intervention.scenarioId, { isBaseline: false, blockedDependencyIds: [dependencyId] })
  const baselineRisk = baseline ? (await prisma.cascadePrediction.findFirst({ where: { scenarioId: intervention.scenarioId }, orderBy: { createdAt: 'asc' } }))?.riskScore ?? 0 : 0
  const afterRisk = after.prediction.riskScore
  const applied = await prisma.appliedIntervention.create({ data: { interventionId, baselineRunId: baseline?.id, afterRunId: after.run.id, riskReduction: Math.max(0, baselineRisk - afterRisk) } })
  await prisma.intervention.update({ where: { id: interventionId }, data: { status: 'APPLIED' } })
  return { applied, after, baselineRisk, afterRisk }
}
