import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './builder.css'
import { initializeThemeTone } from './platform/ThemeTone.jsx'

initializeThemeTone()

const path = window.location.pathname
const runtimeMatch = path.match(/^\/runtime\/([^/]+)\/?$/)
const RootApp = runtimeMatch
  ? lazy(() => import('./runtime/RuntimeApp.jsx'))
  : path === '/legacy'
    ? lazy(() => import('./App.jsx'))
    : lazy(() => import('./BuilderPlatform.jsx'))

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<div className="sb-centered-state"><span className="sb-spinner" /><p>Loading application…</p></div>}><RootApp {...(runtimeMatch ? { slug: decodeURIComponent(runtimeMatch[1]) } : {})} /></Suspense>
  </React.StrictMode>
)
