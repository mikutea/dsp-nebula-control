export type ObservabilityErrorCode =
  | 'OBSERVABILITY_SAMPLE_INVALID'
  | 'OBSERVABILITY_CPU_CORE_DUPLICATE'
  | 'OBSERVABILITY_CPU_CORE_COUNT_MISMATCH'
  | 'OBSERVABILITY_MEMORY_RANGE_INVALID'
  | 'OBSERVABILITY_VOLUME_RANGE_INVALID'
  | 'OBSERVABILITY_SNAPSHOT_INVALID'
  | 'OBSERVABILITY_HISTORY_LIMIT_INVALID'
  | 'OBSERVABILITY_HISTORY_TIME_REGRESSION'
  | 'OBSERVABILITY_DOWNSAMPLE_LIMIT_INVALID'
  | 'OBSERVABILITY_PERSISTENCE_INVALID'
  | 'OBSERVABILITY_PERSISTENCE_FAILED'

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode

  constructor(code: ObservabilityErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'ObservabilityError'
    this.code = code
  }
}
