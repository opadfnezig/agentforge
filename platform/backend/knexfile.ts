import type { Knex } from 'knex'
import dotenv from 'dotenv'
import { join } from 'path'

dotenv.config({ path: '../../.env' })

const DATABASE_URL = process.env.DATABASE_URL || 'sqlite://./agentforge.db'
const usingSqlite = DATABASE_URL.startsWith('sqlite://')

const config: Knex.Config = usingSqlite
  ? {
      client: 'sqlite3',
      connection: {
        filename: DATABASE_URL.replace('sqlite://', ''),
      },
      useNullAsDefault: true,
      migrations: {
        directory: './src/db/migrations',
        extension: 'ts',
      },
      seeds: {
        directory: './src/db/seeds',
        extension: 'ts',
      },
    }
  : {
      client: 'pg',
      connection: DATABASE_URL,
      migrations: {
        directory: './src/db/migrations',
        extension: 'ts',
      },
      seeds: {
        directory: './src/db/seeds',
        extension: 'ts',
      },
      pool: {
        min: 2,
        max: 10,
      },
    }

export default config
