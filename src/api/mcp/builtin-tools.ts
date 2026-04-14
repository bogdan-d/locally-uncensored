// Built-in tool definitions + executors — replaces hardcoded AGENT_TOOL_DEFS

import type { MCPToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { backendCall, fetchExternal } from '../backend'
import { useAgentWorkflowStore } from '../../stores/agentWorkflowStore'
import { WorkflowEngine } from '../../lib/workflow-engine'
import type { StepResult } from '../../types/agent-workflows'

// ── Tool Definitions ────────────────────────────────────────────

const BUILTIN_TOOLS: MCPToolDefinition[] = [
  // Web
  {
    name: 'web_search',
    description: 'Search the web for current information. Returns titles, URLs, and short snippets. Use web_fetch on promising URLs to read full content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query string' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 5)' },
      },
      required: ['query'],
    },
    category: 'web',
    source: 'builtin',
  },
  {
    name: 'web_fetch',
    description: 'Fetch a web page URL and return its text content. Use AFTER web_search to read the full content. Returns cleaned text, not HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        maxLength: { type: 'number', description: 'Maximum characters to return (default: 4000)' },
      },
      required: ['url'],
    },
    category: 'web',
    source: 'builtin',
  },

  // Filesystem
  {
    name: 'file_read',
    description: 'Read the contents of any file on the system. Supports absolute paths and relative paths (relative to agent workspace).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute or relative)' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_write',
    description: 'Write content to any file. Creates the file if it does not exist, overwrites if it does. Creates parent directories automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute or relative)' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_list',
    description: 'List files and directories at a path. Supports recursive listing and glob patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        recursive: { type: 'boolean', description: 'Whether to list recursively (default: false)' },
        pattern: { type: 'string', description: 'Glob pattern to filter results (e.g. "*.ts", "**/*.py")' },
      },
      required: ['path'],
    },
    category: 'filesystem',
    source: 'builtin',
  },
  {
    name: 'file_search',
    description: 'Search file contents using regex patterns. Returns matching files with line numbers and context.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in' },
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        maxResults: { type: 'number', description: 'Maximum files to return (default: 50)' },
      },
      required: ['path', 'pattern'],
    },
    category: 'filesystem',
    source: 'builtin',
  },

  // Terminal
  {
    name: 'shell_execute',
    description: 'Execute a shell command on the system. Supports PowerShell (Windows), bash (Linux/Mac). Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
        shell: { type: 'string', description: 'Shell to use: "powershell", "cmd", "bash" (default: auto)' },
      },
      required: ['command'],
    },
    category: 'terminal',
    source: 'builtin',
  },
  {
    name: 'code_execute',
    description: 'Execute Python code. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python code to execute' },
        language: { type: 'string', description: 'Programming language: "python" or "shell"', enum: ['python', 'shell'] },
      },
      required: ['code'],
    },
    category: 'terminal',
    source: 'builtin',
  },

  // System
  {
    name: 'system_info',
    description: 'Get system information: OS, architecture, hostname, username, RAM, CPU count.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },
  {
    name: 'process_list',
    description: 'List running processes sorted by memory usage. Returns top 50 processes with name, PID, memory, and CPU usage.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'system',
    source: 'builtin',
  },

  // Desktop
  {
    name: 'screenshot',
    description: 'Take a screenshot of the primary screen. Returns base64-encoded PNG image.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    category: 'desktop',
    source: 'builtin',
  },

  // Image
  {
    name: 'image_generate',
    description: 'Generate an image from a text description using the local ComfyUI image generation pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        negativePrompt: { type: 'string', description: 'Things to avoid in the generated image' },
      },
      required: ['prompt'],
    },
    category: 'image',
    source: 'builtin',
  },

  // Workflow
  {
    name: 'run_workflow',
    description: 'Run a saved agent workflow by name. Available workflows: Research Topic, Summarize URL, Code Review, and any custom workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow to run' },
        input: { type: 'string', description: 'Initial input to provide to the workflow' },
      },
      required: ['name'],
    },
    category: 'workflow',
    source: 'builtin',
  },

  // Local clock — so the agent never googles "what day is it".
  {
    name: 'get_current_time',
    description: 'Return the user\'s current local date, time and timezone. Use this FIRST for any "what day / time / date is it" question — do NOT web_search for it. Zero arguments.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    category: 'system',
    source: 'builtin',
  },
]

// ── Executors ────────────────────────────────────────────────────

async function executeWebSearch(args: Record<string, any>): Promise<string> {
  const { useSettingsStore } = await import('../../stores/settingsStore')
  const searchSettings = useSettingsStore.getState().settings
  const data = await backendCall('web_search', {
    query: args.query,
    count: args.maxResults || 5,
    provider: searchSettings.searchProvider || 'auto',
    braveApiKey: searchSettings.braveApiKey || '',
    tavilyApiKey: searchSettings.tavilyApiKey || '',
  })
  if (Array.isArray(data.results)) {
    return data.results
      .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
  }
  return JSON.stringify(data)
}

