import { beforeEach, describe, expect, it, vi } from 'vitest'

const asr = {
  url: 'https://dayosalamboi--natlas-voice-api.modal.run/transcribe',
  modalTokenId: 'wk-test',
  modalTokenSecret: 'ws-test',
  language: 'auto' as const,
  minConfidence: 0.35,
  timeoutMs: 5_000,
}

vi.mock('../src/config.js', () => ({ config: { asr } }))
vi.mock('../src/core/logger.js', () => ({ logger: { debug: vi.fn() } }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const { TranscriptionService } = await import('../src/services/transcription.service.js')

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        language: 'yoruba',
        language_confidence: 0.94,
        language_predictions: [{ code: 'yor', confidence: 0.94 }],
        text: ' Ẹ káàbọ̀. ',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
})

const service = () => new TranscriptionService()

describe('the authenticated N-ATLaS request', () => {
  it('sends audio and routing controls as multipart form data', async () => {
    await service().transcribe(Buffer.from('audio'), 'audio/ogg; codecs=opus')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(asr.url)
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual({
      'Modal-Key': 'wk-test',
      'Modal-Secret': 'ws-test',
    })

    const form = request.body as FormData
    expect(form.get('language')).toBe('auto')
    expect(form.get('min_confidence')).toBe('0.35')
    expect(form.get('detect_only')).toBe('false')
    const file = form.get('file') as File
    expect(file.name).toBe('voice-note.ogg')
    expect(file.type).toBe('audio/ogg; codecs=opus')
    expect(await file.text()).toBe('audio')
  })

  it('returns text and keeps language confidence separate from ASR confidence', async () => {
    const heard = await service().transcribe(Buffer.from('audio'), 'audio/wav')

    expect(heard).toEqual({
      text: 'Ẹ káàbọ̀.',
      confidence: null,
      language: 'yoruba',
      languageConfidence: 0.94,
    })
  })
})

describe('failure handling', () => {
  it('surfaces a bounded FastAPI error without exposing credentials', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Use at least 2 seconds of clear speech.' }), {
        status: 400,
      }),
    )

    await expect(service().transcribe(Buffer.from('x'), 'audio/wav')).rejects.toThrow(
      /HTTP 400: Use at least 2 seconds/,
    )
  })

  it('rejects an invalid success response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'missing language' })))
    await expect(service().transcribe(Buffer.from('x'), 'audio/wav')).rejects.toThrow(
      /invalid response/,
    )
  })

  it('enforces the Modal endpoint 20MB limit before uploading', async () => {
    const huge = Buffer.alloc(21 * 1024 * 1024)
    await expect(service().transcribe(huge, 'audio/ogg')).rejects.toThrow(/20MB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
