import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function masterKey() {
  const configured = String(process.env.SCADA_CONNECTOR_MASTER_KEY || '').trim()
  if (!configured) {
    const error = new Error('SCADA_CONNECTOR_MASTER_KEY is required for encrypted connector and Chart storage secrets.')
    error.code = 'CONNECTOR_KEY_MISSING'
    throw error
  }
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex')
  const decoded = Buffer.from(configured, 'base64')
  if (decoded.length === 32) return decoded
  const error = new Error('SCADA_CONNECTOR_MASTER_KEY must be 32-byte base64 or 64-character hex.')
  error.code = 'CONNECTOR_KEY_INVALID'
  throw error
}

function encryptBytes(value, key, aad) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()])
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function decryptBytes(record, key, aad) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()])
}

export function encryptConnectorSecret(secret, { connectorId, environmentRef }) {
  const aad = `${connectorId}:${environmentRef}:v1`
  const dataKey = randomBytes(32)
  const payload = encryptBytes(Buffer.from(JSON.stringify(secret)), dataKey, aad)
  const wrapped = encryptBytes(dataKey, masterKey(), `${aad}:dek`)
  return {
    payloadCiphertext: payload.ciphertext,
    payloadIv: payload.iv,
    payloadTag: payload.tag,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    wrappedKeyTag: wrapped.tag,
    keyVersion: 'v1',
  }
}

export function decryptConnectorSecret(record, { connectorId, environmentRef }) {
  const aad = `${connectorId}:${environmentRef}:v1`
  const dataKey = decryptBytes({ ciphertext: record.wrappedKey, iv: record.wrappedKeyIv, tag: record.wrappedKeyTag }, masterKey(), `${aad}:dek`)
  const plaintext = decryptBytes({ ciphertext: record.payloadCiphertext, iv: record.payloadIv, tag: record.payloadTag }, dataKey, aad)
  return JSON.parse(plaintext.toString('utf8'))
}

export function connectorSecretId(connectorId, environmentRef) {
  return createHash('sha256').update(`${connectorId}:${environmentRef}`).digest('hex')
}

export function encryptChartStorageSecret(secret, { workspaceId }) {
  const aad = `chart-storage:${workspaceId}:v1`
  const dataKey = randomBytes(32)
  const payload = encryptBytes(Buffer.from(JSON.stringify(secret)), dataKey, aad)
  const wrapped = encryptBytes(dataKey, masterKey(), `${aad}:dek`)
  return {
    payloadCiphertext: payload.ciphertext,
    payloadIv: payload.iv,
    payloadTag: payload.tag,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyIv: wrapped.iv,
    wrappedKeyTag: wrapped.tag,
    keyVersion: 'v1',
  }
}

export function decryptChartStorageSecret(record, { workspaceId }) {
  const aad = `chart-storage:${workspaceId}:v1`
  const dataKey = decryptBytes({ ciphertext: record.wrappedKey, iv: record.wrappedKeyIv, tag: record.wrappedKeyTag }, masterKey(), `${aad}:dek`)
  const plaintext = decryptBytes({ ciphertext: record.payloadCiphertext, iv: record.payloadIv, tag: record.payloadTag }, dataKey, aad)
  return JSON.parse(plaintext.toString('utf8'))
}

export function chartStorageSecretId(workspaceId) {
  return createHash('sha256').update(`chart-storage:${workspaceId}`).digest('hex')
}
