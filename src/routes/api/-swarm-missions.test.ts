import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'

const tempRoot = vi.hoisted(
  () => `/tmp/swarm-missions-route-${process.pid}-${Date.now()}`,
)
const publishSwarmCancellationNotification = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}))
vi.mock('../../server/auth-middleware', () => ({ isAuthenticated: () => true }))
vi.mock('../../server/swarm-environment', () => ({
  SWARM_CANONICAL_REPO: tempRoot,
}))
vi.mock('../../server/swarm-runtime-reset', () => ({
  resetSwarmWorkerRuntime: vi.fn(),
}))
vi.mock('../../server/swarm-notifications', () => ({
  publishSwarmCancellationNotification,
}))

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

describe('POST /api/swarm-missions', () => {
  it('publishes a cancellation event to the mission return session', async () => {
    const missions = await import('../../server/swarm-missions')
    missions.createOrUpdateMission({
      missionId: 'mission-cancel-desktop',
      title: 'Desktop cancellation',
      returnSessionKey: 'desktop-session-42',
      assignments: [{ workerId: 'builder', task: 'Stop this task' }],
    })
    const mod = await import('./swarm-missions')
    const handlers = (mod.Route as any).server.handlers
    const response = await handlers.POST({
      request: new Request('http://localhost/api/swarm-missions', {
        method: 'POST',
        body: JSON.stringify({
          action: 'cancel',
          missionId: 'mission-cancel-desktop',
          reason: 'User stopped it',
        }),
      }),
    })

    expect(response.status).toBe(200)
    expect(publishSwarmCancellationNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-cancel-desktop',
        sessionKey: 'desktop-session-42',
        reason: 'User stopped it',
      }),
    )
  })
})
