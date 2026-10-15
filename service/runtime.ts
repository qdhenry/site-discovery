import { OwnerSessions } from './auth.ts'
import { readConfig } from './config.ts'
import { DiscoveryEngine } from './engine.ts'

class ServiceRuntime {
  private runtime:
    Promise<{ engine: DiscoveryEngine; sessions: OwnerSessions }> | undefined
  initialize(port: number) {
    return (this.runtime ??= (async () => {
      const config = readConfig()
      const engine = await DiscoveryEngine.open(config)
      try {
        return { engine, sessions: await OwnerSessions.open(config, port) }
      } catch (error) {
        await engine.close()
        throw error
      }
    })())
  }
  current() {
    return (
      this.runtime ??
      Promise.reject(new Error('Discovery service was not initialized'))
    )
  }
  async close() {
    const current = this.runtime
    this.runtime = undefined
    if (current) await (await current).engine.close()
  }
}
const serviceRuntime = new ServiceRuntime()
export const initializeRuntime = (port: number) =>
  serviceRuntime.initialize(port)
export const currentRuntime = () => serviceRuntime.current()
export const closeRuntime = () => serviceRuntime.close()
