import { Action } from '../schemas/action.js'
import { Service } from '../schemas/service.js'
import { loadTemplate } from '../services/template-loader.js'

interface PromptContext {
  buildId: string
  projectId: string
}

/**
 * Build prompt for an action
 * Loads template from data/templates/{type}.md and returns it
 * The template itself tells the agent where to find specs, requirements, etc.
 */
export const buildPrompt = async (
  action: Action,
  _service: Service | null,
  _ctx: PromptContext
): Promise<string> => {
  return loadTemplate(action)
}

export const buildComposeGeneratorPrompt = (
  projectName: string,
  services: { name: string; template: string }[]
): string => {
  return `Generate a docker-compose.yml for project "${projectName}" with the following services:

${services.map((s) => `- ${s.name} (${s.template})`).join('\n')}

Follow best practices for Docker Compose configuration.
`
}
