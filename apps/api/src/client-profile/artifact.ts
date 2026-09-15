import { createHash } from 'node:crypto'
import {
  MAX_CLIENT_PROFILE_ARTIFACT_BYTES,
  MAX_CLIENT_PROFILE_ARTIFACTS,
  MAX_CLIENT_PROFILE_TOTAL_BYTES,
  type ClientProfileArtifact
} from './types.js'

export class ClientProfileArtifactError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ClientProfileArtifactError'
    this.code = code
  }
}

export interface ClientProfileArtifactInput {
  entryName: string
  mediaType: ClientProfileArtifact['mediaType']
  content: string
}

export function buildClientProfileArtifacts(inputs: readonly ClientProfileArtifactInput[]): {
  artifacts: ClientProfileArtifact[]
  artifactSetSha256: string
  totalSizeBytes: number
} {
  if (inputs.length < 1 || inputs.length > MAX_CLIENT_PROFILE_ARTIFACTS) {
    throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_COUNT_INVALID')
  }

  const sorted = [...inputs].sort((left, right) => compareText(left.entryName, right.entryName))
  const normalizedNames = sorted.map((artifact) => assertSafeArtifactEntryName(artifact.entryName).toLowerCase())
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_DUPLICATE')
  }

  let totalSizeBytes = 0
  const artifacts = sorted.map((input): ClientProfileArtifact => {
    const sizeBytes = Buffer.byteLength(input.content, 'utf8')
    if (sizeBytes > MAX_CLIENT_PROFILE_ARTIFACT_BYTES) {
      throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_TOO_LARGE')
    }
    totalSizeBytes += sizeBytes
    if (totalSizeBytes > MAX_CLIENT_PROFILE_TOTAL_BYTES) {
      throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_SET_TOO_LARGE')
    }
    assertPublicArtifactContent(input.content)
    return {
      entryName: input.entryName,
      mediaType: input.mediaType,
      encoding: 'utf8',
      sizeBytes,
      sha256: sha256(input.content),
      content: input.content
    }
  })

  const artifactSetSha256 = sha256(artifacts.map((artifact) =>
    `${artifact.entryName}\u0000${artifact.sizeBytes}\u0000${artifact.sha256}\n`).join(''))
  return { artifacts, artifactSetSha256, totalSizeBytes }
}

export function assertSafeArtifactEntryName(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input) || input.includes('//') || input.endsWith('/')) {
    throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_NAME_INVALID')
  }
  const segments = input.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_NAME_INVALID')
  }
  return input
}

export function assertPublicArtifactContent(content: string): void {
  const forbiddenPatterns = [
    /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/,
    /\\\\[^\s]+\\[^\s]+/,
    /\/(?:home|users|var|etc|opt|srv)\//i,
    /(?:server|remoteaccess)password/i,
    /(?:steam(?:cookie|token|account)|sessionsecret|bridgesecret|player\.key)/i,
    /(?:cookie|authorization)\s*[:=]\s*[^\s]+/i
  ]
  if (forbiddenPatterns.some((pattern) => pattern.test(content))) {
    throw new ClientProfileArtifactError('CLIENT_PROFILE_ARTIFACT_PRIVATE_MATERIAL')
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
