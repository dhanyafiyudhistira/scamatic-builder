import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('local desktop installer inserts first-install commissioning before file installation', async () => {
  const [configuration, template] = await Promise.all([
    read('../src-tauri/tauri.local.conf.json'),
    read('../src-tauri/windows/installer.nsi'),
  ])
  const parsed = JSON.parse(configuration)

  assert.equal(parsed.bundle.windows.nsis.installMode, 'perMachine')
  assert.equal(parsed.bundle.windows.nsis.template, 'windows/installer.nsi')
  assert.equal(parsed.bundle.windows.nsis.installerHooks, 'windows/service-hooks.nsh')
  assert.ok(template.indexOf('SCAMATIC_PAGE_RUNTIME_SETUP') < template.indexOf('MUI_PAGE_INSTFILES'))
})

test('commissioning writes protected machine configuration and verifies readiness', async () => {
  const [hooks, service] = await Promise.all([
    read('../src-tauri/windows/service-hooks.nsh'),
    read('../runtime-service-rs/src/main.rs'),
  ])

  assert.match(hooks, /IfFileExists "\$APPDATA\\SCAMATIC\\runtime\.env" 0 \+2\s+Abort/)
  assert.doesNotMatch(hooks, /"\$COMMONAPPDATA/)
  assert.match(hooks, /\$INSTDIR\\\$\$COMMONAPPDATA\\SCAMATIC\\runtime\.env/)
  assert.match(hooks, /NSD_CreatePassword/)
  assert.match(hooks, /Deployment baru — buat master key baru/)
  assert.match(hooks, /Database existing — gunakan master key deployment lama/)
  assert.match(hooks, /ScamaticMasterKeyConfirmInput/)
  assert.match(hooks, /ScamaticScrollBar/)
  assert.match(hooks, /NSD_TrackBar_SetRangeMax/)
  assert.match(hooks, /SCAMATIC_SCROLL_CONTROL/)
  assert.match(hooks, /NSD_CreateTimer\} ScamaticRuntimeSetupPollScroll 50/)
  assert.match(hooks, /Function ScamaticRuntimeSetupScrollUp/)
  assert.match(hooks, /Function ScamaticRuntimeSetupScrollDown/)
  assert.match(hooks, /NSD_KillTimer\} ScamaticRuntimeSetupPollScroll/)
  assert.match(hooks, /ScamaticValidateHostList/)
  assert.match(hooks, /CONNECTOR_ALLOWED_HOSTS=\$ScamaticConnectorAllowedHosts/)
  assert.match(hooks, /CONNECTOR_ALLOWED_PRIVATE_HOSTS=\$ScamaticConnectorAllowedPrivateHosts/)
  assert.match(hooks, /CHART_MONGO_ALLOWED_HOSTS=\$ScamaticChartMongoAllowedHosts/)
  assert.match(hooks, /CHART_MONGO_ALLOWED_PRIVATE_HOSTS=\$ScamaticChartMongoAllowedPrivateHosts/)
  assert.match(hooks, /CHART_MONGO_ALLOW_SHARED_CLUSTER=false/)
  assert.doesNotMatch(hooks, /CONNECTOR_ALLOWED_PRIVATE_HOSTS=false/)
  assert.match(hooks, /generate-master-key/)
  assert.match(hooks, /SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS=/)
  assert.match(hooks, /SCADA_ADMIN_PASSWORD='\$ScamaticAdminPassword'/)
  assert.doesNotMatch(hooks, /SCADA_ADMIN_PASSWORD=\$\"\$ScamaticAdminPassword/)
  assert.match(hooks, /validate --config/)
  assert.match(hooks, /register-service/)
  assert.match(hooks, /S-1-5-18:\(F\)/)
  assert.match(hooks, /S-1-5-32-544:\(F\)/)
  assert.match(hooks, /wait-ready --timeout-seconds 60/)
  assert.match(hooks, /check-key-compatible/)
  assert.match(hooks, /Fresh silent or passive installation requires a pre-provisioned/)
  assert.match(hooks, /\$PassiveMode = 1/)
  assert.match(hooks, /SetErrorLevel 2/)
  assert.doesNotMatch(hooks, /SCADA_CONNECTOR_MASTER_KEY=[A-Fa-f0-9]{64}/)
  assert.match(service, /"start=",\s+"delayed-auto"/)
  assert.match(service, /service_binary_path\(&executable\)/)
  assert.match(service, /http:\/\/127\.0\.0\.1:3001,http:\/\/localhost:3001/)
  assert.match(service, /SCAMATIC_CANONICAL_LOCAL_ORIGIN/)
  assert.match(service, /SCAMATIC_BIND_HOST", "127\.0\.0\.1/)
  assert.match(service, /NT SERVICE\\SCAMATICRuntime/)
  assert.match(service, /"sidtype", SERVICE_NAME, "unrestricted"/)
  assert.match(service, /grant_service_file_permissions/)
  assert.match(service, /validate_service_configuration\(&layout\)/)
  assert.match(service, /wait_for_port_available/)
  assert.match(service, /query_service_state/)
  assert.match(service, /KEY_COMPATIBILITY_PATH/)
  assert.match(service, /valid_master_key/)
})

