import { useEffect, useState } from 'react'
import { IconButton } from './IconButton'
import { CloseIcon, MinusIcon, RestoreIcon, SquareIcon } from './icons'

export const isMac = window.api.window.platform === 'darwin'

/**
 * Riduci / ingrandisci / chiudi, a destra della topbar (Windows e Linux: finestra senza cornice).
 * Su macOS non si mostrano: ci sono i semafori nativi in alto a sinistra.
 */
export function WindowControls(): React.JSX.Element | null {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (isMac) return
    void window.api.window.isMaximized().then((r) => r.ok && setMaximized(r.data))
    return window.api.window.onMaximizedChange(setMaximized)
  }, [])

  if (isMac) return null

  return (
    <div className="ml-1 flex items-center gap-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800" data-testid="window-controls">
      <IconButton tooltip="Riduci a icona" onClick={() => void window.api.window.minimize()}>
        <MinusIcon size={16} />
      </IconButton>
      <IconButton
        tooltip={maximized ? 'Ripristina' : 'Ingrandisci'}
        onClick={() => void window.api.window.toggleMaximize().then((r) => r.ok && setMaximized(r.data))}
      >
        {maximized ? <RestoreIcon size={15} /> : <SquareIcon size={15} />}
      </IconButton>
      <IconButton
        tooltip="Chiudi"
        onClick={() => void window.api.window.close()}
      >
        <CloseIcon size={16} />
      </IconButton>
    </div>
  )
}
