import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type SwarmTokenUsageSnapshot = {
  available: boolean
  source: 'state.db:sessions'
  measuredAt: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  error?: string
}

const READ_USAGE_SCRIPT = `import json, pathlib, sqlite3, sys
try:
    db_uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro'
    con = sqlite3.connect(db_uri, uri=True)
    con.row_factory = sqlite3.Row
    columns = {row['name'] for row in con.execute('pragma table_info(sessions)').fetchall()}
    if 'input_tokens' not in columns or 'output_tokens' not in columns:
        raise RuntimeError('sessions token columns unavailable')
    row = con.execute('select coalesce(sum(input_tokens), 0) input_tokens, coalesce(sum(output_tokens), 0) output_tokens from sessions').fetchone()
    print(json.dumps({'inputTokens': int(row['input_tokens']), 'outputTokens': int(row['output_tokens'])}))
    con.close()
except Exception as error:
    print(json.dumps({'error': str(error)}))
`

export function readWorkerTokenUsage(
  profilePath: string,
): SwarmTokenUsageSnapshot {
  const measuredAt = Date.now()
  const unavailable = (error?: string): SwarmTokenUsageSnapshot => ({
    available: false,
    source: 'state.db:sessions',
    measuredAt,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    ...(error ? { error } : {}),
  })
  const dbPath = join(profilePath, 'state.db')
  if (!existsSync(dbPath)) return unavailable('state.db unavailable')

  try {
    const raw = execFileSync('python3', ['-c', READ_USAGE_SCRIPT, dbPath], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    const parsed = JSON.parse(raw) as {
      inputTokens?: unknown
      outputTokens?: unknown
      error?: unknown
    }
    if (typeof parsed.error === 'string') return unavailable(parsed.error)
    if (
      typeof parsed.inputTokens !== 'number' ||
      typeof parsed.outputTokens !== 'number'
    ) {
      return unavailable('invalid sessions token totals')
    }
    return {
      available: true,
      source: 'state.db:sessions',
      measuredAt,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      totalTokens: parsed.inputTokens + parsed.outputTokens,
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
}
