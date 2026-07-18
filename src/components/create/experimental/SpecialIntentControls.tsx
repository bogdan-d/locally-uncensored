// Composer surfaces for the 2.5.8 hosted Create categories (Character-Studio,
// talking character, music, extend, motion). Each intent owns exactly the
// inputs its endpoint consumes; everything stages into createStore slots and
// useCloudCreate submits them. Cloud-only by construction — the IntentBar only
// offers these intents on the cloud backend.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AudioLines, Film, ImagePlus, Mic, Music2, Trash2, Upload, Wand2, X,
} from 'lucide-react'
import { useCreateStore, type CreateIntent, type MediaRef } from '../../../stores/createStore'
import { useCloudCatalogStore, cloudModelById, modelForOp } from '../../../stores/cloudCatalogStore'
import { listLoras, deleteLora, type CloudLora } from '../../../api/cloud/loras'
import { useCreateExp } from './CreateContext'
import { loadImageRef } from './loadImage'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Slider } from '../ui/Slider'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

export function SpecialControls({ intent }: { intent: CreateIntent }) {
  switch (intent) {
    case 'character': return <CharacterPanel />
    case 'lipsync': return <LipsyncControls />
    case 'music': return <MusicControls />
    case 'extend': return <ExtendControls />
    case 'motion': return <MotionControls />
    default: return null
  }
}

// ── shared chip: a small labeled file slot (audio/video/image) ──────────────

function mediaRefFrom(file: File): MediaRef {
  return { name: file.name, url: URL.createObjectURL(file), blob: file }
}

