const ALPHANUMERIC = /^[A-Za-z0-9]+$/

export function encodeHardPassword(source) {
  const value = String(source || '')
  if (!value) throw new Error('Enter a source containing letters and numbers.')
  if (!ALPHANUMERIC.test(value)) throw new Error('The encoder accepts letters and numbers only, without spaces or symbols.')

  let output = ''
  for (const run of value.match(/[0-9]+|[A-Za-z]+/g) || []) {
    output += /^[0-9]/.test(run) ? encodeNumberRun(run) : encodeLetterRun(run)
  }
  return output
}

function encodeNumberRun(run) {
  let offset = 0
  return [...run].map(character => {
    if (character === '0') return '0'
    const encoded = String(Number(character) + offset)
    offset += 1
    return encoded
  }).join('')
}

function encodeLetterRun(run) {
  const words = []
  let start = 0
  for (let index = 1; index < run.length; index += 1) {
    if (/[A-Z]/.test(run[index])) {
      words.push(run.slice(start, index))
      start = index
    }
  }
  words.push(run.slice(start))
  return words.map(encodeWord).join('')
}

function encodeWord(word) {
  return [...word].map((character, index) => shiftLetter(character, word.length - index)).join('')
}

function shiftLetter(character, amount) {
  const base = /[A-Z]/.test(character) ? 65 : 97
  return String.fromCharCode(base + ((character.charCodeAt(0) - base + amount) % 26))
}
