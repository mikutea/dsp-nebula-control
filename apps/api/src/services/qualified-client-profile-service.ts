import {
  issueQualifiedClientProfileV2,
  type IssuedQualifiedClientProfileArchive,
  type IssuedQualifiedClientProfileReference,
  type IssuedQualifiedClientProfileStore,
  type IssuedQualifiedClientRuntimeArtifact,
  type IssuedQualifiedNebulaClientArchive,
  type ProtectedClientQualificationConsumer,
  type ProtectedClientQualificationStore
} from '../client-profile/index.js'

export interface QualifiedClientProfileService {
  issue(request: unknown): Promise<IssuedQualifiedClientProfileReference>
  readProfileArchive(downloadId: string): Promise<IssuedQualifiedClientProfileArchive>
  readClientPayload(downloadId: string): Promise<IssuedQualifiedNebulaClientArchive>
  readRuntimeArtifact(downloadId: string): Promise<IssuedQualifiedClientRuntimeArtifact>
}

export interface FixedQualifiedClientProfileServiceOptions {
  qualificationStore: ProtectedClientQualificationStore
  qualificationConsumer: ProtectedClientQualificationConsumer
  issuedStore: IssuedQualifiedClientProfileStore
  clock?: () => Date
}

/**
 * Composes verification, replay-ledger consumption, immutable publication and
 * download-time rehashing. No archive bytes are returned by issue().
 */
export class FixedQualifiedClientProfileService implements QualifiedClientProfileService {
  readonly #qualificationStore: ProtectedClientQualificationStore
  readonly #qualificationConsumer: ProtectedClientQualificationConsumer
  readonly #issuedStore: IssuedQualifiedClientProfileStore
  readonly #clock?: () => Date

  constructor(options: FixedQualifiedClientProfileServiceOptions) {
    this.#qualificationStore = options.qualificationStore
    this.#qualificationConsumer = options.qualificationConsumer
    this.#issuedStore = options.issuedStore
    this.#clock = options.clock
  }

  async issue(request: unknown): Promise<IssuedQualifiedClientProfileReference> {
    return await issueQualifiedClientProfileV2(
      request,
      this.#qualificationStore,
      this.#qualificationConsumer,
      this.#issuedStore,
      this.#clock ? { now: this.#clock() } : undefined
    )
  }

  async readProfileArchive(downloadId: string): Promise<IssuedQualifiedClientProfileArchive> {
    return await this.#issuedStore.readArchive(downloadId)
  }

  async readClientPayload(downloadId: string): Promise<IssuedQualifiedNebulaClientArchive> {
    return await this.#issuedStore.readClientPayload(downloadId)
  }

  async readRuntimeArtifact(downloadId: string): Promise<IssuedQualifiedClientRuntimeArtifact> {
    return await this.#issuedStore.readRuntimeArtifact(downloadId)
  }
}
