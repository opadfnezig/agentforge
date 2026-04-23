import { readdir, readFile, stat } from 'fs/promises'
import { join, relative } from 'path'
import { config } from '../config.js'
import { AppError } from '../utils/error-handler.js'

interface FileInfo {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: Date
}

const getProjectDir = (_projectId: string) =>
  join(config.DATA_DIR, 'projects')

export const getProjectFiles = async (
  projectId: string,
  subPath?: string
): Promise<FileInfo[]> => {
  const baseDir = getProjectDir(projectId)
  const targetDir = subPath ? join(baseDir, subPath) : baseDir

  try {
    const entries = await readdir(targetDir, { withFileTypes: true })
    const files: FileInfo[] = []

    for (const entry of entries) {
      // Skip hidden files and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue
      }

      const fullPath = join(targetDir, entry.name)
      const relativePath = relative(baseDir, fullPath)

      if (entry.isDirectory()) {
        files.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
        })
      } else {
        try {
          const stats = await stat(fullPath)
          files.push({
            name: entry.name,
            path: relativePath,
            type: 'file',
            size: stats.size,
            modified: stats.mtime,
          })
        } catch {
          files.push({
            name: entry.name,
            path: relativePath,
            type: 'file',
          })
        }
      }
    }

    return files.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export const getFileContent = async (
  projectId: string,
  serviceDir: string,
  filePath: string
): Promise<string> => {
  const baseDir = getProjectDir(projectId)
  const fullPath = join(baseDir, serviceDir, filePath)

  // Security check - ensure path doesn't escape project directory
  const resolved = join(baseDir, serviceDir, filePath)
  if (!resolved.startsWith(baseDir)) {
    throw new AppError(403, 'Access denied', 'PATH_TRAVERSAL')
  }

  try {
    const content = await readFile(fullPath, 'utf-8')
    return content
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError(404, 'File not found', 'FILE_NOT_FOUND')
    }
    throw error
  }
}

export const getFilesRecursive = async (
  dir: string,
  baseDir: string,
  maxDepth = 5,
  currentDepth = 0
): Promise<FileInfo[]> => {
  if (currentDepth >= maxDepth) return []

  const files: FileInfo[] = []

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue
      }

      const fullPath = join(dir, entry.name)
      const relativePath = relative(baseDir, fullPath)

      if (entry.isDirectory()) {
        files.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
        })

        const subFiles = await getFilesRecursive(
          fullPath,
          baseDir,
          maxDepth,
          currentDepth + 1
        )
        files.push(...subFiles)
      } else {
        files.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
        })
      }
    }
  } catch {
    // Directory doesn't exist or not accessible
  }

  return files
}
