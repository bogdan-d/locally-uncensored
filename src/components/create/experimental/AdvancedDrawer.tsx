import { Drawer } from '../ui/Drawer'
import { ParamGroups } from './ParamGroups'

export function AdvancedDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title="Advanced settings" width={320}>
      <ParamGroups />
    </Drawer>
  )
}
