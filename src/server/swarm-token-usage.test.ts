import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkerTokenUsage } from './swarm-token-usage'

function createStateDb(profilePath: string): void {
  execFileSync('python3', [
    '-c',
    `
import os, sqlite3, sys
os.makedirs(sys.argv[1], exist_ok=True)
con = sqlite3.connect(os.path.join(sys.argv[1], 'state.db'))
con.execute('create table sessions (id text primary key, input_tokens integer, output_tokens integer)')
con.executemany('insert into sessions values (?, ?, ?)', [('one', 100, 25), ('two', 40, 10)])
con.commit()
con.close()
`,
    profilePath,
  ])
}

describe('readWorkerTokenUsage', () => {
  it('sums actual session token columns through a read-only state.db connection', () => {
    const profilePath = mkdtempSync(join(tmpdir(), 'swarm-token-usage-'))
    try {
      createStateDb(profilePath)
      expect(readWorkerTokenUsage(profilePath)).toMatchObject({
        available: true,
        source: 'state.db:sessions',
        inputTokens: 140,
        outputTokens: 35,
        totalTokens: 175,
      })
    } finally {
      rmSync(profilePath, { recursive: true, force: true })
    }
  })

  it('reports unavailable usage without throwing when state.db is missing', () => {
    const profilePath = mkdtempSync(join(tmpdir(), 'swarm-token-missing-'))
    try {
      expect(readWorkerTokenUsage(profilePath)).toMatchObject({
        available: false,
        source: 'state.db:sessions',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      })
    } finally {
      rmSync(profilePath, { recursive: true, force: true })
    }
  })

  it('reads paths containing URI-reserved characters without opening another database', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-token-path-'))
    const profilePath = join(root, 'profile?#name')
    try {
      createStateDb(profilePath)
      expect(readWorkerTokenUsage(profilePath)).toMatchObject({
        available: true,
        totalTokens: 175,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
