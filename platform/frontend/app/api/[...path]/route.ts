import { NextRequest, NextResponse } from 'next/server'

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3001'

async function proxyRequest(request: NextRequest, path: string[]) {
  const url = `${BACKEND_URL}/api/${path.join('/')}`

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'host') {
      headers.set(key, value)
    }
  })

  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.text()
    : undefined

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
    })

    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      // Strip transfer-encoding — Next.js handles its own chunking
      if (key.toLowerCase() === 'transfer-encoding') return
      responseHeaders.set(key, value)
    })

    // Handle 204 No Content responses specially
    if (response.status === 204) {
      return new NextResponse(null, {
        status: 204,
        headers: responseHeaders,
      })
    }

    // Stream SSE and chunked responses through
    const isSSE = response.headers.get('content-type')?.includes('text/event-stream')
    const isChunked = response.headers.get('transfer-encoding')?.includes('chunked')
    if ((isSSE || isChunked) && response.body) {
      return new NextResponse(response.body as ReadableStream, {
        status: response.status,
        headers: responseHeaders,
      })
    }

    const data = await response.text()

    return new NextResponse(data, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error) {
    console.error('Proxy error:', error)
    return NextResponse.json(
      { error: { message: 'Backend unavailable', code: 'PROXY_ERROR' } },
      { status: 502 }
    )
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyRequest(request, path)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyRequest(request, path)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyRequest(request, path)
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyRequest(request, path)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyRequest(request, path)
}
