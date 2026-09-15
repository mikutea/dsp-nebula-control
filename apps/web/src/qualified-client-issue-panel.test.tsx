// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QualifiedClientIssuePanel } from './QualifiedClientIssuePanel'
import { api, ApiError } from './api'
import type { QualifiedClientProfileIssueReference } from './model'

const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL
const qualificationId = '10000000-0000-0000-0000-000000000001'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl })
})

describe('qualified client issue panel', () => {
  it('issues only an exact V2 qualification request and downloads all three bound artifacts', async () => {
    const issued = issueFixture()
    const issue = vi.spyOn(api, 'issueQualifiedClientProfile').mockResolvedValue({ data: issued })
    const download = vi.spyOn(api, 'downloadQualifiedClientArtifact').mockImplementation(async (_id, kind, expected) => ({
      kind,
      blob: new Blob([kind], { type: kind === 'runtime' ? 'application/json' : 'application/zip' }),
      fileName: kind === 'profile' ? 'dyson-qualified-client-profile.zip'
        : kind === 'client' ? 'dyson-qualified-nebula-client.zip' : 'qualified-client-runtime.json',
      sha256: expected.sha256.replace('sha256:', ''),
      sizeBytes: expected.sizeBytes
    }))
    const createObjectUrl = vi.fn((blob: Blob) => `blob:qualified-${blob.size}-${createObjectUrl.mock.calls.length}`)
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(<QualifiedClientIssuePanel canGenerate />)

    const input = screen.getByLabelText('生产资格 ID')
    fireEvent.change(input, { target: { value: qualificationId.toUpperCase() } })
    fireEvent.click(screen.getByRole('button', { name: '签发客户端套件' }))

    expect(await screen.findByText('Fictional Qualified Server')).toBeTruthy()
    expect(issue).toHaveBeenCalledWith({ schemaVersion: 2, qualificationId })
    expect(screen.getByText('fictional.example.com:443')).toBeTruthy()
    expect(screen.getByText('签发回执已持久化')).toBeTruthy()

    for (const [title, kind] of [
      ['配置资料包', 'profile'], ['客户端运行包', 'client'], ['运行时清单', 'runtime']
    ] as const) {
      const article = screen.getByText(title).closest('article')!
      fireEvent.click(within(article).getByRole('button', { name: '下载' }))
      expect(await within(article).findByRole('button', { name: '重新下载' })).toBeTruthy()
      expect(download).toHaveBeenCalledWith(issued.downloadId, kind, expect.any(Object))
    }
    expect(createObjectUrl).toHaveBeenCalledTimes(3)

    view.unmount()
    expect(revokeObjectUrl).toHaveBeenCalledTimes(3)
  })

  it('fails closed for malformed IDs, read-only roles, and redacts service failures', async () => {
    const issue = vi.spyOn(api, 'issueQualifiedClientProfile')
      .mockRejectedValue(new ApiError(422, '受保护资格未通过验证', 'QUALIFIED_CLIENT_PROFILE_NOT_ISSUED'))
    const view = render(<QualifiedClientIssuePanel canGenerate />)
    const input = screen.getByLabelText('生产资格 ID')
    const button = screen.getByRole('button', { name: '签发客户端套件' })
    fireEvent.change(input, { target: { value: 'not-a-qualification' } })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(issue).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: qualificationId } })
    fireEvent.click(button)
    expect(await screen.findByText(/受保护资格未通过验证.*QUALIFIED_CLIENT_PROFILE_NOT_ISSUED/)).toBeTruthy()
    expect(screen.getByDisplayValue(qualificationId)).toBeTruthy()

    view.unmount()
    render(<QualifiedClientIssuePanel canGenerate={false} />)
    expect(screen.getByText('当前角色只能查看资格签发边界。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '签发客户端套件' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

function issueFixture(): QualifiedClientProfileIssueReference {
  const digest = (character: string) => `sha256:${character.repeat(64)}`
  return {
    downloadId: '20000000-0000-0000-0000-000000000002',
    issueReceiptSha256: digest('f'),
    qualificationId,
    bindingSha256: digest('a'),
    expiresAtUtc: '2099-01-01T00:00:00.000Z',
    metadata: {
      format: 'dyson-control-qualified-client-profile-issue',
      schemaVersion: 1,
      productionQualified: true,
      qualification: {
        qualificationId,
        runId: '30000000-0000-0000-0000-000000000003',
        bindingSha256: digest('a'),
        expiresAtUtc: '2099-01-01T00:00:00.000Z',
        decision: 'qualified',
        blockerCodes: []
      },
      profile: {
        profileId: 'fictional-qualified-profile',
        displayName: 'Fictional Qualified Server',
        connection: {
          protocol: 'nebula', transport: 'wss', topology: 'http-websocket-tunnel', path: '/socket',
          authoritySemantics: 'hostname-preserved', host: 'fictional.example.com', port: 443,
          displayAddress: 'fictional.example.com:443', websocketUrl: 'wss://fictional.example.com:443/socket'
        },
        runtime: {
          dsp: '0.10.0-fixture', nebula: '0.9.0-fixture', bepInEx: '5.4.0-fixture',
          compatibilityEntryId: 'fictional-supported-entry'
        },
        provenance: {
          serverLockSha256: digest('b'), clientParitySha256: digest('c'),
          compatibilityPolicySha256: digest('d'), qualificationDocumentSha256: digest('a')
        },
        requiredModCount: 2,
        optionalModCount: 1
      },
      artifacts: {
        profileArtifactSetSha256: '1'.repeat(64),
        profileArchive: { fileName: 'dyson-qualified-client-profile.zip', mediaType: 'application/zip', sizeBytes: 101, sha256: digest('1') },
        qualifiedClientPayload: { fileName: 'dyson-qualified-nebula-client.zip', mediaType: 'application/zip', sizeBytes: 202, sha256: digest('2') },
        qualifiedRuntime: { entryName: 'qualified-client-runtime.json', mediaType: 'application/json', sizeBytes: 303, sha256: digest('3') }
      }
    },
    archive: { fileName: 'dyson-qualified-client-profile.zip', mediaType: 'application/zip', sizeBytes: 101, sha256: digest('1') }
  }
}
