import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiRoot = path.join(repositoryRoot, 'apps', 'api')
const distRoot = path.join(apiRoot, 'dist')
const relative = path.relative(apiRoot, distRoot)

if (relative !== 'dist' || path.dirname(distRoot) !== apiRoot) {
  throw new Error('API dist cleanup target is invalid')
}

fs.rmSync(distRoot, { recursive: true, force: true })
