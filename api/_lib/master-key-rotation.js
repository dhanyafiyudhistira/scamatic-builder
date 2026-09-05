const WRAPPING_GUARD_FIELDS = [
  'wrappedKey',
  'wrappedKeyIv',
  'wrappedKeyTag',
  'wrappingKeyId',
  'keyVersion',
]

export function guardedRotationFilter(record) {
  if (!record?._id) throw new Error('Encrypted secret record is missing its identifier.')
  const filter = { _id: record._id }
  for (const field of WRAPPING_GUARD_FIELDS) {
    if (Object.hasOwn(record, field)) filter[field] = record[field]
  }
  return filter
}

export function assertRotationWritesMatched(label, result, expected) {
  const matched = Number(result?.matchedCount ?? result?.result?.nMatched ?? -1)
  if (matched !== expected) {
    throw new Error(`${label} changed during master-key rotation; the transaction was aborted and must be retried.`)
  }
}
