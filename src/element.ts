import { Runtime } from 'foldkit'
import { defineMicroDot } from '@bespokeagentics/microdots-element'

import * as App from './app.ts'
import styles from './styles.css?inline'
import { discoverySurface } from './shape.surface.ts'

export const TAG = discoverySurface.tag
type Handle = Runtime.EmbedHandle<typeof App.ports>
export const defineDiscoveryPanel = (): void => defineMicroDot<Handle, typeof discoverySurface>({
  surface: discoverySurface,
  styles,
  embed: (container, attributes) => Runtime.embed(App.makeElement(container, {
    apiUrl: attributes['api-url'] ?? '', projectId: attributes['project-id'] ?? 'default', runId: attributes['run-id'] ?? '',
  })),
  publish: { 'run-selected': handle => handle.ports.runSelected, 'project-selected': handle => handle.ports.projectSelected, 'findings-saved': handle => handle.ports.findingsSaved },
  receive: {
    'api-url': (handle, value) => { handle.ports.apiChanged.send(value) },
    'project-id': (handle, value) => { handle.ports.projectChanged.send(value) },
    'run-id': (handle, value) => { handle.ports.runChanged.send(value) },
  },
})
