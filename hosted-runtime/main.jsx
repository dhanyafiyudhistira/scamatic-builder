import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import RuntimeApp from '../src/runtime/RuntimeApp.jsx'
import { initializeThemeTone } from '../src/platform/ThemeTone.jsx'
import '../src/styles.css'
import '../src/builder.css'

initializeThemeTone()
function HostedRuntime() {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/runtime-info', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Hosted runtime is not configured. Check deployment readiness.')
      setInfo(await response.json())
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message) })
    return () => controller.abort()
  }, [])
  if (!info) return <div className="sb-centered-state"><p>{error || 'Preparing hosted runtime…'}</p></div>
  return <RuntimeApp slug={info.slug} hostedOnly />
}
createRoot(document.getElementById('root')).render(<React.StrictMode><HostedRuntime /></React.StrictMode>)
