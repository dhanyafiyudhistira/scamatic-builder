import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function parseMasterKey(configured, variableName = 'SCADA_CONNECTOR_MASTER_KEY') {
  configured = String(configured || '').trim()
  if (!configured) {
    const error = new Error(`${variableName} is required for encrypted connector and Chart storage secrets.`)
    error.code = 'CONNECTOR_KEY_MISSING'
    throw error
  }
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex')
  if (/^[A-Za-z0-9+/]{43}=?$/.test(configured)) {
    const decoded = Buffer.from(configured, 'base64')
    if (decoded.length === 32) return decoded
  }
  const error = new Error(`${variableName} must be 32-byte base64 or 64-character hex.`)
  error.code = 'CONNECTOR_KEY_INVALID'
  throw error
}

function keyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function masterKeyring() {
  const primary = parseMasterKey(process.env.SCADA_CONNECTOR_MASTER_KEY)
  const candidates = [{ id: keyId(primary), key: primary, primary: true }]
  const previous = String(process.env.SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  for (const [index, value] of previous.entries()) {
    const key = parseMasterKey(value, `SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS entry ${index + 1}`)
    const id = keyId(key)
    if (!candidates.some(candidate => candidate.id === id)) candidates.push({ id, key, primary: false })
  }
  return candidates
}

function encryptBytes(value, key, aad) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()])
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function decryptBytes(record, key, aad) {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()])
  } catch (cause) {
    throw Object.assign(new Error('Encrypted connector secret does not match the configured master key.'), { code: 'CONNECTOR_KEY_MISMATCH', cause })
  }
}

function unwrapDataKey(record, aad) {
  const candidates = masterKeyring()
  const wrappingKeyId = String(record.wrappingKeyId || '')
  const ordered = wrappingKeyId
    ? [...candidates.filter(candidate => candidate.id === wrappingKeyId), ...candidates.filter(candidate => candidate.id !== wrappingKeyId)]
    : candidates
  let lastError
  for (const candidate of ordered) {
    try {
      const dataKey = decryptBytes({ ciphertext: record.wrappedKey, iv: record.wrappedKeyIv, tag: record.wrappedKeyTag }, candidate.key, `${aad}:dek`)
      return { dataKey, key: candidate }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || Object.assign(new Error('No configured master key can unwrap this secret.'), { code: 'CONNECTOR_KEY_MISMATCH' })
}

function encryptDataKey(dataKey, aad) {
  const [primary] = masterKeyring()
  return { ...encryptBytes(dataKey, primary.key, `${aad}:dek`), wrappingKeyId: primary.id }
}

function rewrapDataKey(record, aad) {
  const { dataKey } = unwrapDataKey(record, aad)
  const wrapped = encryptDataKey(dataKey, aad)
  return {
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    wrappedKeyTag: wrapped.tag,
    wrappingKeyId: wrapped.wrappingKeyId,
    keyVersion: 'v1',
  }
}

function inspectDataKey(record, aad) {
  const { key } = unwrapDataKey(record, aad)
  return { compatible: true, primary: key.primary, wrappingKeyId: key.id }
}

export function encryptConnectorSecret(secret, { connectorId, environmentRef }) {
  const aad = `${connectorId}:${environmentRef}:v1`
  const dataKey = randomBytes(32)
  const payload = encryptBytes(Buffer.from(JSON.stringify(secret)), dataKey, aad)
  const wrapped = encryptDataKey(dataKey, aad)
  return {
    payloadCiphertext: payload.ciphertext,
    payloadIv: payload.iv,
    payloadTag: payload.tag,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    wrappedKeyTag: wrapped.tag,
    wrappingKeyId: wrapped.wrappingKeyId,
    keyVersion: 'v1',
  }
}

export function decryptConnectorSecret(record, { connectorId, environmentRef }) {
  const aad = `${connectorId}:${environmentRef}:v1`
  const { dataKey } = unwrapDataKey(record, aad)
  const plaintext = decryptBytes({ ciphertext: record.payloadCiphertext, iv: record.payloadIv, tag: record.payloadTag }, dataKey, aad)
  return JSON.parse(plaintext.toString('utf8'))
}

export function inspectConnectorSecretKey(record, { connectorId, environmentRef }) {
  return inspectDataKey(record, `${connectorId}:${environmentRef}:v1`)
}

export function rewrapConnectorSecretKey(record, { connectorId, environmentRef }) {
  return rewrapDataKey(record, `${connectorId}:${environmentRef}:v1`)
}

export function connectorSecretId(connectorId, environmentRef) {
  return createHash('sha256').update(`${connectorId}:${environmentRef}`).digest('hex')
}

export function encryptChartStorageSecret(secret, { workspaceId }) {
  const aad = `chart-storage:${workspaceId}:v1`
  const dataKey = randomBytes(32)
  const payload = encryptBytes(Buffer.from(JSON.stringify(secret)), dataKey, aad)
  const wrapped = encryptDataKey(dataKey, aad)
  return {
    payloadCiphertext: payload.ciphertext,
    payloadIv: payload.iv,
    payloadTag: payload.tag,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    wrappedKeyTag: wrapped.tag,
    wrappingKeyId: wrapped.wrappingKeyId,
    keyVersion: 'v1',
  }
}

export function decryptChartStorageSecret(record, { workspaceId }) {
  const aad = `chart-storage:${workspaceId}:v1`
  const { dataKey } = unwrapDataKey(record, aad)
  const plaintext = decryptBytes({ ciphertext: record.payloadCiphertext, iv: record.payloadIv, tag: record.payloadTag }, dataKey, aad)
  return JSON.parse(plaintext.toString('utf8'))
}

export function inspectChartStorageSecretKey(record, { workspaceId }) {
  return inspectDataKey(record, `chart-storage:${workspaceId}:v1`)
}

export function rewrapChartStorageSecretKey(record, { workspaceId }) {
  return rewrapDataKey(record, `chart-storage:${workspaceId}:v1`)
}

export function configuredMasterKeyMetadata() {
  const keys = masterKeyring()
  return { primaryKeyId: keys[0].id, configuredKeyCount: keys.length }
}

export function chartStorageSecretId(workspaceId) {
  return createHash('sha256').update(`chart-storage:${workspaceId}`).digest('hex')
}
