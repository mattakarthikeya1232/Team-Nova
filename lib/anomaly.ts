import { prisma } from '@/lib/prisma'
import { DomainError } from '@/lib/errors'

export type AnomalyLevel = 'NORMAL' | 'WARNING' | 'CRITICAL'
export type AnomalySignal = { nodeId: string; nodeName: string; metric: string; level: AnomalyLevel; observedAt: Date; value: number; rollingMean: number; rollingStdDev: number; zScore: number; rateOfChange: number; reason: string }

function average(values: number[]) { return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1) }
function standardDeviation(values: number[], mean: number) { return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(values.length, 1)) }

/** Analyses only recorded timestamped observations; it never manufactures a temporal signal. */
export function detectRollingAnomalies(input: Array<{ nodeId: string; nodeName: string; metric: string; value: number; observedAt: Date }>, windowSize = 5): AnomalySignal[] {
  const streams = new Map<string, typeof input>()
  for (const observation of input) {
    const key = `${observation.nodeId}:${observation.metric}`
    streams.set(key, [...(streams.get(key) ?? []), observation])
  }
  const signals: AnomalySignal[] = []
  for (const observations of streams.values()) {
    const ordered = [...observations].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
    for (let index = windowSize; index < ordered.length; index += 1) {
      const current = ordered[index]
      const baseline = ordered.slice(index - windowSize, index).map((observation) => observation.value)
      const mean = average(baseline)
      const stdDev = standardDeviation(baseline, mean)
      const zScore = stdDev > 0 ? Math.abs((current.value - mean) / stdDev) : (current.value === mean ? 0 : Infinity)
      const rateOfChange = baseline.at(-1) === 0 ? 0 : (current.value - baseline.at(-1)!) / Math.abs(baseline.at(-1)!)
      const level: AnomalyLevel = zScore >= 3 || Math.abs(rateOfChange) >= 1 ? 'CRITICAL' : zScore >= 2 || Math.abs(rateOfChange) >= 0.5 ? 'WARNING' : 'NORMAL'
      if (level === 'NORMAL') continue
      signals.push({ nodeId: current.nodeId, nodeName: current.nodeName, metric: current.metric, level, observedAt: current.observedAt, value: current.value, rollingMean: mean, rollingStdDev: stdDev, zScore, rateOfChange, reason: `Observed value ${current.value} is ${Number.isFinite(zScore) ? zScore.toFixed(2) : '∞'} standard deviations from a ${windowSize}-record rolling mean of ${mean.toFixed(3)}; rate of change is ${(rateOfChange * 100).toFixed(1)}%.` })
    }
  }
  return signals.sort((a, b) => (b.level === 'CRITICAL' ? 2 : 1) - (a.level === 'CRITICAL' ? 2 : 1) || b.observedAt.getTime() - a.observedAt.getTime())
}

export async function analyzeDatasetObservations(datasetId: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } })
  if (!dataset) throw new DomainError('DATASET_NOT_FOUND', 'The requested dataset was not found.', 404)
  if (!dataset.isTemporal) return { status: 'UNAVAILABLE' as const, message: 'Temporal anomaly detection unavailable for this dataset.', reason: 'The active schema has no mapped timestamp field.', signals: [] as AnomalySignal[] }
  const observations = await prisma.nodeObservation.findMany({
    where: { node: { datasetId } },
    select: { nodeId: true, metric: true, value: true, observedAt: true, node: { select: { name: true } } },
    orderBy: { observedAt: 'asc' },
    take: 100_000,
  })
  if (!observations.length) return { status: 'UNAVAILABLE' as const, message: 'Temporal anomaly detection unavailable for this dataset.', reason: 'The dataset has timestamp metadata but no normalized numeric observations.', signals: [] as AnomalySignal[] }
  const signals = detectRollingAnomalies(observations.map((observation) => ({ nodeId: observation.nodeId, nodeName: observation.node.name, metric: observation.metric, value: observation.value, observedAt: observation.observedAt })))
  return { status: 'AVAILABLE' as const, message: signals.length ? 'Temporal signals analysed from recorded observations.' : 'No warning or critical temporal anomalies were detected from recorded observations.', observations: observations.length, signals }
}
