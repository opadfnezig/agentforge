import { readFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../config.js'
import { Action } from '../schemas/action.js'

// Default templates (fallback if file doesn't exist)
const defaultTemplates: Record<string, string> = {
  start: `# Start Node
This is the entry point of the workflow.
Create /workspace/completion.md to proceed.`,

  end: `# End Node
This is the exit point. Summarize the workflow results.
Create /workspace/completion.md with the summary.`,

  build: `# Build Task
Build the service from specifications.
- Specs: /workspace/.agentforge/specs/
- OpenAPI: /workspace/.agentforge/openapi/
Create /workspace/completion.md when done.`,

  'unit-test': `# Unit Test Task
Run unit tests and fix any failures.
Create /workspace/completion.md with results.`,

  'api-test': `# API Test Task
Run API tests and verify endpoints.
Create /workspace/completion.md with results.`,

  'integration-test': `# Integration Test Task
Run integration tests between services.
Create /workspace/completion.md with results.`,

  'e2e-test': `# E2E Test Task
Run end-to-end tests.
Create /workspace/completion.md with results.`,

  fixer: `# Fix Task
A previous action failed. Check /workspace/.agentforge/error-context.json
Create /workspace/completion.md with the fix summary.`,

  router: `# Router Task
Analyze the failure and output routing decision as JSON.
Create /workspace/completion.md with the analysis.`,

  custom: `# Custom Task
Follow any specific instructions provided.
Create /workspace/completion.md when done.`,
}

/**
 * Load a template for the given action type
 * 1. Try to load from data/templates/{type}.md
 * 2. Fall back to hardcoded default
 * 3. For custom type, use action.config.promptTemplate if provided
 */
export const loadTemplate = async (action: Action): Promise<string> => {
  const actionType = action.type

  // For custom actions, prefer the promptTemplate from config
  if (actionType === 'custom' && action.config?.promptTemplate) {
    return action.config.promptTemplate as string
  }

  // Try to load from file
  const templatePath = join(config.DATA_DIR, 'templates', `${actionType}.md`)

  try {
    const content = await readFile(templatePath, 'utf-8')
    return content
  } catch {
    // File doesn't exist, use default
    return defaultTemplates[actionType] || defaultTemplates.custom
  }
}

/**
 * Get the path to the templates directory
 */
export const getTemplatesDir = (): string => {
  return join(config.DATA_DIR, 'templates')
}

/**
 * List available template types
 */
export const listTemplateTypes = (): string[] => {
  return Object.keys(defaultTemplates)
}
