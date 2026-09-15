export interface BepInExAssignment {
  section: string
  key: string
  value: string
  line: number
}

const sectionPattern = /^\s*\[([^\]\r\n]{1,128})\]\s*$/
const assignmentPattern = /^(\s*)([^#;=\r\n][^=\r\n]{0,127}?)(\s*=\s*)(.*)$/

export function parseBepInExAssignments(source: string): BepInExAssignment[] {
  assertConfigSource(source)
  const assignments: BepInExAssignment[] = []
  let section = ''
  for (const [index, line] of splitLines(source).entries()) {
    const sectionMatch = line.match(sectionPattern)
    if (sectionMatch) {
      section = sectionMatch[1]!.trim()
      continue
    }
    if (!section || /^\s*[#;]/.test(line) || /^\s*$/.test(line)) continue
    const assignment = line.match(assignmentPattern)
    if (!assignment) continue
    assignments.push({
      section,
      key: assignment[2]!.trim(),
      value: assignment[4]!.trim(),
      line: index
    })
  }
  return assignments
}

export function findBepInExValue(source: string, section: string, key: string): string | null {
  const normalizedSection = section.toLocaleLowerCase('en-US')
  const normalizedKey = key.toLocaleLowerCase('en-US')
  const matches = parseBepInExAssignments(source).filter((assignment) =>
    assignment.section.toLocaleLowerCase('en-US') === normalizedSection &&
    assignment.key.toLocaleLowerCase('en-US') === normalizedKey
  )
  return matches.at(-1)?.value ?? null
}

export interface BepInExPatch {
  section: string
  key: string
  value: string
}

export function applyBepInExPatches(source: string, patches: readonly BepInExPatch[]): string {
  assertConfigSource(source)
  const seen = new Set<string>()
  for (const patch of patches) {
    assertName(patch.section)
    assertName(patch.key)
    if (/[\r\n\0]/.test(patch.value) || patch.value.length > 512) throw new Error('CONFIG_VALUE_INVALID')
    const identity = `${patch.section.toLocaleLowerCase('en-US')}\0${patch.key.toLocaleLowerCase('en-US')}`
    if (seen.has(identity)) throw new Error('CONFIG_PATCH_DUPLICATE')
    seen.add(identity)
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = source.endsWith('\n')
  const lines = splitLines(source)
  if (hadFinalNewline && lines.at(-1) === '') lines.pop()

  for (const patch of patches) {
    const sections = scanSections(lines)
    const target = sections.find((candidate) => equalName(candidate.name, patch.section))
    let assignmentIndex = -1
    if (target) {
      for (let index = target.start + 1; index < target.end; index += 1) {
        const match = lines[index]!.match(assignmentPattern)
        if (match && equalName(match[2]!.trim(), patch.key)) assignmentIndex = index
      }
    }

    if (assignmentIndex >= 0) {
      const match = lines[assignmentIndex]!.match(assignmentPattern)!
      lines[assignmentIndex] = `${match[1]}${match[2]}${match[3]}${patch.value}`
      continue
    }

    if (target) {
      let insertion = target.end
      while (insertion > target.start + 1 && /^\s*$/.test(lines[insertion - 1]!)) insertion -= 1
      lines.splice(insertion, 0, `${patch.key} = ${patch.value}`)
      continue
    }

    if (lines.length > 0 && !/^\s*$/.test(lines.at(-1)!)) lines.push('')
    lines.push(`[${patch.section}]`, `${patch.key} = ${patch.value}`)
  }

  const rendered = lines.join(newline)
  return hadFinalNewline || rendered.length > 0 ? `${rendered}${newline}` : rendered
}

function splitLines(source: string): string[] {
  return source.split(/\r?\n/)
}

function assertConfigSource(source: string): void {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 512 * 1024 || source.includes('\0')) {
    throw new Error('CONFIG_SOURCE_INVALID')
  }
}

function assertName(value: string): void {
  if (!/^[^\[\]=\r\n\0]{1,128}$/.test(value)) throw new Error('CONFIG_NAME_INVALID')
}

function equalName(left: string, right: string): boolean {
  return left.localeCompare(right, 'en-US', { sensitivity: 'accent' }) === 0
}

interface ScannedSection { name: string; start: number; end: number }

function scanSections(lines: readonly string[]): ScannedSection[] {
  const result: ScannedSection[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(sectionPattern)
    if (!match) continue
    if (result.length > 0) result[result.length - 1]!.end = index
    result.push({ name: match[1]!.trim(), start: index, end: lines.length })
  }
  return result
}