async function executeWebFetch(args: Record<string, any>): Promise<string> {
  const url = args.url
  if (!url) return 'Error: No URL provided'

  // Preferred path: use the Rust `web_fetch` command which strips HTML
  // aggressively (<script>/<style>/<nav>/<footer> gone, paragraphs kept)
  // and caps at ~24 000 chars. The old path only gave the model the first
  // ~4 000 chars of a half-cleaned body — that's why the agent kept
  // complaining it "only sees the header" of the page.
  try {
    const data = await backendCall<{ url: string; status: number; contentType: string; title: string; text: string; truncated: boolean }>(
      'web_fetch',
      { url }
    )
    const parts: string[] = []
    if (data.title) parts.push(`Title: ${data.title}`)
    parts.push(`URL: ${data.url}`)
    parts.push(`Status: ${data.status}`)
    parts.push('')
    parts.push(data.text || '(empty body)')
    if (data.truncated) parts.push('\n…(truncated to 24 000 chars)')
    return parts.join('\n')
  } catch (e) {
    // Fallback: legacy fetchExternal + htmlToText (used in browser / dev mode
    // where the Rust command isn't reachable).
    try {
      const maxLength = args.maxLength || 24000
      const html = await fetchExternal(url)
      const text = htmlToText(html)
      if (text.length > maxLength) return text.substring(0, maxLength) + '\n\n[...truncated]'
      return text || 'Error: Page returned empty content'
    } catch (fallbackErr) {
      return `Error: web_fetch failed — ${e instanceof Error ? e.message : String(e)}`
    }
  }
}

async function executeFileRead(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_read', { path: args.path })
  return data.content || ''
}

async function executeFileWrite(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_write', { path: args.path, content: args.content })
  return data.status === 'saved' ? `File saved: ${data.path}` : JSON.stringify(data)
}

