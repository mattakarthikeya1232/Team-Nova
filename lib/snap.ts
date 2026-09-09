import { Prisma } from '@prisma/client'
import { DomainError } from '@/lib/errors'
import { prisma } from '@/lib/prisma'

const SNAP_CATALOG_URL = 'https://snap.stanford.edu/data/'

export type SnapCatalogEntry = {
  name: string
  sourceUrl: string
  category?: string
  description?: string
  datasetType?: string
  nodeCount?: number
  edgeCount?: number
  isDirected: boolean
  isWeighted: boolean
  isTemporal: boolean
  rawNodes?: string
  rawEdges?: string
}

type CatalogDatasetData = {
  name: string
  description?: string
  provider: string
  sourceUrl: string
  documentationUrl: string
  category?: string
  datasetType?: string
  nodeCount: number
  edgeCount: number
  isTemporal: boolean
  isDirected: boolean
  isWeighted: boolean
  isCatalog: boolean
  provenance: Prisma.InputJsonValue
}

type CatalogImportResult = {
  imported: number
  created: number
  updated: number
  unchanged: number
  catalog: string
}

let catalogImportInFlight: Promise<CatalogImportResult> | undefined

function decodeHtml(value: string) {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function absoluteUrl(href: string, base = SNAP_CATALOG_URL) {
  try { return new URL(href, base).toString() } catch { return undefined }
}

function isSnapDatasetDetailUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl)
    return url.hostname === 'snap.stanford.edu'
      && /^\/data\/[^/?#]+\.html$/i.test(url.pathname)
      // The catalog's "Dataset statistics" link points to its own index page;
      // it is not a dataset detail page or a downloadable dataset.
      && !/\/index\.html$/i.test(url.pathname)
  } catch {
    return false
  }
}

function exactCount(value?: string) {
  if (!value || !/^\s*\d{1,3}(?:,\d{3})*\s*$/.test(value)) return undefined
  return Number(value.replaceAll(',', '').trim())
}

