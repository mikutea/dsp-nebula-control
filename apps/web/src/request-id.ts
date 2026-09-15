type UiCrypto = Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>

export function createUiRequestId(
  runtimeCrypto: UiCrypto | undefined = typeof window === 'undefined' ? undefined : window.crypto,
  fallbackRandom: () => number = Math.random
): string {
  if (typeof runtimeCrypto?.randomUUID === 'function') return runtimeCrypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof runtimeCrypto?.getRandomValues === 'function') runtimeCrypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(fallbackRandom() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
