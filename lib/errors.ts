import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export type ErrorPayload = {
  code: string
  message: string
  details?: Record<string, unknown>
  suggestedActions?: string[]
  requestId?: string
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details: Record<string, unknown> = {},
    public readonly suggestedActions: string[] = [],
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export const requestId = () => crypto.randomUUID()

const SENSITIVE_KEY = '(?:password|passphrase|api[_-]?key|token|authorization|database[_-]?url|secret|client[_-]?secret|access[_-]?key|credential(?:s)?)'
const sensitiveKeyPattern = new RegExp(`^${SENSITIVE_KEY}$`, 'i')

function redactString(value: string) {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1***@')
    .replace(/(authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;'"\\}&]+/gi, '$1***')
    .replace(new RegExp(`(["']?${SENSITIVE_KEY}["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi'), '$1"***"')
    .replace(new RegExp(`(["']?${SENSITIVE_KEY}["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gi'), "$1'***'")
    .replace(new RegExp(`(["']?${SENSITIVE_KEY}["']?\\s*[:=]\\s*)[^\\s,;\\]}&]+`, 'gi'), '$1***')
}

export function safeTechnicalDetails(value: unknown) {
  const text = value instanceof Error ? value.message : String(value ?? '')
  return redactString(text).slice(0, 1800)
}

export function safeDiagnosticDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeDiagnosticDetails)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      sensitiveKeyPattern.test(key) ? '***' : safeDiagnosticDetails(nested),
    ]))
  }
  return typeof value === 'string' ? redactString(value) : value
}

export function toErrorPayload(error: unknown): { payload: ErrorPayload; status: number; technicalDetails: string } {
  if (error instanceof DomainError) {
    return {
      payload: { code: error.code, message: error.message, details: safeDiagnosticDetails(error.details) as Record<string, unknown>, suggestedActions: error.suggestedActions },
      status: error.status,
      technicalDetails: safeTechnicalDetails(error),
    }
  }

  const technicalDetails = safeTechnicalDetails(error)
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const details = { prismaCode: error.code, ...(typeof error.meta === 'object' && error.meta ? { target: error.meta.target } : {}) }
    if (error.code === 'P2002') return { payload: { code: 'UNIQUE_CONSTRAINT_CONFLICT', message: 'A record with the same unique value already exists.', details, suggestedActions: ['Choose a different unique value or refresh the existing record.'] }, status: 409, technicalDetails }
    if (error.code === 'P2003') return { payload: { code: 'FOREIGN_KEY_CONSTRAINT_FAILED', message: 'The request references a record that no longer exists.', details, suggestedActions: ['Refresh the selected dataset or node, then retry.'] }, status: 422, technicalDetails }
    if (error.code === 'P2025') return { payload: { code: 'RECORD_NOT_FOUND', message: 'The record was not found or was changed by another operation.', details, suggestedActions: ['Refresh the workspace and retry.'] }, status: 404, technicalDetails }
    if (error.code === 'P2034') return { payload: { code: 'TRANSACTION_CONFLICT', message: 'This update conflicted with another transaction.', details, suggestedActions: ['Retry the operation.'] }, status: 409, technicalDetails }
    if (error.code === 'P2028') return { payload: { code: 'TRANSACTION_TIMEOUT', message: 'The database transaction took too long to complete.', details: { prismaCode: error.code }, suggestedActions: ['Retry the operation. If it recurs, inspect the recorded database latency.'] }, status: 503, technicalDetails }
    if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(error.code)) {
      return { payload: { code: 'DATABASE_UNAVAILABLE', message: 'PostgreSQL could not be reached.', details: { prismaCode: error.code }, suggestedActions: ['Check Neon availability, then retry.'] }, status: 503, technicalDetails }
    }
    return { payload: { code: 'DATABASE_OPERATION_FAILED', message: 'PostgreSQL rejected the requested operation.', details, suggestedActions: ['Review the recorded diagnostic and correct the request parameters.'] }, status: 422, technicalDetails }
  }

  const databaseUnavailable = error instanceof Prisma.PrismaClientInitializationError || /can't reach database server|connection (?:timed out|refused)|p10(?:01|02|08|17)|p2024/i.test(technicalDetails)
  return {
    payload: databaseUnavailable
      ? {
          code: 'DATABASE_UNAVAILABLE',
          message: 'PostgreSQL could not be reached.',
          details: { operation: 'server request' },
          suggestedActions: ['Check DATABASE_URL in the server environment.', 'Check Neon availability, then retry.'],
        }
      : {
          code: 'INTERNAL_ERROR',
          message: 'The requested operation could not be completed.',
          suggestedActions: ['Retry the request. If it persists, inspect Diagnostics Center.'],
        },
    status: databaseUnavailable ? 503 : 500,
    technicalDetails,
  }
}

export async function recordError(input: {
  requestId: string
  error: unknown
  component: string
  operation: string
  datasetId?: string
  scenarioId?: string
  parameters?: Record<string, unknown>
}) {
  const normalized = toErrorPayload(input.error)
  try {
    await prisma.errorEvent.create({
      data: {
        requestId: input.requestId,
        severity: normalized.status >= 500 ? 'ERROR' : 'WARNING',
        component: input.component,
        operation: input.operation,
        message: normalized.payload.message,
        technicalDetails: normalized.technicalDetails,
        parameters: safeDiagnosticDetails({ ...normalized.payload.details, ...input.parameters }) as never,
        datasetId: input.datasetId,
        scenarioId: input.scenarioId,
        suggestedFix: normalized.payload.suggestedActions?.join(' '),
      },
    })
  } catch {
    // A database outage cannot be recorded in that same database. The route log remains available.
  }
  return normalized
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value
    const serializable = value as { toJSON?: () => unknown }
    if (typeof serializable.toJSON === 'function') return jsonSafe(serializable.toJSON())
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, jsonSafe(nested)]))
  }
  return value
}

export function success(data: unknown, status = 200, id = requestId()) {
  return NextResponse.json(jsonSafe({ success: true, data, requestId: id }), { status, headers: { 'x-request-id': id } })
}

export function failure(normalized: Awaited<ReturnType<typeof recordError>> | ReturnType<typeof toErrorPayload>, id: string) {
  return NextResponse.json(
    jsonSafe({ success: false, error: { ...normalized.payload, requestId: id }, requestId: id }),
    { status: normalized.status, headers: { 'x-request-id': id } },
  )
}
