export async function observe<T>(input: {
  requestId: string
  route: string
  operation: () => Promise<T>
}): Promise<T> {
  const startedAt = performance.now()
  try {
    const result = await input.operation()
    console.info(JSON.stringify({ event: 'request.completed', requestId: input.requestId, route: input.route, durationMs: Math.round(performance.now() - startedAt), status: 'ok' }))
    return result
  } catch (error) {
    console.error(JSON.stringify({
      event: 'request.failed',
      requestId: input.requestId,
      route: input.route,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof Prisma.PrismaClientKnownRequestError ? { prismaCode: error.code } : {}),
    }))
    throw error
  }
}
import { Prisma } from '@prisma/client'
