export class UpdatePipelineError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'UpdatePipelineError'
    this.code = code
  }
}
