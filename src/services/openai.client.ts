import OpenAI from 'openai'
import { wrapOpenAI } from 'langsmith/wrappers/openai'
import { config } from '../config.js'

let client: OpenAI | null = null

export function getOpenAI(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set — transcription, extraction and Q&A cannot run')
  }
  if (!client) {
    const openai = new OpenAI({ apiKey: config.openai.apiKey })
    client = config.langsmith.enabled
      ? (wrapOpenAI(openai, {
          name: 'peermate-openai',
          project_name: config.langsmith.project,
          tags: ['peermate'],
        }) as OpenAI)
      : openai
  }
  return client
}