function FileChip({
  icon: Icon,
  empty,
  value,
  accept,
  onFile,
  onClear,
}: {
  icon: typeof Upload
  empty: string
  value: string | null
  accept: string
  onFile: (f: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className={cn(
          't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
          value
            ? 'bg-white/[0.06] border-white/10 text-gray-200'
            : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
        )}
      >
        <Icon size={12} />
        <span className="max-w-[140px] truncate">{value ?? empty}</span>
      </button>
      {value && (
        <button onClick={onClear} className="p-1 text-gray-500 hover:text-gray-300" title="Remove" aria-label="Remove">
          <X size={11} />
        </button>
      )}
    </div>
  )
}

// The character-image slot writes the shared Stage source (an ImageRef with a
// data-URL preview — the cloud upload path re-encodes from it).
function PortraitChip({ empty }: { empty: string }) {
  const source = useCreateStore((s) => s.source)
  const setSource = useCreateStore((s) => s.setSource)
  return (
    <FileChip
      icon={ImagePlus}
      empty={empty}
      value={source ? 'Image ready' : null}
      accept="image/*"
      onFile={(f) => { void loadImageRef(f).then(setSource) }}
      onClear={() => setSource(null)}
    />
  )
}

function DrivingVideoChip({ empty }: { empty: string }) {
  const videoInput = useCreateStore((s) => s.videoInput)
  const setVideoInput = useCreateStore((s) => s.setVideoInput)
  return (
    <FileChip
      icon={Film}
      empty={empty}
      value={videoInput?.name ?? null}
      accept="video/mp4,video/webm,video/quicktime"
      onFile={(f) => setVideoInput(mediaRefFrom(f))}
      onClear={() => setVideoInput(null)}
    />
  )
}

// ── Character-Studio ────────────────────────────────────────────────────────

const FAMILY_LABEL: Record<string, string> = {
  flux: 'Flux',
  'z-image': 'Z-Image',
  'qwen-image': 'Qwen',
  'ltx-2': 'LTX video',
}

function CharacterPanel() {
  const characterTab = useCreateStore((s) => s.characterTab)
  const setCharacterTab = useCreateStore((s) => s.setCharacterTab)
  const triggerWord = useCreateStore((s) => s.triggerWord)
  const setTriggerWord = useCreateStore((s) => s.setTriggerWord)
  const trainImages = useCreateStore((s) => s.trainImages)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const setSelectedCharacter = useCreateStore((s) => s.setSelectedCharacter)
  const charactersVersion = useCreateStore((s) => s.charactersVersion)
  const [shelf, setShelf] = useState<CloudLora[] | null>(null)

  useEffect(() => {
    let live = true
    listLoras()
      .then((l) => { if (live) setShelf(l) })
      .catch(() => { if (live) setShelf([]) })
    return () => { live = false }
  }, [charactersVersion])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center">
        <Segmented
          size="sm"
          layoutId="character-tab"
          value={characterTab}
          onChange={(v) => setCharacterTab(v as 'train' | 'use')}
          options={[
            { value: 'train', label: 'Train new' },
            { value: 'use', label: 'Use character' },
          ]}
        />
      </div>
      {characterTab === 'train' ? (
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <input
            value={triggerWord}
            onChange={(e) => setTriggerWord(e.target.value)}
            placeholder="Trigger word, e.g. davechar"
            className="t-control w-44 px-2.5 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15"
          />
          <span className="t-label text-gray-600">
            {trainImages.length}/30 photos added{trainImages.length < 4 ? ', need at least 4' : ''}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          {shelf === null && <span className="t-label text-gray-600">Loading your characters…</span>}
          {shelf?.length === 0 && (
            <span className="t-label text-gray-600">No characters yet. Train one first.</span>
          )}
          {shelf?.map((c) => {
            const active = selectedCharacter?.id === c.id
            return (
              <div key={c.id} className="flex items-center">
                <button
                  onClick={() =>
                    setSelectedCharacter(
                      active
                        ? null
                        : { id: c.id, name: c.name, triggerWord: c.trigger_word, family: c.base_family },
                    )
                  }
                  className={cn(
                    't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
                    active
                      ? 'bg-white/10 border-white/20 text-white'
                      : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
                  )}
                  title={`Trigger word: ${c.trigger_word}`}
                >
                  <span className="max-w-[110px] truncate">{c.name}</span>
                  <span className="t-label text-gray-500">{FAMILY_LABEL[c.base_family] ?? c.base_family}</span>
                </button>
                <button
                  onClick={() => {
                    void deleteLora(c.id)
                      .then(() => {
                        if (selectedCharacter?.id === c.id) setSelectedCharacter(null)
                        useCreateStore.getState().bumpCharactersVersion()
                      })
                      .catch(() => {})
                  }}
                  className="p-1 text-gray-600 hover:text-red-400"
                  title="Delete character"
                  aria-label="Delete character"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )
          })}
          {selectedCharacter && (
            <span className="t-label text-gray-500 w-full text-center">
              Put “{selectedCharacter.triggerWord}” in your prompt to summon the character.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Talking character (lipsync) ─────────────────────────────────────────────

function LipsyncControls() {
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const audioInput = useCreateStore((s) => s.audioInput)
  const setAudioInput = useCreateStore((s) => s.setAudioInput)
  const voiceFromJob = useCreateStore((s) => s.voiceFromJob)
  const setVoiceFromJob = useCreateStore((s) => s.setVoiceFromJob)
  // Catalog subscription so the chip row re-renders when the live catalog
  // arrives and flips the picked model's source type.
  useCloudCatalogStore((s) => s.fetchedAt)
  const model = cloudModelById(modelForOp('video', 'lipsync', cloudOpModel))
  const needsClip = model?.lipsync_source === 'video'

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      {needsClip ? (
        <DrivingVideoChip empty="Add video to resync" />
      ) : (
        <PortraitChip empty="Add portrait" />
      )}
      <VoiceChip
        audioName={audioInput?.name ?? null}
        voiceLabel={voiceFromJob?.label ?? null}
        onAudioFile={(f) => setAudioInput(mediaRefFrom(f))}
        onPickVoice={(jobId, label) => setVoiceFromJob({ jobId, label })}
        onClear={() => { setAudioInput(null); setVoiceFromJob(null) }}
      />
    </div>
  )
}

const TTS_VOICES = ['cherry', 'serena', 'ethan', 'chelsie'] as const

function VoiceChip({
  audioName,
  voiceLabel,
  onAudioFile,
  onPickVoice,
  onClear,
}: {
  audioName: string | null
  voiceLabel: string | null
  onAudioFile: (f: File) => void
  onPickVoice: (jobId: string, label: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [makerOpen, setMakerOpen] = useState(false)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'speak' | 'design'>('speak')
  const [voice, setVoice] = useState<string>(TTS_VOICES[0])
  const [description, setDescription] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => { setOpen(false); setMakerOpen(false) }, open || makerOpen)
  const { makeVoice } = useCreateExp()
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const audioItems = useCreateStore((s) => s.gallery).filter((g) => g.type === 'audio' && g.jobId)

  const value = audioName ?? voiceLabel
  return (
    <div ref={ref} className="relative flex items-center">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) { onAudioFile(f); setOpen(false) }
          e.target.value = ''
        }}
      />
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
          value
            ? 'bg-white/[0.06] border-white/10 text-gray-200'
            : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
        )}
      >
        <Mic size={12} />
        <span className="max-w-[150px] truncate">{value ?? 'Add voice'}</span>
      </button>
      {value && (
        <button onClick={onClear} className="p-1 text-gray-500 hover:text-gray-300" title="Remove voice" aria-label="Remove voice">
          <X size={11} />
        </button>
      )}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="lu-elevated absolute bottom-full mb-1.5 left-0 z-50 w-72 rounded-lg p-1.5 space-y-1"
          >
            {!makerOpen ? (
              <>
                <button
                  onClick={() => { inputRef.current?.click() }}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Upload size={12} /> Upload an audio file
                </button>
                <button
                  onClick={() => setMakerOpen(true)}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Wand2 size={12} /> Generate a voice (AI)
                </button>
                {audioItems.length > 0 && (
                  <div className="pt-1 border-t border-white/[0.06]">
                    <div className="t-label text-gray-600 px-2.5 py-1">Your generated audio</div>
                    <div className="max-h-36 overflow-y-auto scrollbar-thin">
                      {audioItems.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => {
                            onPickVoice(g.jobId as string, g.prompt.slice(0, 40) || 'Generated audio')
                            setOpen(false)
                          }}
                          className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                        >
                          <AudioLines size={12} />
                          <span className="truncate">{g.prompt || 'Generated audio'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="p-1.5 space-y-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="What should the character say?"
                  rows={2}
                  className="w-full t-control px-2.5 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15 resize-none"
                />
                <div className="flex items-center gap-2">
                  <Segmented
                    size="sm"
                    layoutId="tts-mode"
                    value={mode}
                    onChange={(v) => setMode(v as 'speak' | 'design')}
                    options={[
                      { value: 'speak', label: 'Voice' },
                      { value: 'design', label: 'Describe' },
                    ]}
                  />
                  {mode === 'speak' ? (
                    <select
                      value={voice}
                      onChange={(e) => setVoice(e.target.value)}
                      className="t-control flex-1 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 focus:outline-none"
                    >
                      {TTS_VOICES.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="warm narrator, slight rasp…"
                      className="t-control flex-1 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none"
                    />
                  )}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon={Wand2}
                  disabled={isGenerating || !text.trim()}
                  onClick={() => {
                    void makeVoice({ text, mode, voice, description })
                    setOpen(false)
                    setMakerOpen(false)
                  }}
                >
                  Make voice
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Music ───────────────────────────────────────────────────────────────────

function MusicControls() {
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const setMusicDuration = useCreateStore((s) => s.setMusicDuration)
  const musicLyrics = useCreateStore((s) => s.musicLyrics)
  const setMusicLyrics = useCreateStore((s) => s.setMusicLyrics)
  const [lyricsOpen, setLyricsOpen] = useState(musicLyrics.length > 0)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-center gap-3">
        <div className="w-56">
          <Slider
            label="Length"
            min={5}
            max={240}
            step={5}
            value={musicDuration}
            onChange={setMusicDuration}
            format={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}
          />
        </div>
        <button
          onClick={() => setLyricsOpen((o) => !o)}
          className={cn(
            't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
            lyricsOpen
              ? 'bg-white/[0.06] border-white/10 text-gray-200'
              : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200',
          )}
        >
          <Music2 size={12} /> Lyrics
        </button>
      </div>
      <AnimatePresence>
        {lyricsOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <textarea
              value={musicLyrics}
              onChange={(e) => setMusicLyrics(e.target.value)}
              placeholder="Optional lyrics. Models that sing will use them…"
              rows={3}
              className="w-full t-control px-2.5 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/15 resize-none"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Extend ──────────────────────────────────────────────────────────────────

function ExtendControls() {
  const extendSource = useCreateStore((s) => s.extendSource)
  const setExtendSource = useCreateStore((s) => s.setExtendSource)
  const clips = useCreateStore((s) => s.gallery).filter((g) => g.type === 'video' && g.jobId)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  return (
    <div className="flex items-center justify-center">
      <div ref={ref} className="relative flex items-center">
        <button
          onClick={() => setOpen((o) => !o)}
          className={cn(
            't-control flex items-center gap-1.5 px-2.5 h-[var(--control-h-sm)] rounded-md border transition-colors',
            extendSource
              ? 'bg-white/[0.06] border-white/10 text-gray-200'
              : 'bg-white/[0.03] border-white/[0.06] text-gray-400 hover:text-gray-200 hover:border-white/15',
          )}
        >
          <Film size={12} />
          <span className="max-w-[200px] truncate">
            {extendSource ? extendSource.label : 'Pick one of your cloud videos'}
          </span>
        </button>
        {extendSource && (
          <button onClick={() => setExtendSource(null)} className="p-1 text-gray-500 hover:text-gray-300" title="Clear" aria-label="Clear">
            <X size={11} />
          </button>
        )}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className="lu-elevated absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-50 w-72 rounded-lg p-1 max-h-64 overflow-y-auto scrollbar-thin"
            >
              {clips.length === 0 && (
                <div className="t-control text-gray-500 px-2.5 py-2">
                  No cloud videos yet. Render one on the Video tab first.
                </div>
              )}
              {clips.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setExtendSource({
                      jobId: g.jobId as string,
                      url: g.remoteUrl ?? '',
                      label: g.prompt.slice(0, 40) || 'Cloud video',
                    })
                    setOpen(false)
                  }}
                  className="w-full flex items-center gap-2 t-control text-gray-300 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06]"
                >
                  <Film size={12} />
                  <span className="truncate">{g.prompt || 'Cloud video'}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ── Motion control ──────────────────────────────────────────────────────────

function MotionControls() {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      <PortraitChip empty="Add character image" />
      <DrivingVideoChip empty="Add driving video (dance/pose)" />
    </div>
  )
}
