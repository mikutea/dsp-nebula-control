import { buildApplication } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const application = await buildApplication(config)

const shutdown = async (): Promise<void> => {
  await application.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

await application.app.listen({ host: config.host, port: config.port })
