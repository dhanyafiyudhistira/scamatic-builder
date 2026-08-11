export async function loadCommandAdmissionReads({ loadProject, loadRuntimeSession, loadDuplicate }) {
  const [project, runtimeSession, duplicate] = await Promise.all([
    loadProject(),
    loadRuntimeSession(),
    loadDuplicate(),
  ])
  return { project, runtimeSession, duplicate }
}

export async function loadLiveCommandReads({
  loadPendingCommand,
  loadSnapshot,
  loadConnector,
  loadEnvironment,
  connectorLookupsEnabled,
}) {
  const connectorContext = connectorLookupsEnabled
    ? Promise.all([loadConnector(), loadEnvironment()])
    : Promise.resolve([null, null])
  const [recent, snapshot, [connector, environment]] = await Promise.all([
    loadPendingCommand(),
    loadSnapshot(),
    connectorContext,
  ])
  return { recent, snapshot, connector, environment }
}