function entryFromRow(row: string, category?: string): SnapCatalogEntry | undefined {
  const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => ({ html: match[1], text: decodeHtml(match[1]) }))
  const link = cells[0]?.html.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]
  const sourceUrl = link ? absoluteUrl(link) : undefined
  const name = cells[0]?.text
  if (!sourceUrl || !name || !isSnapDatasetDetailUrl(sourceUrl)) return undefined
  const datasetType = cells[1]?.text
  const rawNodes = cells[2]?.text
  const rawEdges = cells[3]?.text
  const type = (datasetType ?? '').toLowerCase()
  return {
    name,
    sourceUrl: sourceUrl.replace(/[?#].*$/, ''),
    category,
    datasetType,
    nodeCount: exactCount(rawNodes),
    edgeCount: exactCount(rawEdges),
    rawNodes,
    rawEdges,
    description: cells.at(-1)?.text,
    isDirected: type.includes('directed') && !type.includes('undirected'),
    isWeighted: type.includes('weighted'),
    isTemporal: type.includes('temporal'),
  }
}

/** Parses only table values present in the official SNAP collection page. */
export function parseSnapCatalog(html: string) {
  const entries = new Map<string, SnapCatalogEntry>()
  let category: string | undefined
  const tokens = html.match(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>|<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []
  for (const token of tokens) {
    if (/^<h/i.test(token)) { category = decodeHtml(token); continue }
    const entry = entryFromRow(token, category)
    if (entry) entries.set(entry.sourceUrl, entry)
  }

  // Supports sparse official-style catalog fragments and retains only official SNAP detail URLs.
  if (!entries.size) {
    for (const match of html.matchAll(/<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const sourceUrl = absoluteUrl(match[1])
      const name = decodeHtml(match[2])
      if (!sourceUrl || !name || !isSnapDatasetDetailUrl(sourceUrl)) continue
      entries.set(sourceUrl, { name, sourceUrl: sourceUrl.replace(/[?#].*$/, ''), category, isDirected: false, isWeighted: false, isTemporal: false })
    }
  }
  return [...entries.values()]
}

function catalogDatasetData(entry: SnapCatalogEntry): CatalogDatasetData {
  return {
    name: entry.name,
    description: entry.description,
    provider: 'Stanford SNAP',
    sourceUrl: entry.sourceUrl,
    documentationUrl: entry.sourceUrl,
    category: entry.category,
    datasetType: entry.datasetType,
    nodeCount: entry.nodeCount ?? 0,
    edgeCount: entry.edgeCount ?? 0,
    isTemporal: entry.isTemporal,
    isDirected: entry.isDirected,
    isWeighted: entry.isWeighted,
    isCatalog: true,
    provenance: {
      catalog: SNAP_CATALOG_URL,
      importedFrom: entry.sourceUrl,
      source: 'Stanford Large Network Dataset Collection',
      ...(entry.rawNodes === undefined ? {} : { rawNodes: entry.rawNodes }),
      ...(entry.rawEdges === undefined ? {} : { rawEdges: entry.rawEdges }),
    },
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hasSameCatalogMetadata(existing: {
  name: string
  description: string | null
  documentationUrl: string | null
  category: string | null
  datasetType: string | null
  nodeCount: number
  edgeCount: number
  isTemporal: boolean
  isDirected: boolean
  isWeighted: boolean
  isCatalog: boolean
  provenance: unknown
}, data: CatalogDatasetData) {
  return existing.name === data.name
    && existing.description === (data.description ?? null)
    && existing.documentationUrl === data.documentationUrl
    && existing.category === (data.category ?? null)
    && existing.datasetType === (data.datasetType ?? null)
    && existing.nodeCount === data.nodeCount
    && existing.edgeCount === data.edgeCount
    && existing.isTemporal === data.isTemporal
    && existing.isDirected === data.isDirected
    && existing.isWeighted === data.isWeighted
    && existing.isCatalog === data.isCatalog
    && canonicalJson(existing.provenance) === canonicalJson(data.provenance)
}

async function importSnapCatalogOnce(): Promise<CatalogImportResult> {
  let response: Response
  try { response = await fetch(SNAP_CATALOG_URL, { cache: 'no-store', headers: { 'User-Agent': 'ChainReactionDatasetCatalog/1.0' } }) } catch {
    throw new DomainError('SNAP_CATALOG_UNAVAILABLE', 'Stanford SNAP could not be reached.', 503, { catalog: SNAP_CATALOG_URL }, ['Check network connectivity and retry.'])
  }
  if (!response.ok) throw new DomainError('SNAP_CATALOG_UNAVAILABLE', 'Stanford SNAP returned an unavailable response.', 503, { status: response.status, catalog: SNAP_CATALOG_URL }, ['Retry later or verify the SNAP service.'])
  const entries = parseSnapCatalog(await response.text())
  if (!entries.length) throw new DomainError('SNAP_CATALOG_PARSE_FAILED', 'The official SNAP catalog response did not contain recognizable dataset entries.', 502, { catalog: SNAP_CATALOG_URL }, ['Inspect the catalog format and retry the import.'])
  const sourceUrls = entries.map((entry) => entry.sourceUrl)
  const existing = await prisma.dataset.findMany({
    where: { provider: 'Stanford SNAP', sourceUrl: { in: sourceUrls } },
    select: {
      id: true, sourceUrl: true, name: true, description: true, documentationUrl: true,
      category: true, datasetType: true, nodeCount: true, edgeCount: true,
      isTemporal: true, isDirected: true, isWeighted: true, isCatalog: true, provenance: true,
    },
  })
  const bySourceUrl = new Map(existing.flatMap((dataset) => dataset.sourceUrl ? [[dataset.sourceUrl, dataset] as const] : []))
  const creates: Array<CatalogDatasetData & { status: 'AVAILABLE'; storage: 'FILE_STORAGE'; compatibility: 'READY_WITH_MAPPING' }> = []
  const updates: Array<{ id: string; data: CatalogDatasetData }> = []
  let unchanged = 0
  for (const entry of entries) {
    const data = catalogDatasetData(entry)
    const current = bySourceUrl.get(entry.sourceUrl)
    if (!current) creates.push({ ...data, status: 'AVAILABLE', storage: 'FILE_STORAGE', compatibility: 'READY_WITH_MAPPING' })
    else if (hasSameCatalogMetadata(current, data)) unchanged += 1
    // Only catalog metadata is refreshed. A dataset that has been downloaded and
    // normalized must retain its real import status, storage, mapping, and files.
    else updates.push({ id: current.id, data })
  }
  if (updates.length) await prisma.$transaction(updates.map((update) => prisma.dataset.update({ where: { id: update.id }, data: update.data })))
  const created = creates.length ? (await prisma.dataset.createMany({ data: creates, skipDuplicates: true })).count : 0
  return { imported: entries.length, created, updated: updates.length, unchanged, catalog: SNAP_CATALOG_URL }
}

/** Coalesces duplicate UI clicks in-process; the database uniqueness constraint handles cross-process races. */
export function importSnapCatalog() {
  if (!catalogImportInFlight) {
    catalogImportInFlight = importSnapCatalogOnce().finally(() => { catalogImportInFlight = undefined })
  }
  return catalogImportInFlight
}

export async function resolveSnapDownload(sourceUrl: string) {
  const response = await fetch(sourceUrl, { cache: 'no-store', headers: { 'User-Agent': 'ChainReactionDatasetDownloader/1.0' } })
  if (!response.ok) throw new DomainError('SNAP_DATASET_PAGE_UNAVAILABLE', 'The SNAP dataset page could not be reached.', 502, { sourceUrl, status: response.status }, ['Retry the download or open the source documentation.'])
  const html = await response.text()
  const links = [...html.matchAll(/href\s*=\s*["']([^"']+\.(?:txt|csv|tsv|json|zip|gz)(?:\?[^"']*)?)["']/gi)].map((match) => absoluteUrl(match[1], sourceUrl)).filter((url): url is string => Boolean(url))
  const preferred = links.find((url) => /\.txt\.gz(?:\?|$)/i.test(url)) ?? links[0]
  if (!preferred) throw new DomainError('SNAP_DOWNLOAD_NOT_FOUND', 'No supported raw dataset download was found on the official SNAP page.', 422, { sourceUrl }, ['Open the documentation URL and choose a supported raw edge-list file.'])
  return preferred
}
