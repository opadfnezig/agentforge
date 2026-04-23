import { stringify as yamlStringify } from 'yaml'
import { Service, ServiceTemplate } from '../schemas/service.js'

interface ComposeConfig {
  version: string
  name: string
  services: Record<string, ServiceConfig>
  networks: Record<string, NetworkConfig>
  volumes: Record<string, VolumeConfig>
}

interface ServiceConfig {
  image?: string
  build?: {
    context: string
    dockerfile: string
  }
  ports?: string[]
  volumes?: string[]
  environment?: Record<string, string>
  depends_on?: string[] | Record<string, { condition: string }>
  networks?: string[]
  restart?: string
  healthcheck?: {
    test: string[]
    interval: string
    timeout: string
    retries: number
  }
}

interface NetworkConfig {
  name: string
  driver: string
}

interface VolumeConfig {
  driver?: string
}

const serviceTemplates: Record<
  ServiceTemplate,
  (name: string) => ServiceConfig
> = {
  node: (name) => ({
    build: {
      context: `./services/${name}`,
      dockerfile: 'Dockerfile',
    },
    volumes: [
      `./services/${name}:/app`,
      `${name}_node_modules:/app/node_modules`,
    ],
    environment: {
      NODE_ENV: 'development',
    },
    restart: 'unless-stopped',
  }),

  next: (name) => ({
    build: {
      context: `./services/${name}`,
      dockerfile: 'Dockerfile',
    },
    ports: ['3000:3000'],
    volumes: [
      `./services/${name}:/app`,
      `${name}_node_modules:/app/node_modules`,
      `${name}_next:/app/.next`,
    ],
    environment: {
      NODE_ENV: 'development',
    },
    restart: 'unless-stopped',
  }),

  python: (name) => ({
    build: {
      context: `./services/${name}`,
      dockerfile: 'Dockerfile',
    },
    volumes: [`./services/${name}:/app`],
    environment: {
      PYTHONUNBUFFERED: '1',
    },
    restart: 'unless-stopped',
  }),

  go: (name) => ({
    build: {
      context: `./services/${name}`,
      dockerfile: 'Dockerfile',
    },
    volumes: [`./services/${name}:/app`],
    restart: 'unless-stopped',
  }),

  static: (name) => ({
    image: 'nginx:alpine',
    ports: ['80:80'],
    volumes: [`./services/${name}:/usr/share/nginx/html:ro`],
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
    healthcheck: {
      test: ['CMD-SHELL', 'pg_isready -U ${DB_USER:-app}'],
      interval: '5s',
      timeout: '5s',
      retries: 5,
    },
    restart: 'unless-stopped',
  }),

  custom: (name) => ({
    build: {
      context: `./services/${name}`,
      dockerfile: 'Dockerfile',
    },
    volumes: [`./services/${name}:/app`],
    restart: 'unless-stopped',
  }),
}

export const generateComposeConfig = (
  projectSlug: string,
  services: Service[]
): string => {
  const compose: ComposeConfig = {
    version: '3.8',
    name: projectSlug,
    services: {},
    networks: {
      default: {
        name: `${projectSlug}_net`,
        driver: 'bridge',
      },
    },
    volumes: {},
  }

  for (const service of services) {
    const template = serviceTemplates[service.template]
    compose.services[service.name] = template(service.name)

    // Add volumes
    if (service.template === 'node' || service.template === 'next') {
      compose.volumes[`${service.name}_node_modules`] = {}
    }
    if (service.template === 'next') {
      compose.volumes[`${service.name}_next`] = {}
    }
    if (service.template === 'database') {
      compose.volumes['db_data'] = {}
    }
  }

  return yamlStringify(compose)
}

export const generateDockerfile = (template: ServiceTemplate): string => {
  const dockerfiles: Record<ServiceTemplate, string> = {
    node: `FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
`,

    next: `FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
`,

    python: `FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--reload"]
`,

    go: `FROM golang:1.22-alpine

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN go build -o main .

EXPOSE 8080

CMD ["./main"]
`,

    static: `FROM nginx:alpine

COPY . /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`,

    database: '', // No Dockerfile needed for database

    custom: `FROM node:20-alpine

WORKDIR /app

COPY . .

CMD ["node", "index.js"]
`,
  }

  return dockerfiles[template]
}
