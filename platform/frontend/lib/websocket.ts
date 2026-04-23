type MessageHandler = (data: unknown) => void

interface WebSocketOptions {
  onMessage: MessageHandler
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Event) => void
  reconnect?: boolean
  reconnectInterval?: number
}

export function createWebSocket(url: string, options: WebSocketOptions) {
  let ws: WebSocket | null = null
  let reconnectTimeout: NodeJS.Timeout | null = null
  let isIntentionallyClosed = false

  const connect = () => {
    if (ws?.readyState === WebSocket.OPEN) return

    const wsUrl = url.startsWith('ws')
      ? url
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${url}`

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      options.onConnect?.()
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        options.onMessage(data)
      } catch {
        options.onMessage(event.data)
      }
    }

    ws.onclose = () => {
      options.onDisconnect?.()

      if (!isIntentionallyClosed && options.reconnect !== false) {
        reconnectTimeout = setTimeout(connect, options.reconnectInterval || 3000)
      }
    }

    ws.onerror = (error) => {
      options.onError?.(error)
    }
  }

  const send = (data: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  const close = () => {
    isIntentionallyClosed = true
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
    }
    ws?.close()
  }

  connect()

  return { send, close }
}

// Build stream WebSocket
export function createBuildStream(
  projectId: string,
  buildId: string,
  handlers: {
    onActionStart?: (data: { actionId: string; runId: string }) => void
    onActionLog?: (data: { runId: string; event: unknown }) => void
    onActionComplete?: (data: { runId: string; status: string }) => void
    onFileChange?: (data: { runId: string; change: unknown }) => void
    onBuildComplete?: (data: { buildId: string; status: string }) => void
    onError?: (error: Event) => void
  }
) {
  return createWebSocket(`/api/projects/${projectId}/build/${buildId}/stream`, {
    onMessage: (data: unknown) => {
      const event = data as { type: string; [key: string]: unknown }

      switch (event.type) {
        case 'action:start':
          handlers.onActionStart?.(event as { type: string; actionId: string; runId: string })
          break
        case 'action:log':
          handlers.onActionLog?.(event as { type: string; runId: string; event: unknown })
          break
        case 'action:complete':
          handlers.onActionComplete?.(event as { type: string; runId: string; status: string })
          break
        case 'file:change':
          handlers.onFileChange?.(event as { type: string; runId: string; change: unknown })
          break
        case 'build:complete':
          handlers.onBuildComplete?.(event as { type: string; buildId: string; status: string })
          break
      }
    },
    onError: handlers.onError,
    reconnect: true,
  })
}

// Chat stream WebSocket
export function createChatStream(
  projectId: string,
  handlers: {
    onChunk?: (content: string) => void
    onComplete?: () => void
    onError?: (error: string) => void
  }
) {
  const ws = createWebSocket(`/api/projects/${projectId}/chat/stream`, {
    onMessage: (data: unknown) => {
      const event = data as { type: string; content?: string; error?: string }

      switch (event.type) {
        case 'chunk':
          if (event.content) handlers.onChunk?.(event.content)
          break
        case 'complete':
          handlers.onComplete?.()
          break
        case 'error':
          handlers.onError?.(event.error || 'Unknown error')
          break
      }
    },
  })

  return {
    send: (message: string, context?: 'project' | 'service', serviceId?: string) => {
      ws.send({ message, context, serviceId })
    },
    close: ws.close,
  }
}
