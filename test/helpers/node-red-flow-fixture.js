export const GENERIC_NODE_RED_FLOW = Object.freeze([
  { id: 'flow', type: 'tab', label: 'Synthetic import fixture' },
  { id: 'read-plc', type: 's7 in', endpoint: 'plc', mode: 'all', wires: [['format-telemetry']] },
  {
    id: 'format-telemetry',
    type: 'function',
    func: 'msg.payload = { Pump_Running: msg.payload.Pump_Running, Tank_Level: msg.payload.Tank_Level }; return msg;',
    wires: [['telemetry-out']],
  },
  { id: 'telemetry-out', type: 'mqtt out', topic: 'v1/devices/me/telemetry', wires: [] },
  { id: 'rpc-subscription', type: 'mqtt in', topic: 'v1/devices/me/rpc/request/+', wires: [['rpc-parser']] },
  { id: 'rpc-parser', type: 'json', property: 'payload', wires: [['rpc-validator']] },
  {
    id: 'rpc-validator',
    type: 'function',
    outputs: 2,
    func: `const match = /^v1\\/devices\\/me\\/rpc\\/request\\/([^/]+)$/.exec(msg.topic || '')
const request = msg.payload || {}
const booleanMethods = new Set(['setPump_Command', 'setAuto_Mode', 'setManual_Mode', 'setReset'])
const numberMethods = new Set(['setTank_Level'])
let accepted = Boolean(match)
let value = request.params
let error = accepted ? '' : 'Malformed RPC topic'
if (accepted && booleanMethods.has(request.method)) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value
  if (normalized === true || normalized === 1 || normalized === '1' || normalized === 'true') value = true
  else if (normalized === false || normalized === 0 || normalized === '0' || normalized === 'false') value = false
  else { accepted = false; error = 'Boolean params required' }
} else if (accepted && numberMethods.has(request.method)) {
  value = Number(value)
  if (!Number.isFinite(value)) { accepted = false; error = 'Finite number params required' }
} else if (accepted) {
  accepted = false
  error = 'Unsupported RPC method'
}
if (accepted) msg.payload.params = value
const response = {
  ...msg,
  topic: match ? \`v1/devices/me/rpc/response/\${match[1]}\` : '',
  qos: 1,
  retain: false,
  payload: {
    ok: accepted,
    accepted,
    method: String(request.method || ''),
    ...(accepted ? { value } : { error }),
  },
}
return [accepted ? msg : null, match ? response : null]`,
    wires: [['decode-pump', 'decode-level'], ['rpc-response']],
  },
  { id: 'rpc-response', type: 'mqtt out', topic: '', wires: [] },
  {
    id: 'decode-pump',
    type: 'function',
    func: "switch (msg.payload.method) { case 'setPump_Command': msg.payload = msg.payload.params; return msg; default: return null }",
    wires: [['write-pump']],
  },
  { id: 'write-pump', type: 's7 out', endpoint: 'plc', variable: 'Pump_Command', wires: [] },
  {
    id: 'decode-level',
    type: 'function',
    func: "if (msg.payload.method === 'setTank_Level') { msg.payload = msg.payload.params; return msg } return null",
    wires: [['write-level']],
  },
  { id: 'write-level', type: 's7 out', endpoint: 'plc', variable: 'Tank_Level', wires: [] },
  {
    id: 'plc',
    type: 's7 endpoint',
    vartable: [
      { addr: 'Q0.0', name: 'Pump_Running' },
      { addr: 'M0.1', name: 'Pump_Command' },
      { addr: 'MW100', name: 'Tank_Level' },
    ],
  },
])
