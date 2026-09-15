import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { catalogSavePairs } from './catalog.js'
import { SaveCatalogError } from './errors.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('save-pair catalog', () => {
  it('catalogs only complete atomic pairs with bounded pagination', async () => {
    const root = await fixtureRoot()
    await Promise.all([
      writeFile(path.join(root, 'Alpha.dsv'), 'fictional-alpha-save', 'utf8'),
      writeFile(path.join(root, 'Alpha.server'), 'fictional-alpha-sidecar', 'utf8'),
      writeFile(path.join(root, 'Beta.dsv'), 'fictional-beta-save', 'utf8'),
      writeFile(path.join(root, 'Beta.server'), 'fictional-beta-sidecar', 'utf8')
    ])

    const first = await catalogSavePairs({
      saveRoot: root,
      query: { cursor: null, pageSize: 1 },
      now: new Date('2026-08-30T00:00:00.000Z')
    })
    expect(first.items).toHaveLength(1)
    expect(first.items[0]).toMatchObject({
      name: 'Alpha', health: 'healthy', issues: [], totalBytes: 43
    })
    expect(first.page).toMatchObject({ limit: 1, returned: 1, totalUnits: 2 })
    expect(first.page.nextCursor).not.toBeNull()

    const second = await catalogSavePairs({
      saveRoot: root,
      query: { cursor: first.page.nextCursor, pageSize: 1 },
      now: new Date('2026-08-30T00:00:00.000Z')
    })
    expect(second.items[0]?.name).toBe('Beta')
    expect(second.page.nextCursor).toBeNull()
  })

  it('marks a save with no Nebula sidecar as incomplete', async () => {
    const root = await fixtureRoot()
    await writeFile(path.join(root, 'Missing_Sidecar.dsv'), 'fictional-save', 'utf8')
    const result = await catalogSavePairs({ saveRoot: root })
    expect(result.items).toEqual([
      expect.objectContaining({
        name: 'Missing_Sidecar', health: 'incomplete', issues: ['missing-server'], server: null
      })
    ])
  })

  it('rejects malformed query fields, invalid cursors, and oversized directories', async () => {
    const root = await fixtureRoot()
    await writeFile(path.join(root, 'Only.dsv'), 'fixture', 'utf8')
    await expect(catalogSavePairs({
      saveRoot: root,
      query: { cursor: null, pageSize: 5, path: 'C:\\should-not-be-accepted' }
    })).rejects.toMatchObject({ name: 'ZodError' })
    await expect(catalogSavePairs({
      saveRoot: root,
      query: { cursor: 'not-a-canonical-cursor', pageSize: 5 }
    })).rejects.toBeInstanceOf(SaveCatalogError)
    await expect(catalogSavePairs({
      saveRoot: root,
      maximumDirectoryEntries: 0
    })).rejects.toMatchObject({ code: 'DIRECTORY_ENTRY_LIMIT_EXCEEDED' })
  })

  it('never returns real paths, hashes, or file contents', async () => {
    const root = await fixtureRoot()
    const secretContent = 'content-that-must-never-be-returned'
    await Promise.all([
      writeFile(path.join(root, 'Boundary_Test.dsv'), secretContent, 'utf8'),
      writeFile(path.join(root, 'Boundary_Test.server'), 'private-sidecar-content', 'utf8')
    ])
    const result = await catalogSavePairs({ saveRoot: root })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain(secretContent)
    expect(serialized).not.toContain('private-sidecar-content')
    expect(collectKeys(result)).not.toEqual(expect.arrayContaining(['path', 'root', 'content', 'sha256']))
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-save-catalog-fixture-'))
  temporaryRoots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)])
}
