import { backendCall } from '../backend'

export interface RepoMapFile {
  path: string
  score: number
  snippet: string
}

export interface RepoMapResult {
  files: RepoMapFile[]
  count: number
}

export interface FetchRepoMapInput {
  workingDirectory: string
  query?: string
  limit?: number
  signal?: AbortSignal
}

/**
 * Calls the Bridge `repo_map` command. The Bridge walks the working
 * directory, parses imports, runs PageRank, and returns the top-N ranked
 * files. Pure I/O — no caching; the caller decides when to refresh.
 */
export async function fetchRepoMap(input: FetchRepoMapInput): Promise<RepoMapResult> {
  if (!input.workingDirectory) {
    return { files: [], count: 0 }
  }
  const out = await backendCall<RepoMapResult>('repo_map', {
    workingDirectory: input.workingDirectory,
    query: input.query,
    limit: input.limit ?? 20,
  })
  return {
    files: Array.isArray(out.files) ? out.files : [],
    count: typeof out.count === 'number' ? out.count : 0,
  }
}

/**
 * Renders the repo-map result as a system-prompt section. Bounded by
 * character count so a 200-file map can't crowd out the user's actual
 * instructions. The format mirrors the Architect plan section — a
 * stable header the editor model can refer back to.
 */
export function renderRepoMapSection(
  result: RepoMapResult,
  opts?: { maxChars?: number },
): string {
  if (!result.files.length) return ''
  const maxChars = opts?.maxChars ?? 2400
  const lines: string[] = []
  lines.push('')
  lines.push('')
  lines.push(
    'REPO MAP — files ranked by import-graph PageRank. Use these as your',
  )
  lines.push('initial reading list before grepping for unrelated files.')
  lines.push('')
  let used = lines.join('\n').length
  for (const f of result.files) {
    const snippet = f.snippet ? ` — ${f.snippet}` : ''
    const row = `- ${f.path}${snippet}`
    if (used + row.length + 1 > maxChars) break
    lines.push(row)
    used += row.length + 1
  }
  return lines.join('\n')
}
