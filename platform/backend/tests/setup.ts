import { beforeAll, afterAll, vi } from 'vitest'

// Mock environment variables
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = '/tmp/agentforge-test'

// Mock Docker
vi.mock('dockerode', () => ({
  default: vi.fn(() => ({
    getContainer: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
  })),
}))

beforeAll(async () => {
  // Setup test database or mocks
})

afterAll(async () => {
  // Cleanup
})
