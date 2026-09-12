// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientPackageWorkspace } from './App'
import { api, ApiError } from './api'
import type { GeneratedClientProfile } from './model'

const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectUrl })
})

describe('client package workspace', () => {
  it('reads one local JSON request, previews all six artifacts, downloads ZIP, and revokes its URL', async () => {
    const generated = generatedFixture()
    vi.spyOn(api, 'generateClientProfile').mockResolvedValue({ data: generated })
    vi.spyOn(api, 'downloadClientProfileArchive').mockResolvedValue({
      blob: new Blob(['zip'], { type: 'application/zip' }),
      fileName: 'dyson-client-profile.zip',
      sha256: 'd'.repeat(64),
      sizeBytes: 3
    })
    const createObjectUrl = vi.fn(() => 'blob:client-profile-fixture')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(<ClientPackageWorkspace demo={false} />)

    const request = { schemaVersion: 1, fixture: 'local-only' }
    const file = jsonFile('client-request.json', request)
    fireEvent.change(screen.getByLabelText('选择客户端 Profile 请求 JSON'), {
      target: { files: [file] }
    })
    expect(await screen.findByText('client-request.json')).toBeTruthy()
    expect(screen.getByText(/仅保存在当前浏览器内存/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '生成资料预览' }))
    expect(await screen.findByText('fixture-profile')).toBeTruthy()
    expect(api.generateClientProfile).toHaveBeenCalledWith(request)
    for (const artifact of generated.artifacts) expect(screen.getByText(artifact.entryName)).toBeTruthy()
    expect(screen.getByText('必须安装')).toBeTruthy()
    expect(screen.getByText('可选模组')).toBeTruthy()
    expect(screen.getByText('服务端专用')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '下载客户端 ZIP' }))
    expect(await screen.findByText(/dyson-client-profile\.zip 已交给浏览器下载/)).toBeTruthy()
    expect(screen.getByText(/3 B · 3 字节 · 响应 SHA-256/)).toBeTruthy()
    expect(screen.getByText('d'.repeat(64))).toBeTruthy()
    expect(api.downloadClientProfileArchive).toHaveBeenCalledWith(request)
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:client-profile-fixture')
  })

  it('rejects oversized and non-JSON files before parsing or calling the API', async () => {
    const generate = vi.spyOn(api, 'generateClientProfile')
    render(<ClientPackageWorkspace demo={true} />)
    const input = screen.getByLabelText('选择客户端 Profile 请求 JSON')
    const oversized = {
      name: 'oversized.json',
      size: 2 * 1_024 * 1_024 + 1,
      text: vi.fn(async () => '{}')
    } as unknown as File
    fireEvent.change(input, { target: { files: [oversized] } })
    expect(await screen.findByText('JSON 请求文件不能超过 2 MiB。')).toBeTruthy()
    expect(oversized.text).not.toHaveBeenCalled()

    const dropZone = screen.getByText('选择或拖入客户端生成请求').closest('.client-drop-zone')!
    const wrongFormat = {
      name: 'profile.txt', size: 2, text: vi.fn(async () => '{}')
    } as unknown as File
    fireEvent.drop(dropZone, { dataTransfer: { files: [wrongFormat] } })
    expect(await screen.findByText(/只接受扩展名为 \.json/)).toBeTruthy()
    expect(wrongFormat.text).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('does not prefill production and keeps selected/verified data after a network failure', async () => {
    const generated = generatedFixture()
    const preview = vi.spyOn(api, 'generateClientProfile').mockResolvedValueOnce({ data: generated })
    render(<ClientPackageWorkspace demo={false} />)
    expect(screen.getByText('尚未选择生成请求')).toBeTruthy()
    expect(screen.queryByText('fictional-profile')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '使用虚构示例' }))
    expect(await screen.findByText('fictional-client-profile-request.json')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成资料预览' }))
    expect(await screen.findByText('fixture-profile')).toBeTruthy()

    preview.mockRejectedValueOnce(new ApiError(503, '临时网络失败', 'NETWORK_FIXTURE'))
    fireEvent.click(screen.getByRole('button', { name: '生成资料预览' }))
    expect(await screen.findByText(/临时网络失败/)).toBeTruthy()
    expect(screen.getByText('fixture-profile')).toBeTruthy()
    expect(screen.getByText('fictional-client-profile-request.json')).toBeTruthy()
  })
})

function jsonFile(name: string, value: unknown): File {
  const text = JSON.stringify(value)
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(file, 'text', { configurable: true, value: vi.fn(async () => text) })
  return file
}

function generatedFixture(): GeneratedClientProfile {
  const sha = (character: string) => character.repeat(64)
  const artifacts = [
    ['CHECKSUMS.sha256', 'text/plain'],
    ['INSTALL.md', 'text/markdown'],
    ['client-mod-lock.json', 'application/json'],
    ['client-profile.json', 'application/json'],
    ['parity-report.json', 'application/json'],
    ['verification-checklist.json', 'application/json']
  ].map(([entryName, mediaType], index) => ({
    entryName: entryName!,
    mediaType: mediaType as 'application/json' | 'text/markdown' | 'text/plain',
    encoding: 'utf8' as const,
    sizeBytes: 100 + index,
    sha256: sha(String(index + 1)),
    content: '{}\n'
  }))
  return {
    format: 'dyson-control-client-profile-artifact-set',
    schemaVersion: 1,
    profile: {
      format: 'dyson-control-client-profile',
      schemaVersion: 1,
      profileId: 'fixture-profile',
      displayName: 'Fictional Dyson Server',
      connection: {
        protocol: 'nebula', transport: 'direct', host: 'dsp.example.com', port: 8469,
        displayAddress: 'dsp.example.com:8469'
      },
      runtime: {
        dsp: '0.10.34.28529', nebula: '0.9.22.2', bepInEx: '5.4.17.0',
        compatibilityEntryId: 'supported-example'
      },
      provenance: { serverLockSha256: sha('a'), clientParitySha256: sha('b') },
      mods: {
        required: [{ sourceId: 'thunderstore:Fictional/Required', version: '1.0.0', sha256: sha('c'), requirement: 'required' }],
        optional: [{ sourceId: 'thunderstore:Fictional/Optional', version: '1.0.0', sha256: sha('d'), requirement: 'optional' }]
      }
    },
    clientModLock: {
      format: 'dyson-control-client-mod-lock', schemaVersion: 1,
      serverLockSha256: sha('a'), clientParitySha256: sha('b'), mods: []
    },
    parityReport: {
      format: 'dyson-control-client-parity-report', schemaVersion: 1,
      validManifestPair: true, runtimeCompatible: true, canGenerate: true,
      matchedCompatibilityEntryId: 'supported-example',
      serverLockSha256: sha('a'), clientParitySha256: sha('b'),
      counts: { server: 3, required: 1, optional: 1, notRequired: 1 },
      required: [{ sourceId: 'thunderstore:Fictional/Required', version: '1.0.0', sha256: sha('c') }],
      optional: [{ sourceId: 'thunderstore:Fictional/Optional', version: '1.0.0', sha256: sha('d') }],
      notRequired: [{ sourceId: 'thunderstore:Fictional/ServerOnly', version: '1.0.0', reason: 'server-only' }],
      blockers: [], omittedBlockerCount: 0
    },
    verificationChecklist: {
      format: 'dyson-control-client-verification-checklist', schemaVersion: 1,
      serverLockSha256: sha('a'), checks: [], excluded: []
    },
    artifacts,
    artifactSetSha256: sha('e'),
    totalSizeBytes: artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0)
  }
}
