const credentialAssignment = /\b(password|passwd|pwd|passphrase|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|cookie|authorization|session(?:[_-]?id)?)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,;]+)/gi
const playerAssignment = /\b(player(?:[\s_-]?(?:name|id))?|steam(?:[\s_-]?(?:name|id))?|user(?:[\s_-]?(?:name|id))?|client(?:[\s_-]?(?:name|id))?|nickname|display[\s_-]?name)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,;]+)/gi
const authorizationValue = /\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g
const url = /\b(?:https?|wss?|ftp):\/\/[^\s<>'"]+/gi
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi
const quotedAbsolutePath = /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n"']+\1/g
const uncPath = /\\\\[^\r\n,;]+/g
const windowsPath = /\b[A-Za-z]:[\\/][^\r\n,;]+/g
const posixPath = /\/(?:[A-Za-z0-9._-]+\/)+[^\r\n,;]*/g
const bracketedIpv6 = /\[[0-9A-F:]{2,}\](?::\d{1,5})?/gi
const unbracketedIpv6 = /[0-9A-F]{0,4}(?::[0-9A-F]{0,4}){2,}/gi
const ipv4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?\b/g
const macAddress = /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi
const localhost = /\blocalhost(?::\d{1,5})?\b/gi
const domain = /\b(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}(?::\d{1,5})?\b/gi
const steamId = /\b7656119\d{10}\b/g
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const namedPlayerEvent = /\b(Player|User|Client)\s+("[^"]{1,64}"|'[^']{1,64}'|[^\s,;:[\]]{1,64})(?=\s+(?:joined|left|connected|disconnected|authenticated|kicked|banned)\b)/gi
const leadingPlayerEvent = /\b[A-Za-z0-9_.-]{2,64}(?=\s+(?:joined|left|connected|disconnected)\b)/gi

export function redactStructuredLogText(input: string): string {
  return input
    .replace(credentialAssignment, (_match, key: string, separator: string) => `${key}${separator}[credential]`)
    .replace(playerAssignment, (_match, key: string, separator: string) => `${key}${separator}[player]`)
    .replace(authorizationValue, (_match, scheme: string) => `${scheme} [credential]`)
    .replace(jwt, '[credential]')
    .replace(url, '[endpoint]')
    .replace(email, '[player]')
    .replace(quotedAbsolutePath, '[path]')
    .replace(uncPath, '[path]')
    .replace(windowsPath, '[path]')
    .replace(posixPath, '[path]')
    .replace(bracketedIpv6, '[endpoint]')
    .replace(unbracketedIpv6, (candidate) => {
      const colonCount = candidate.match(/:/g)?.length ?? 0
      return candidate.includes('::') || colonCount >= 3 ? '[endpoint]' : candidate
    })
    .replace(ipv4, '[endpoint]')
    .replace(macAddress, '[endpoint]')
    .replace(localhost, '[endpoint]')
    .replace(domain, '[endpoint]')
    .replace(steamId, '[player]')
    .replace(uuid, '[player]')
    .replace(namedPlayerEvent, (_match, kind: string) => `${kind} [player]`)
    .replace(leadingPlayerEvent, '[player]')
}

export function redactStructuredLogSource(input: string): string {
  const redacted = redactStructuredLogText(input).trim()
  return redacted.length === 0 ? 'runtime' : redacted.slice(0, 128)
}
