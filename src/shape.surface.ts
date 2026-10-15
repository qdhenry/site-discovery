import { makeMicroDotSurface } from '@bespokeagentics/microdots-element'

import { Project, Run, SaveReceipt } from './contract.ts'

export const discoverySurface = makeMicroDotSurface({
  tag: 'site-discovery-shape-source-1',
  attributes: {
    'api-url': { ownership: 'environment', required: true, live: true, description: 'Local Discovery service URL. Context selection only; the service checks the owner session.' },
    'project-id': { ownership: 'host-input', default: 'default', live: true, description: 'Project to open. Never grants project access.' },
    'run-id': { ownership: 'host-input', default: '', live: true, description: 'Saved run to review. Empty opens capture setup and history.' },
  },
  events: {
    'run-selected': { payload: Run },
    'project-selected': { payload: Project },
    'findings-saved': { payload: SaveReceipt },
  },
})
export const surfaces = [discoverySurface]
