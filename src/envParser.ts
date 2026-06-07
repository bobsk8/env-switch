/**
 * Parses a .env-format string into a Map<key, value>.
 * Handles: blank lines, comments, `export` prefix, and quoted values.
 */
export function parseEnvContent(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue
    const key = line.slice(0, eqIdx).trim()
    // Only accept valid env variable names
    if (!key || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue
    const rawValue = line.slice(eqIdx + 1)
    result.set(key, unquoteValue(rawValue.trim()))
  }
  return result
}

function unquoteValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === last && (first === '"' || first === "'" || first === '`')) {
      return value.slice(1, -1)
    }
  }
  return value
}