async function executeFileList(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_list', {
    path: args.path,
    recursive: args.recursive || false,
    pattern: args.pattern || null,
  })
  if (Array.isArray(data.entries)) {
    return data.entries
      .map((e: any) => `${e.isDir ? '[DIR]' : ''} ${e.name} (${formatBytes(e.size)})  ${e.path}`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeFileSearch(args: Record<string, any>): Promise<string> {
  const data = await backendCall('fs_search', {
    path: args.path,
    pattern: args.pattern,
    max_results: args.maxResults || 50,
  })
  if (Array.isArray(data.results)) {
    return data.results
      .map((r: any) => {
        const matches = r.matches?.map((m: any) => `  L${m.line}: ${m.text}`).join('\n') || ''
        return `${r.file}\n${matches}`
      })
      .join('\n\n')
  }
  return JSON.stringify(data)
}

async function executeShellExecute(args: Record<string, any>): Promise<string> {
  const data = await backendCall('shell_execute', {
    command: args.command,
    args: args.args || null,
    cwd: args.cwd || null,
    timeout: args.timeout || 120000,
    shell: args.shell || null,
  })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function executeCodeExecute(args: Record<string, any>): Promise<string> {
  const data = await backendCall('execute_code', { code: args.code, timeout: 30000 })
  const output = data.stdout || ''
  const err = data.stderr || ''
  if (data.timedOut) return `Timed out.\n${err}`
  if (data.exitCode && data.exitCode !== 0) return `Error (${data.exitCode}):\n${err || output}`
  return output || (err ? `stderr: ${err}` : 'Done.')
}

async function executeSystemInfo(): Promise<string> {
  const data = await backendCall('system_info', {})
  return Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n')
}

async function executeProcessList(): Promise<string> {
  const data = await backendCall('process_list', {})
  if (Array.isArray(data.processes)) {
    return data.processes
      .slice(0, 30)
      .map((p: any) => `${p.name} (PID: ${p.pid}) — ${formatBytes(p.memory)} RAM, ${p.cpu?.toFixed(1)}% CPU`)
      .join('\n')
  }
  return JSON.stringify(data)
}

async function executeScreenshot(): Promise<string> {
  const data = await backendCall('screenshot', {})
  if (data.image) {
    return `[Screenshot captured: base64 PNG, ${Math.round(data.image.length / 1024)}KB]`
  }
  return JSON.stringify(data)
}

async function executeImageGenerate(args: Record<string, any>): Promise<string> {
  const prompt = args.prompt || args.description || ''
  if (!prompt) return 'Error: No prompt provided for image generation.'
  try {
    const { buildDynamicWorkflow } = await import('../dynamic-workflow')
    const { submitWorkflow, getHistory, classifyModel, getImageModels } = await import('../comfyui')
    const models = await getImageModels()
    if (models.length === 0) return 'Error: No image models available in ComfyUI.'
    const model = models[0]
    const workflow = await buildDynamicWorkflow({
      prompt, negativePrompt: '', model: model.name,
      sampler: 'euler', scheduler: 'normal', steps: 20, cfgScale: 7,
      width: 1024, height: 1024, seed: -1, batchSize: 1,
    }, classifyModel(model.name))
    const promptId = await submitWorkflow(workflow)
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const history = await getHistory(promptId)
      if (history?.status?.completed) {
        const outputs = history.outputs ?? {}
        for (const nodeId of Object.keys(outputs)) {
          const files = [...(outputs[nodeId].images ?? []), ...(outputs[nodeId].gifs ?? [])]
          if (files.length > 0) return `Image generated: ${files[0].filename} (prompt: "${prompt}")`
        }
        return 'Generation completed but no output produced.'
      }
      if (history?.status?.status_str === 'error') return `Generation failed: ${history.status.messages?.[0]?.[1]?.message || 'Unknown error'}`
    }
    return 'Generation timed out after 5 minutes.'
  } catch (err) {
    return `Generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function executeGetCurrentTime(_args: Record<string, any>): Promise<string> {
  try {
    const data = await backendCall<{ unix: number; iso_local: string; iso_utc: string; timezone: string; timezone_offset: number }>(
      'get_current_time',
      {},
    )
    return `Local: ${data.iso_local} ${data.timezone}\nUTC:   ${data.iso_utc}\nUnix:  ${data.unix}`
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
}

let _workflowDepth = 0

async function executeRunWorkflow(args: Record<string, any>): Promise<string> {
  const workflowName = args.name
  if (!workflowName) return 'Error: No workflow name provided'
  if (_workflowDepth >= 5) return 'Error: Maximum workflow nesting depth (5) exceeded'

  const store = useAgentWorkflowStore.getState()
  const workflow = store.workflows.find(w => w.name.toLowerCase() === workflowName.toLowerCase())
  if (!workflow) {
    const available = store.workflows.map(w => w.name).join(', ')
    return `Error: Workflow "${workflowName}" not found. Available: ${available}`
  }

  const results: StepResult[] = []
  let finalOutput = ''
  const callbacks = {
    onStepStart: () => {},
    onStepComplete: (_idx: number, result: StepResult) => { results.push(result) },
    onStepError: () => {},
    onWaitingForInput: () => {},
    onComplete: () => {
      const lastOutput = results.filter(r => r.output).pop()
      finalOutput = lastOutput?.output || 'Workflow completed with no output.'
    },
    onError: (error: string) => { finalOutput = `Workflow error: ${error}` },
  }

  const initialVars = args.input ? { user_input: args.input, last_output: args.input } : {}
  _workflowDepth++
  try {
    const engine = new WorkflowEngine(workflow, 'tool-execution', callbacks, initialVars, _workflowDepth)
    await engine.run()
  } finally {
    _workflowDepth--
  }
  return finalOutput
}

// ── Helpers ─────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function htmlToText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style, nav, header, footer, .nav, .header, .footer, .sidebar, .menu, .ad, .advertisement, [role="navigation"], [role="banner"]').forEach(el => el.remove())
    const main = doc.querySelector('main, article, [role="main"], .content, .article, .post, #content, #main')
    const target = main || doc.body
    if (!target) return ''
    let text = ''
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let node: Node | null = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim()
        if (t) text += t + ' '
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase()
        if (['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr'].includes(tag)) text += '\n'
        if (['h1', 'h2', 'h3'].includes(tag)) text += '# '
      }
      node = walker.nextNode()
    }
    return text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── Registration ────────────────────────────────────────────────

const EXECUTOR_MAP: Record<string, (args: Record<string, any>) => Promise<string>> = {
  web_search: executeWebSearch,
  web_fetch: executeWebFetch,
  file_read: executeFileRead,
  file_write: executeFileWrite,
  file_list: executeFileList,
  file_search: executeFileSearch,
  shell_execute: executeShellExecute,
  code_execute: executeCodeExecute,
  system_info: executeSystemInfo,
  process_list: executeProcessList,
  screenshot: executeScreenshot,
  image_generate: executeImageGenerate,
  run_workflow: executeRunWorkflow,
  get_current_time: executeGetCurrentTime,
}

export function registerBuiltinTools(registry: ToolRegistry) {
  for (const tool of BUILTIN_TOOLS) {
    const executor = EXECUTOR_MAP[tool.name]
    if (executor) {
      registry.registerBuiltin(tool, executor)
    }
  }
}
