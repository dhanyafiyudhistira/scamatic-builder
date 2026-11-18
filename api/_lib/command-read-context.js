export async function loadCommandAdmissionReads({ loadProject, loadRuntimeSession, loadDuplicate, loadProjectAssignment = async () => undefined }) {
  const [project, runtimeSession, duplicate, projectAssignment] = await Promise.all([
    loadProject(),
    loadRuntimeSession(),
    loadDuplicate(),
    loadProjectAssignment(),
  ])
  return { project, runtimeSession, duplicate, projectAssignment }
}

export async function loadCommandStatusReads({ loadProject, loadRuntimeSession, loadProjectAssignment = async () => undefined }) {
  const [project, runtimeSession, projectAssignment] = await Promise.all([
    loadProject(),
    loadRuntimeSession(),
    loadProjectAssignment(),
  ])
  return { project, runtimeSession, projectAssignment }
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
