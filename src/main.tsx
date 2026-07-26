import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')

// No StrictMode: its intentional double-invocation would boot two stages and
// two render loops on top of each other in development.
createRoot(container).render(<App />)
