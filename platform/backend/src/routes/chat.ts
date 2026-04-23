import { Router, Request, Response, NextFunction } from 'express'
import { chatMessageSchema } from '../schemas/api.js'
import { sendChatMessage } from '../services/base-agent.js'
import * as projectQueries from '../db/queries/projects.js'
import * as serviceQueries from '../db/queries/services.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface ChatContext {
  projectId: string
  projectSlug: string
  serviceId?: string
  serviceName?: string
}

export const chatRouter = Router({ mergeParams: true })

// Chat with base agent
chatRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const data = chatMessageSchema.parse(req.body)

    const project = await projectQueries.getProject(projectId)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    let context: ChatContext = { projectId, projectSlug: project.slug }
    if (data.context === 'service' && data.serviceId) {
      const service = await serviceQueries.getService(projectId, data.serviceId)
      if (service) {
        context = { ...context, serviceId: service.id, serviceName: service.name }
      }
    }

    const response = await sendChatMessage(data.message, context)
    logger.info({ projectId }, 'Chat message processed')
    res.json({ response })
  } catch (error) {
    next(error)
  }
})

// Stream chat responses via WebSocket
// TODO: Phase 5 - requires express-ws setup on the main app
// chatRouter.ws('/stream', (ws, req) => {
//   const { projectId } = req.params
//
//   ws.on('message', async (msg) => {
//     try {
//       const data = chatMessageSchema.parse(JSON.parse(msg.toString()))
//       const project = await projectQueries.getProject(projectId)
//       if (!project) {
//         ws.send(JSON.stringify({ error: 'Project not found' }))
//         return
//       }
//
//       let context: ChatContext = { projectId, projectSlug: project.slug }
//       if (data.context === 'service' && data.serviceId) {
//         const service = await serviceQueries.getService(projectId, data.serviceId)
//         if (service) {
//           context = { ...context, serviceId: service.id, serviceName: service.name }
//         }
//       }
//
//       await streamChatResponse(data.message, context, (chunk) => {
//         try {
//           ws.send(JSON.stringify({ type: 'chunk', content: chunk }))
//         } catch {
//           // Client disconnected
//         }
//       })
//
//       ws.send(JSON.stringify({ type: 'complete' }))
//     } catch (error) {
//       logger.error({ error }, 'Chat stream error')
//       ws.send(JSON.stringify({ error: 'Failed to process message' }))
//     }
//   })
// })
