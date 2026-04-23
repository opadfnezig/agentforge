import { stringify as yamlStringify, parse as yamlParse } from 'yaml'
import { spawn } from 'child_process'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { config } from '../config.js'
import { Project } from '../schemas/project.js'
import { Service, ServiceTemplate } from '../schemas/service.js'
import * as serviceQueries from '../db/queries/services.js'
import { logger } from '../utils/logger.js'


interface ComposeService {
  image?: string
  build?: { context: string; dockerfile: string }
  volumes?: string[]
  ports?: string[]
  environment?: Record<string, string>
  depends_on?: string[] | Record<string, { condition: string }>
  networks?: string[]
  entrypoint?: string[]
  command?: string | string[]
  working_dir?: string
  restart?: string
}

interface ComposeFile {
  version: string
  name: string
  networks: Record<string, { name: string; driver: string }>
  volumes: Record<string, Record<string, unknown>>
  services: Record<string, ComposeService>
}

const getProjectDir = (project: Project) =>
  join(config.DATA_DIR, 'projects', project.slug)

const getTemplateConfig = (
  service: Service
): ComposeService => {
  const templates: Record<ServiceTemplate, () => ComposeService> = {
    node: () => ({
      build: {
        context: `./services/${service.name}`,
        dockerfile: 'Dockerfile',
      },
      volumes: [
        `./services/${service.name}:/app`,
        `${service.name}_modules:/app/node_modules`,
      ],
      environment: {
        NODE_ENV: 'development',
      },
      restart: 'unless-stopped',
    }),

    next: () => ({
      build: {
        context: `./services/${service.name}`,
        dockerfile: 'Dockerfile',
      },
      volumes: [
        `./services/${service.name}:/app`,
        `${service.name}_modules:/app/node_modules`,
        `${service.name}_next:/app/.next`,
      ],
      ports: ['3000:3000'],
      environment: {
        NODE_ENV: 'development',
      },
      restart: 'unless-stopped',
    }),

    python: () => ({
      build: {
        context: `./services/${service.name}`,
        dockerfile: 'Dockerfile',
      },
      volumes: [
        `./services/${service.name}:/app`,
      ],
      environment: {
        PYTHONUNBUFFERED: '1',
      },
      restart: 'unless-stopped',
    }),

    go: () => ({
      build: {
        context: `./services/${service.name}`,
        dockerfile: 'Dockerfile',
      },
      volumes: [
        `./services/${service.name}:/app`,
      ],
      restart: 'unless-stopped',
    }),

    static: () => ({
      image: 'nginx:alpine',
      volumes: [
        `./services/${service.name}:/usr/share/nginx/html:ro`,
      ],
      ports: ['80:80'],
      restart: 'unless-stopped',
    }),

    database: () => ({
      image: 'postgres:16-alpine',
      volumes: ['db_data:/var/lib/postgresql/data'],
      environment: {
        POSTGRES_USER: '${DB_USER:-app}',
        POSTGRES_PASSWORD: '${DB_PASSWORD:-secret}',
        POSTGRES_DB: '${DB_NAME:-app}',
      },
      restart: 'unless-stopped',
    }),

    custom: () => ({
      build: {
        context: `./services/${service.name}`,
        dockerfile: 'Dockerfile',
      },
      volumes: [
        `./services/${service.name}:/app`,
      ],
      restart: 'unless-stopped',
    }),
  }

  return templates[service.template]()
}

export const generateCompose = async (project: Project): Promise<string> => {
  const services = await serviceQueries.listServices(project.id)

  const compose: ComposeFile = {
    version: '3.8',
    name: project.slug,
    networks: {
      default: {
        name: `${project.slug}_net`,
        driver: 'bridge',
      },
    },
    volumes: {},
    services: {},
  }

  for (const service of services) {
    compose.services[service.name] = getTemplateConfig(service)

    // Add volumes for non-database services
    if (service.template !== 'database') {
      if (service.template === 'node' || service.template === 'next') {
        compose.volumes[`${service.name}_modules`] = {}
      }
      if (service.template === 'next') {
        compose.volumes[`${service.name}_next`] = {}
      }
    } else {
      compose.volumes['db_data'] = {}
    }
  }

  const projectDir = getProjectDir(project)
  await mkdir(projectDir, { recursive: true })

  const composeContent = yamlStringify(compose)
  await writeFile(join(projectDir, 'docker-compose.yml'), composeContent)

  return composeContent
}

export const generateAgentCompose = async (
  project: Project,
  _services: Service[],
  targetService: Service
): Promise<string> => {
  const baseCompose = project.composeConfig
    ? yamlParse(project.composeConfig)
    : await generateCompose(project).then(yamlParse)

  // Override target service with agent configuration
  baseCompose.services[targetService.name] = {
    ...baseCompose.services[targetService.name],
    image: config.AGENT_IMAGE,
    entrypoint: ['/bin/bash', '/scripts/run-agent.sh'],
    volumes: [
      ...(baseCompose.services[targetService.name].volumes || []),
      `./services/${targetService.name}:/workspace`,
      `./.agentforge/prompts:/prompts:ro`,
      `./.agentforge/openapi:/shared/openapi:ro`,
      `./services/${targetService.name}/mdspec.md:/specs/mdspec.md:ro`,
      `${targetService.name}_logs:/logs`,
    ],
    environment: {
      ...baseCompose.services[targetService.name].environment,
      ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}',
      SERVICE_NAME: targetService.name,
    },
  }

  baseCompose.volumes[`${targetService.name}_logs`] = {}

  const projectDir = getProjectDir(project)
  const content = yamlStringify(baseCompose)
  await writeFile(join(projectDir, 'docker-compose.agent.yml'), content)

  return content
}

const runDockerCompose = (
  projectDir: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['compose', ...args], {
      cwd: projectDir,
      env: { ...process.env, ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({ code: code || 0, stdout, stderr })
    })

    proc.on('error', reject)
  })
}

export const startContainers = async (project: Project): Promise<void> => {
  const projectDir = getProjectDir(project)
  logger.info({ projectDir }, 'Starting containers')

  const result = await runDockerCompose(projectDir, ['up', '-d', '--build'])
  if (result.code !== 0) {
    logger.error({ stderr: result.stderr }, 'Failed to start containers')
    throw new Error(`Failed to start containers: ${result.stderr}`)
  }
}

export const stopContainers = async (project: Project): Promise<void> => {
  const projectDir = getProjectDir(project)
  logger.info({ projectDir }, 'Stopping containers')

  const result = await runDockerCompose(projectDir, ['down'])
  if (result.code !== 0) {
    logger.error({ stderr: result.stderr }, 'Failed to stop containers')
    throw new Error(`Failed to stop containers: ${result.stderr}`)
  }
}

export const rebuildContainers = async (project: Project): Promise<void> => {
  await stopContainers(project)
  await startContainers(project)
}

export const getContainerLogs = async (
  project: Project,
  serviceName: string,
  tail = 100
): Promise<string> => {
  const projectDir = getProjectDir(project)
  const result = await runDockerCompose(projectDir, [
    'logs',
    '--tail',
    tail.toString(),
    serviceName,
  ])
  return result.stdout + result.stderr
}

export const execInContainer = async (
  project: Project,
  serviceName: string,
  command: string[]
): Promise<{ stdout: string; stderr: string }> => {
  const projectDir = getProjectDir(project)
  const result = await runDockerCompose(projectDir, [
    'exec',
    '-T',
    serviceName,
    ...command,
  ])
  return { stdout: result.stdout, stderr: result.stderr }
}
