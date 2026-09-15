import { describe, expect, it } from 'vitest'
import { TrustedModArtifactPolicy } from './trusted-mod-artifacts.js'

const reviewedAt = '2026-01-01T00:00:00.000Z'
const expiresAt = '2026-02-01T00:00:00.000Z'
const now = Date.parse('2026-01-10T00:00:00.000Z')
function fixture() {
  return { format: 'dyson-control-trusted-mod-artifacts', schemaVersion: 1,
    policyId: 'fictional-review', reviewedAt, expiresAt,
    packages: [{ dependencyId: 'Example-Plugin-1.0.0', dependencies: ['Example-Dependency-2.0.0'],
      sha256: 'a'.repeat(64), sizeBytes: 2048 }] }
}
const request = { dependencyId: 'Example-Plugin-1.0.0', dependencies: ['Example-Dependency-2.0.0'],
  community: 'dyson-sphere-program', reviewStatus: 'unreviewed', deprecated: false, active: true }

describe('exact reviewed mod artifact policy', () => {
  it('binds a time-limited exact identity, dependency set, digest and size', () => {
    const policy = new TrustedModArtifactPolicy(fixture())
    expect(policy.resolve(request, now)).toMatchObject({ sha256: 'a'.repeat(64), sizeBytes: 2048 })
    expect(policy.revision).toMatch(/^[0-9a-f]{64}$/)
  })
  it.each([
    { dependencyId: 'Example-Plugin-1.0.1' }, { dependencies: [] },
    { dependencies: ['Example-Dependency-2.0.1'] }, { reviewStatus: 'rejected' },
    { community: 'another-game' }, { deprecated: true }, { active: false }
  ])('does not override a different or rejected release: %j', change => {
    expect(new TrustedModArtifactPolicy(fixture()).resolve({ ...request, ...change }, now)).toBeNull()
  })
  it('fails closed before review and at expiry', () => {
    const policy = new TrustedModArtifactPolicy(fixture())
    expect(policy.resolve(request, Date.parse(reviewedAt) - 1)).toBeNull()
    expect(policy.resolve(request, Date.parse(expiresAt))).toBeNull()
  })
  it('rejects duplicate pins and unknown fields', () => {
    const policy = fixture()
    expect(() => new TrustedModArtifactPolicy({ ...policy, packages: [...policy.packages, ...policy.packages] })).toThrow()
    expect(() => new TrustedModArtifactPolicy({ ...policy, allowAll: true })).toThrow()
  })
  it('does not retain mutable caller data or expose internal dependency arrays', () => {
    const input = fixture()
    const policy = new TrustedModArtifactPolicy(input)
    input.packages[0]!.sha256 = 'b'.repeat(64)
    const pin = policy.resolve(request, now)!
    pin.dependencies.push('Example-Injected-1.0.0')
    expect(policy.resolve(request, now)?.sha256).toBe('a'.repeat(64))
    expect(policy.resolve(request, now)?.dependencies).toEqual(request.dependencies)
  })
})
