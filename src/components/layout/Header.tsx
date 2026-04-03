import { Menu, Settings, Sun, Moon, MessageSquare, Film, Layers, GitCompareArrows, Trophy } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useCompareStore } from '../../stores/compareStore'
import { ModelSelector } from '../models/ModelSelector'

export function Header() {
  const { currentView, toggleSidebar, setView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
  }

  const navBtn = (view: string, icon: React.ReactNode, title: string) => (
    <button
      onClick={() => setView(view as any)}
      className={`p-1.5 rounded-md transition-colors ${
        currentView === view
          ? 'bg-white/10 text-white'
          : 'text-gray-500 hover:text-gray-200 hover:bg-white/5'
      }`}
      title={title}
    >
      {icon}
    </button>
  )

  return (
    <header className="h-10 flex items-center justify-between px-3 border-b border-white/[0.04] bg-[#0e0e0e] z-20">
      {/* Left: Sidebar + Logo */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-white/5 text-gray-500 hover:text-white transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu size={15} />
        </button>
        <button
          onClick={() => {
            useChatStore.getState().setActiveConversation(null)
            setView('chat')
          }}
          className="flex items-center gap-1.5 text-gray-300 hover:text-white transition"
        >
          <img src="/LU-monogram-bw.png" alt="" width={16} height={16} className="dark:invert-0 invert opacity-70" />
          <span className="font-semibold text-[0.7rem] tracking-wide">LUncensored</span>
        </button>
      </div>

      {/* Center: Model Selector */}
      <ModelSelector />

      {/* Right: Nav icons */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors"
          title={settings.theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {settings.theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {navBtn('chat', <MessageSquare size={14} />, 'Chat')}
        <button
          onClick={() => { useCompareStore.getState().setComparing(true); setView('chat') }}
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors"
          title="A/B Compare"
        >
          <GitCompareArrows size={14} />
        </button>
        {navBtn('create', <Film size={14} />, 'Create')}
        <button
          onClick={() => setView('models')}
          className="p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors"
          title="Benchmark Leaderboard"
        >
          <Trophy size={14} />
        </button>
        {navBtn('models', <Layers size={14} />, 'Models')}
        {navBtn('settings', <Settings size={14} />, 'Settings')}
      </div>
    </header>
  )
}
