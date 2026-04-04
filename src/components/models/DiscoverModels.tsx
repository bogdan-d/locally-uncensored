import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Download, RefreshCw, ExternalLink, Search, Info, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { Pause, Play, X } from 'lucide-react'
import {
  fetchAbliteratedModels, searchOllamaModels, getImageBundles, getVideoBundles,
  getUncensoredTextModels, getMainstreamTextModels,
  startModelDownload, getDownloadProgress, searchCivitaiModels,
  pauseDownload, cancelDownload, resumeDownload,
  type DiscoverModel, type DownloadProgress, type ModelBundle, type CivitAIModelResult,
} from '../../api/discover'
import { getSystemVRAM } from '../../api/comfyui'
import { useModels } from '../../hooks/useModels'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'
import { proxyImageUrl } from '../../lib/privacy'

interface Props {
  category: ModelCategory
}

// Variant selector for text models with multiple sizes
function VariantPullButton({ model, pullModel, isPullingModel, isInstalled }: {
  model: DiscoverModel
  pullModel: (name: string) => void
  isPullingModel: (name: string) => boolean
  isInstalled: (name: string) => boolean
}) {
  const [open, setOpen] = useState(false)
  // Filter tags that are valid Ollama size/variant identifiers (e.g. 8B, Q4_K_M, e2b, scout, IQ4_XS)
  const tags = model.tags.filter(t => /^\d+B$/i.test(t) || /^[Qe]\d/i.test(t) || /^IQ\d/i.test(t) || /^[a-z]+$/i.test(t))

  // Human-readable descriptions for non-obvious tags
  const TAG_INFO: Record<string, string> = {
    scout: 'Llama 4 Scout — 16×17B MoE, ~109 GB, 10M context',
    maverick: 'Llama 4 Maverick — 128×17B MoE, ~280 GB, 1M context',
    e2b: 'Gemma 4 — 2B parameters, lightweight',
    e4b: 'Gemma 4 — 4B parameters, balanced',
  }

  // If no size tags or only one, show simple button
  if (tags.length <= 1) {
    const fullName = tags.length === 1 ? `${model.name}:${tags[0].toLowerCase()}` : model.name
    if (isInstalled(model.name)) {
      return <span className="text-xs text-green-500 px-2 py-1">Installed</span>
    }
    return (
      <button
        onClick={() => pullModel(fullName)}
        disabled={isPullingModel(fullName)}
        className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 text-gray-700 dark:text-white disabled:opacity-30 transition-all"
        title={`Install ${fullName}`}
      >
        <Download size={14} />
      </button>
    )
  }

  // Multiple variants → dropdown
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 text-gray-700 dark:text-white transition-all text-xs"
      >
        <Download size={12} />
        <span>Install</span>
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[120px] rounded-lg bg-gray-100 dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-lg overflow-hidden">
          {tags.map(tag => {
            const fullName = `${model.name}:${tag.toLowerCase()}`
            const installed = isInstalled(fullName)
            const info = TAG_INFO[tag.toLowerCase()]
            return (
              <button
                key={tag}
                onClick={() => { if (!installed) pullModel(fullName); setOpen(false) }}
                disabled={installed || isPullingModel(fullName)}
                className="w-full flex items-start justify-between gap-3 px-3 py-2 text-xs hover:bg-gray-200 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                title={info || `Install ${fullName}`}
              >
                <div className="text-left">
                  <span className="text-gray-800 dark:text-white font-medium">{tag}</span>
                  {info && <p className="text-[0.6rem] text-gray-500 mt-0.5">{info}</p>}
                </div>
                {installed ? (
                  <CheckCircle size={12} className="text-green-500 shrink-0 mt-0.5" />
                ) : (
                  <Download size={12} className="text-gray-400 shrink-0 mt-0.5" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ModelDiscoverCard({ model, index, isText, getModelDownloadState, pullModel, isPullingModel, isInstalled, handleDownload }: {
  model: DiscoverModel
  index: number
  isText: boolean
  getModelDownloadState: (m: DiscoverModel) => DownloadProgress | null
  pullModel: (name: string) => void
  isPullingModel: (name: string) => boolean
  isInstalled: (name: string) => boolean
  handleDownload: (m: DiscoverModel) => void
}) {
  const dlState = getModelDownloadState(model)
  const isDownloading = dlState?.status === 'downloading' || dlState?.status === 'connecting'
  const isComplete = dlState?.status === 'complete'
  const isError = dlState?.status === 'error'
  const canDirectDownload = !!model.downloadUrl && !!model.filename && !!model.subfolder

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
    >
      <GlassCard className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate flex items-center gap-1.5">
              {isInstalled(model.name) && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">INSTALLED</span>}
              {model.hot && !isInstalled(model.name) && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-500 font-bold border border-orange-500/30 shrink-0">HOT</span>}
              {model.agent && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">AGENT</span>}
              <span className="truncate">{model.name}</span>
            </h3>
            {model.description && (
              <p className="text-xs text-gray-500 mt-0.5">{model.description}</p>
            )}
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {model.tags.map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">
                  {tag}
                </span>
              ))}
              {model.sizeGB && (
                <span className="text-[10px] text-gray-400">{model.sizeGB} GB</span>
              )}
              {model.pulls && (
                <span className="text-[10px] text-gray-500">{model.pulls}</span>
              )}
            </div>

            {isDownloading && dlState && (
              <div className="mt-2 space-y-1">
                <ProgressBar progress={dlState.total > 0 ? (dlState.progress / dlState.total) * 100 : 0} />
                <div className="flex items-center justify-between text-[10px] text-gray-400">
                  <span>{dlState.total > 0 ? `${formatBytes(dlState.progress)} / ${formatBytes(dlState.total)}` : 'Connecting...'}</span>
                  {dlState.speed > 0 && <span>{formatBytes(dlState.speed)}/s</span>}
                </div>
              </div>
            )}
            {isError && dlState && (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-red-500">
                <XCircle size={10} /> {dlState.error || 'Download failed'}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isText ? (
              <VariantPullButton model={model} pullModel={pullModel} isPullingModel={isPullingModel} isInstalled={isInstalled} />
            ) : (
              <>
                {isComplete ? (
                  <span className="flex items-center gap-1 text-xs text-green-500 px-2 py-1">
                    <CheckCircle size={12} /> Installed
                  </span>
                ) : isDownloading ? (
                  <span className="p-2 text-gray-400">
                    <Loader2 size={14} className="animate-spin" />
                  </span>
                ) : canDirectDownload ? (
                  <button
                    onClick={() => handleDownload(model)}
                    className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                    title={`Download ${model.sizeGB ? model.sizeGB + ' GB' : ''} to ComfyUI`}
                  >
                    <Download size={14} />
                  </button>
                ) : null}
                {model.url && (
                  <a href={model.url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on website">
                    <ExternalLink size={14} />
                  </a>
                )}
              </>
            )}
          </div>
        </div>
      </GlassCard>
    </motion.div>
  )
}

export function DiscoverModels({ category }: Props) {
  const [textModels, setTextModels] = useState<DiscoverModel[]>([])
  const [civitaiResults, setCivitaiResults] = useState<CivitAIModelResult[]>([])
  const [civitaiSearching, setCivitaiSearching] = useState(false)
  const [civitaiQuery, setCivitaiQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
  const [downloadMeta, setDownloadMeta] = useState<Record<string, { url: string; subfolder: string }>>({})
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  const [subTab, setSubTab] = useState<'uncensored' | 'mainstream'>('uncensored')
  const { pullModel, isPullingModel, models: installedModels } = useModels()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load text models from Ollama search
  useEffect(() => {
    if (category === 'text') {
      setLoading(true)
      fetchAbliteratedModels().then(m => { setTextModels(m); setLoading(false) })
    }
  }, [category])

  // Detect system VRAM
  useEffect(() => {
    getSystemVRAM().then(v => setSystemVRAM(v))
  }, [])

  // Poll download progress
  useEffect(() => {
    const hasActive = Object.values(downloads).some(d => d.status === 'downloading' || d.status === 'connecting' || d.status === 'pausing')
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const prog = await getDownloadProgress()
        setDownloads(prev => {
          for (const [id, d] of Object.entries(prog)) {
            if (d.status === 'complete' && prev[id]?.status !== 'complete') {
              window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))
            }
          }
          return prog
        })
        const stillActive = Object.values(prog).some(d => d.status === 'downloading' || d.status === 'connecting' || d.status === 'pausing')
        if (!stillActive && pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, 1000)
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [downloads])

  const isText = category === 'text'
  const isImage = category === 'image'
  const isVideo = category === 'video'
  const allModels = isText ? textModels : []
  const bundles = isImage ? getImageBundles() : isVideo ? getVideoBundles() : []

  const filtered = search
    ? allModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : allModels

  // Parse VRAM requirement string to minimum GB needed
  // "6-8 GB" → 8 (need at least the upper bound)
  // "12+ GB" → 13 (+ means MORE than that number)
  // "8 GB" → 8
  const parseVRAM = (s: string): number => {
    if (s.includes('+')) {
      const match = s.match(/(\d+)\+/)
      return match ? parseInt(match[1]) + 2 : 99 // "12+" means realistically 14+ GB needed
    }
    // Range like "6-8 GB" → take the upper number
    const range = s.match(/(\d+)\s*-\s*(\d+)/)
    if (range) return parseInt(range[2])
    const match = s.match(/(\d+)/)
    return match ? parseInt(match[1]) : 99
  }

  // Sort bundles: HOT first, then recommended (fits VRAM), then by size
  const sortedBundles = [...bundles].sort((a, b) => {
    // HOT models always first
    if (a.hot && !b.hot) return -1
    if (!a.hot && b.hot) return 1
    if (systemVRAM) {
      const aFits = parseVRAM(a.vramRequired) <= systemVRAM
      const bFits = parseVRAM(b.vramRequired) <= systemVRAM
      if (aFits && !bFits) return -1
      if (!aFits && bFits) return 1
    }
    return parseVRAM(a.vramRequired) - parseVRAM(b.vramRequired)
  })

  const tabFilteredBundles = sortedBundles.filter(b => subTab === 'uncensored' ? b.uncensored : !b.uncensored)
  const filteredBundles = search
    ? tabFilteredBundles.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()) || b.description.toLowerCase().includes(search.toLowerCase()))
    : tabFilteredBundles

  const isInstalled = (name: string) => installedModels.some((m) => m.name.startsWith(name.split(':')[0]))

  const handleDownload = async (model: DiscoverModel) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    // Store meta for resume
    setDownloadMeta(prev => ({ ...prev, [model.filename!]: { url: model.downloadUrl!, subfolder: model.subfolder! } }))
    const result = await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    if (result.status === 'started' || result.status === 'already_exists') {
      const prog = await getDownloadProgress()
      setDownloads(prog)
    }
  }

  const handleBundleInstall = async (bundle: ModelBundle) => {
    for (const file of bundle.files) {
      if (file.downloadUrl && file.filename && file.subfolder) {
        setDownloadMeta(prev => ({ ...prev, [file.filename!]: { url: file.downloadUrl!, subfolder: file.subfolder! } }))
        await startModelDownload(file.downloadUrl, file.subfolder, file.filename)
      }
    }
    const prog = await getDownloadProgress()
    setDownloads(prog)
  }

  const handlePause = async (id: string) => {
    await pauseDownload(id)
    const prog = await getDownloadProgress()
    setDownloads(prog)
  }

  const handleCancel = async (id: string) => {
    await cancelDownload(id)
    setDownloads(prev => {
      const updated = { ...prev }
      delete updated[id]
      return updated
    })
  }

  const handleResume = async (id: string) => {
    const meta = downloadMeta[id]
    if (!meta) return
    await resumeDownload(id, meta.url, meta.subfolder)
    const prog = await getDownloadProgress()
    setDownloads(prog)
  }

  const handleCivitaiSearch = async () => {
    if (!civitaiQuery.trim()) return
    setCivitaiSearching(true)
    const results = await searchCivitaiModels(civitaiQuery, 'Checkpoint')
    setCivitaiResults(results)
    setCivitaiSearching(false)
  }

  const handleCivitaiDownload = async (model: CivitAIModelResult) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    // CivitAI downloads need the proxy
    const url = model.downloadUrl.startsWith('http')
      ? `/local-api/proxy-download?url=${encodeURIComponent(model.downloadUrl)}`
      : model.downloadUrl
    const result = await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    if (result.status === 'started' || result.status === 'already_exists') {
      const prog = await getDownloadProgress()
      setDownloads(prog)
    }
  }

  const isBundleComplete = (bundle: ModelBundle): boolean => {
    return bundle.files.every(f => f.filename && downloads[f.filename]?.status === 'complete')
  }

  const isBundleDownloading = (bundle: ModelBundle): boolean => {
    return bundle.files.some(f => f.filename && (downloads[f.filename]?.status === 'downloading' || downloads[f.filename]?.status === 'connecting'))
  }

  const getBundleProgress = (bundle: ModelBundle): number => {
    let totalBytes = 0, downloadedBytes = 0
    for (const f of bundle.files) {
      if (f.filename && downloads[f.filename]) {
        totalBytes += downloads[f.filename].total
        downloadedBytes += downloads[f.filename].progress
      }
    }
    return totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0
  }

  const getModelDownloadState = (model: DiscoverModel): DownloadProgress | null => {
    if (!model.filename) return null
    return downloads[model.filename] ?? null
  }

  // Progress calculation moved to DownloadBadge in Header

  const handleOllamaSearch = async () => {
    if (!search.trim() || !isText) return
    setLoading(true)
    try {
      const results = await searchOllamaModels(search.trim())
      setTextModels(results)
    } catch { /* keep existing */ }
    setLoading(false)
  }

  const uncensoredModels = isText ? getUncensoredTextModels() : []
  const mainstreamModels = isText ? getMainstreamTextModels() : []

  const filteredUncensored = search
    ? uncensoredModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : uncensoredModels
  const filteredMainstream = search
    ? mainstreamModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : mainstreamModels

  const title = isText ? 'Discover LUncensored' : isImage ? 'Discover LUncensored' : 'Discover LUncensored'
  const subtitle = isText
    ? 'Search the Ollama registry or browse curated models.'
    : isImage
      ? 'Browse image generation models for ComfyUI.'
      : 'Browse video generation models for ComfyUI.'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        {isText && (
          <GlowButton variant="secondary" onClick={() => { setLoading(true); fetchAbliteratedModels().then(m => { setTextModels(m); setLoading(false) }) }} disabled={loading} aria-label="Refresh">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </GlowButton>
        )}
      </div>

      <p className="text-sm text-gray-500">{subtitle}</p>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && isText) handleOllamaSearch() }}
          placeholder={isText ? 'Search Ollama registry... (Enter to search)' : 'Filter models...'}
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
      </div>

      {/* Download Manager */}
      {Object.values(downloads).some(d => d.status === 'downloading' || d.status === 'connecting' || d.status === 'pausing' || d.status === 'paused') && (
        <GlassCard className="p-3 space-y-2">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
            <Loader2 size={14} className={Object.values(downloads).some(d => d.status === 'downloading') ? 'animate-spin' : ''} /> Downloads
          </h3>
          {Object.entries(downloads).filter(([, d]) => d.status === 'downloading' || d.status === 'connecting' || d.status === 'pausing' || d.status === 'paused').map(([id, d]) => (
            <div key={id} className="space-y-1">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span className="truncate flex-1">{d.filename}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span>
                    {d.status === 'paused' ? 'Paused' : d.status === 'pausing' ? 'Pausing...' : d.total > 0 ? `${formatBytes(d.progress)} / ${formatBytes(d.total)}` : 'Connecting...'}
                    {d.speed > 0 && d.status === 'downloading' && ` · ${formatBytes(d.speed)}/s`}
                  </span>
                  {/* Pause/Resume button */}
                  {(d.status === 'downloading' || d.status === 'connecting') && (
                    <button onClick={() => handlePause(id)} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-yellow-500 transition-colors" title="Pause" aria-label="Pause">
                      <Pause size={12} />
                    </button>
                  )}
                  {d.status === 'paused' && (
                    <button onClick={() => handleResume(id)} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-green-500 transition-colors" title="Resume" aria-label="Resume">
                      <Play size={12} />
                    </button>
                  )}
                  {/* Cancel button */}
                  <button onClick={() => handleCancel(id)} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-red-500 transition-colors" title="Cancel" aria-label="Cancel">
                    <X size={12} />
                  </button>
                </div>
              </div>
              {d.total > 0 && <ProgressBar progress={(d.progress / d.total) * 100} />}
            </div>
          ))}
        </GlassCard>
      )}

      {/* Download progress moved to DownloadBadge in Header */}

      {!isText && (
        <p className="text-[0.65rem] text-gray-500">
          Downloads install directly into ComfyUI. Requires ComfyUI path configured in Model Manager.
        </p>
      )}

      {/* Sub-tabs: Uncensored / Mainstream — all categories */}
      <div className="flex gap-4 mb-4">
        <button
          onClick={() => setSubTab('uncensored')}
          className={`flex items-center gap-2 transition-all ${
            subTab === 'uncensored' ? 'opacity-100' : 'opacity-40 hover:opacity-70'
          }`}
        >
          <div className={`w-1 h-5 rounded-full ${subTab === 'uncensored' ? 'bg-red-500' : 'bg-red-500/50'}`} />
          <span className="text-[0.75rem] font-semibold text-gray-900 dark:text-white uppercase tracking-wider">Uncensored</span>
          <span className="text-[0.55rem] text-gray-500">{isText ? 'No filters, no limits' : 'No content filter'}</span>
        </button>
        <button
          onClick={() => setSubTab('mainstream')}
          className={`flex items-center gap-2 transition-all ${
            subTab === 'mainstream' ? 'opacity-100' : 'opacity-40 hover:opacity-70'
          }`}
        >
          <div className={`w-1 h-5 rounded-full ${subTab === 'mainstream' ? 'bg-blue-500' : 'bg-blue-500/50'}`} />
          <span className="text-[0.75rem] font-semibold text-gray-900 dark:text-white uppercase tracking-wider">Mainstream</span>
          <span className="text-[0.55rem] text-gray-500">{isText ? 'Tool calling + vision' : 'Popular + high quality'}</span>
        </button>
      </div>

      {/* Model Bundles (Image + Video) — same grid style as text models */}
      {(isImage || isVideo) && filteredBundles.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredBundles.map((bundle, bi) => {
            const complete = isBundleComplete(bundle)
            const downloading = isBundleDownloading(bundle)
            const bundleProgress = getBundleProgress(bundle)

            return (
              <motion.div key={bundle.name} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: bi * 0.03 }}>
                <GlassCard className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                        {complete && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">INSTALLED</span>}
                        {bundle.hot && !complete && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-500 font-bold border border-orange-500/30 shrink-0">HOT</span>}
                        <span className="truncate">{bundle.name}</span>
                      </h3>
                      {bundle.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{bundle.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {bundle.tags.map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{t}</span>
                        ))}
                        {bundle.totalSizeGB && (
                          <span className="text-[10px] text-gray-400">{bundle.totalSizeGB} GB</span>
                        )}
                        <span className="text-[10px] text-gray-400">{bundle.files.length} files</span>
                        {systemVRAM && parseVRAM(bundle.vramRequired) <= systemVRAM && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">Fits GPU</span>
                        )}
                      </div>

                      {downloading && (
                        <div className="mt-2">
                          <ProgressBar progress={bundleProgress} />
                          <p className="text-[10px] text-gray-400 mt-0.5">{Math.round(bundleProgress)}%</p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {complete ? (
                        <span className="text-xs text-green-500 px-2 py-1">Installed</span>
                      ) : downloading ? (
                        <span className="p-2 text-gray-400">
                          <Loader2 size={14} className="animate-spin" />
                        </span>
                      ) : (
                        <button
                          onClick={() => handleBundleInstall(bundle)}
                          className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                          title={`Install all ${bundle.files.length} files (${bundle.totalSizeGB} GB)`}
                        >
                          <Download size={14} />
                        </button>
                      )}
                      {bundle.url && (
                        <a href={bundle.url} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on HuggingFace">
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
            )
          })}
        </div>
      )}

      {/* CivitAI Search (Image & Video) */}
      {(isImage || isVideo) && (
        <GlassCard className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Search CivitAI</h3>
          <div className="flex gap-2">
            <input
              value={civitaiQuery}
              onChange={(e) => setCivitaiQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCivitaiSearch()}
              placeholder="e.g. flux, sdxl realistic, anime..."
              className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
            />
            <button
              onClick={handleCivitaiSearch}
              disabled={civitaiSearching || !civitaiQuery.trim()}
              className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50 text-gray-700 dark:text-white transition-colors"
            >
              {civitaiSearching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>

          {civitaiResults.length > 0 && (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {civitaiResults.map((model) => {
                const dlState = model.filename ? downloads[model.filename] : null
                const isDl = dlState?.status === 'downloading' || dlState?.status === 'connecting'
                const isDone = dlState?.status === 'complete'

                return (
                  <div key={model.id} className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                    {model.thumbnailUrl && (
                      <img src={proxyImageUrl(model.thumbnailUrl)} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" loading="lazy" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{model.name}</span>
                        {model.sizeGB && <span className="text-[10px] text-gray-400 flex-shrink-0">{model.sizeGB} GB</span>}
                      </div>
                      {model.description && <p className="text-[11px] text-gray-500 line-clamp-1 mt-0.5">{model.description}</p>}
                      {isDl && dlState && dlState.total > 0 && (
                        <div className="mt-1.5">
                          <ProgressBar progress={(dlState.progress / dlState.total) * 100} />
                          <span className="text-[10px] text-gray-400">{formatBytes(dlState.progress)} / {formatBytes(dlState.total)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isDone ? (
                        <CheckCircle size={16} className="text-green-500" />
                      ) : isDl ? (
                        <Loader2 size={16} className="animate-spin text-gray-400" />
                      ) : model.downloadUrl ? (
                        <button onClick={() => handleCivitaiDownload(model)} className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all" title="Download" aria-label="Download">
                          <Download size={14} />
                        </button>
                      ) : null}
                      <a href={model.sourceUrl} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on CivitAI" aria-label="View on CivitAI">
                        <ExternalLink size={14} />
                      </a>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {civitaiSearching && <div className="text-center py-4 text-gray-500 text-sm">Searching CivitAI...</div>}
        </GlassCard>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading models...</div>
      ) : isText ? (
        <>
          {/* Active sub-tab content */}
          {subTab === 'uncensored' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredUncensored.map((model, i) => (
                <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} pullModel={pullModel} isPullingModel={isPullingModel} isInstalled={isInstalled} handleDownload={handleDownload} />
              ))}
              {filteredUncensored.length === 0 && (
                <p className="text-center text-gray-500 py-4 col-span-2">No uncensored models match your search</p>
              )}
            </div>
          )}
          {subTab === 'mainstream' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredMainstream.map((model, i) => (
                <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} pullModel={pullModel} isPullingModel={isPullingModel} isInstalled={isInstalled} handleDownload={handleDownload} />
              ))}
              {filteredMainstream.length === 0 && (
                <p className="text-center text-gray-500 py-4 col-span-2">No mainstream models match your search</p>
              )}
            </div>
          )}

          {/* Search Results (only when searching, show extra results not in curated lists) */}
          {search && filtered.filter(m => !uncensoredModels.some(u => u.name === m.name) && !mainstreamModels.some(u => u.name === m.name)).length > 0 && (
            <div className="space-y-3 mt-6">
              <h3 className="text-[0.7rem] font-semibold text-gray-500 uppercase tracking-wider">Search Results</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {filtered.filter(m => !uncensoredModels.some(u => u.name === m.name) && !mainstreamModels.some(u => u.name === m.name)).map((model, i) => (
                  <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} pullModel={pullModel} isPullingModel={isPullingModel} isInstalled={isInstalled} handleDownload={handleDownload} />
                ))}
              </div>
            </div>
          )}
        </>
      ) : !isVideo && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((model, i) => (
            <ModelDiscoverCard key={model.name} model={model} index={i} isText={false} getModelDownloadState={getModelDownloadState} pullModel={pullModel} isPullingModel={isPullingModel} isInstalled={isInstalled} handleDownload={handleDownload} />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && filteredBundles.length === 0 && filteredUncensored.length === 0 && filteredMainstream.length === 0 && (
        <p className="text-center text-gray-500 py-4">No models found</p>
      )}
    </div>
  )
}
