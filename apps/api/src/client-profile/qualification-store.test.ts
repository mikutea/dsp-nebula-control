import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSystemClientQualificationStore } from './index.js'

const qualificationId = '10000000-0000-0000-0000-000000000001'

describe('protected client qualification filesystem store', () => {
  it('reads only fixed qualification children and server-selected raw 32-byte keys', async () => {
    const fixture = await createStoreFixture()
    try {
      const store = await FileSystemClientQualificationStore.open({
        protectedRoot: fixture.materialRoot,
        protectedKeyRingRoot: fixture.keyRingRoot
      })
      await expect(store.readDocument(qualificationId, 'qualification')).resolves.toEqual(
        Buffer.from('{"fixture":true}', 'utf8'))
      await expect(store.readCandidateFile(qualificationId, 'plugin/NebulaNetwork.dll')).resolves.toEqual(
        Buffer.from('candidate-network', 'utf8'))
      await expect(store.readClientFile(qualificationId, 'plugin/NebulaNetwork.dll')).resolves.toEqual(
        Buffer.from('client-network', 'utf8'))
      await expect(store.readClientPackage(qualificationId)).resolves.toEqual(Buffer.from('client-package', 'utf8'))
      await expect(store.resolveHmacKey('collector-key-01')).resolves.toEqual(Buffer.alloc(32, 7))
      await expect(store.resolveHmacKey('con.reserved-key')).resolves.toBeNull()
      await expect(store.resolveHmacKey('short')).resolves.toBeNull()
      await expect(store.readCandidateFile(qualificationId, '../qualification.json')).rejects.toMatchObject({
        code: 'CLIENT_QUALIFICATION_RELATIVE_PATH_INVALID'
      })
      await expect(store.readCandidateFile(qualificationId, 'plugin/CON.dll')).rejects.toMatchObject({
        code: 'CLIENT_QUALIFICATION_RELATIVE_PATH_INVALID'
      })
      await expect(store.readCandidateFile(qualificationId, 'plugin/trailing.')).rejects.toMatchObject({
        code: 'CLIENT_QUALIFICATION_RELATIVE_PATH_INVALID'
      })
      await expect(store.readDocument('../escape', 'qualification')).rejects.toMatchObject({
        code: 'CLIENT_QUALIFICATION_ID_INVALID'
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects a key ring nested under protected qualification material and wrong key sizes', async () => {
    const fixture = await createStoreFixture()
    try {
      const nestedKeys = path.join(fixture.materialRoot, 'nested-keys')
      await mkdir(nestedKeys)
      await expect(FileSystemClientQualificationStore.open({
        protectedRoot: fixture.materialRoot,
        protectedKeyRingRoot: nestedKeys
      })).rejects.toMatchObject({ code: 'CLIENT_QUALIFICATION_KEY_RING_INVALID' })

      await writeFile(path.join(fixture.keyRingRoot, 'bad-size-key.key'), Buffer.alloc(31, 1))
      const store = await FileSystemClientQualificationStore.open({
        protectedRoot: fixture.materialRoot,
        protectedKeyRingRoot: fixture.keyRingRoot
      })
      await expect(store.resolveHmacKey('bad-size-key')).rejects.toMatchObject({
        code: 'CLIENT_QUALIFICATION_HMAC_KEY_INVALID'
      })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

async function createStoreFixture(): Promise<{
  root: string
  materialRoot: string
  keyRingRoot: string
}> {
  const temporaryParent = process.env.TEMP
  if (temporaryParent === undefined) throw new Error('TEMP is required for the test')
  const root = await mkdtemp(path.join(temporaryParent, 'dyson-protected-store-'))
  const materialRoot = path.join(root, 'material')
  const keyRingRoot = path.join(root, 'keys')
  const qualificationRoot = path.join(materialRoot, qualificationId)
  await Promise.all([
    mkdir(path.join(qualificationRoot, 'candidate', 'plugin'), { recursive: true }),
    mkdir(path.join(qualificationRoot, 'client', 'plugin'), { recursive: true }),
    mkdir(keyRingRoot)
  ])
  await Promise.all([
    writeFile(path.join(qualificationRoot, 'qualification.json'), '{"fixture":true}', 'utf8'),
    writeFile(path.join(qualificationRoot, 'candidate', 'plugin', 'NebulaNetwork.dll'), 'candidate-network', 'utf8'),
    writeFile(path.join(qualificationRoot, 'client', 'plugin', 'NebulaNetwork.dll'), 'client-network', 'utf8'),
    writeFile(path.join(qualificationRoot, 'client-package.zip'), 'client-package', 'utf8'),
    writeFile(path.join(keyRingRoot, 'collector-key-01.key'), Buffer.alloc(32, 7))
  ])
  return { root, materialRoot, keyRingRoot }
}
