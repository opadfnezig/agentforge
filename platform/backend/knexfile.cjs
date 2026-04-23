const DATABASE_URL = process.env.DATABASE_URL || 'sqlite://./agentforge.db'
const usingSqlite = DATABASE_URL.startsWith('sqlite://')

const config = usingSqlite
  ? {
      client: 'sqlite3',
      connection: {
        filename: DATABASE_URL.replace('sqlite://', ''),
      },
      useNullAsDefault: true,
      migrations: {
        directory: './dist/db/migrations',
        extension: 'js',
      },
      seeds: {
        directory: './dist/db/seeds',
        extension: 'js',
      },
    }
  : {
      client: 'pg',
      connection: DATABASE_URL,
      migrations: {
        directory: './dist/db/migrations',
        extension: 'js',
      },
      seeds: {
        directory: './dist/db/seeds',
        extension: 'js',
      },
      pool: {
        min: 2,
        max: 10,
      },
    }

module.exports = config