test('desktop shell aligns compact branding with menus and enables native zoom shortcuts', async () => {
  const [builder, styles, configuration, capability] = await Promise.all([
    read('../src/BuilderPlatform.jsx'),
    read('../src/builder.css'),
    read('../src-tauri/tauri.conf.json'),
    read('../src-tauri/capabilities/desktop.json'),
  ])
  const parsed = JSON.parse(configuration)
  const permissions = JSON.parse(capability).permissions

  assert.match(builder, /className="sb-brand-name">SB<\/span>/)
  assert.doesNotMatch(builder, /className="sb-brand-name">SCAMATIC/)
  assert.match(builder, /<nav className="sb-header-menus"[\s\S]*?<button[^>]*className="sb-brand"[\s\S]*?<FileMenu/)
  assert.match(styles, /\.sb-brand\s*\{[\s\S]*?min-width:\s*92px;[\s\S]*?width:\s*92px;[\s\S]*?height:\s*35px;/)
  assert.match(styles, /\.sb-header-menus\s*\{[\s\S]*?gap:\s*5px;/)
  assert.match(styles, /\.sb-project-title\s*\{[\s\S]*?left:\s*50%;[\s\S]*?justify-content:\s*center;[\s\S]*?transform:\s*translate\(-50%,\s*-50%\);/)
  assert.doesNotMatch(styles, /@media \(max-width: 1400px\)\s*\{[\s\S]*?\.sb-project-title\s*\{[^}]*position:\s*static/)
  assert.equal(parsed.app.windows[0].zoomHotkeysEnabled, true)
  assert.ok(permissions.includes('core:webview:allow-set-webview-zoom'))
})

test('post-install verifier audits service security without mutating Windows state', async () => {
  const [verifier, packageSource] = await Promise.all([
    read('../scripts/verify-windows-install.ps1'),
    read('../package.json'),
  ])
  const scripts = JSON.parse(packageSource).scripts

  assert.equal(
    scripts['desktop:verify-install'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-install.ps1',
  )
  assert.match(verifier, /Get-CimInstance -ClassName Win32_Service/)
  assert.match(verifier, /DelayedAutoStart/)
  assert.match(verifier, /ServiceSidType/)
  assert.match(verifier, /FailureActionsOnNonCrashFailures/)
  assert.match(verifier, /Get-Acl -LiteralPath \$configFile/)
  assert.match(verifier, /Get-NetTCPConnection -State Listen/)
  assert.match(verifier, /Test-DescendantProcess/)
  assert.match(verifier, /Get-AuthenticodeSignature/)
  assert.match(verifier, /InstallerPath/)
  assert.match(verifier, /ExpectedPublisherThumbprint/)
  assert.match(verifier, /scamatic-desktop\.exe/)
  assert.match(verifier, /scamatic-data-plane\.exe/)
  assert.match(verifier, /Node runtime signature/)
  assert.match(verifier, /Uninstaller signature/)
  assert.match(verifier, /Installer signature/)
  assert.match(verifier, /health\/data-plane\/ready/)
  assert.match(verifier, /health\/data-plane\/key-compatibility/)
  assert.doesNotMatch(verifier, /\b(?:Start|Stop|Restart|Remove|Set|New)-Service\b/)
  assert.doesNotMatch(verifier, /Get-Content\s+[^\r\n]*runtime\.env/i)
})
