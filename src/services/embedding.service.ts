import { config } from '../config.js'
import { getOpenAI } from './openai.client.js'

export class EmbeddingService {
  async embed(text: string): Promise<number[]> {
    const [first] = await this.embedAll([text])
    return first ?? []
  }

  async embedAll(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await getOpenAI().embeddings.create({
      model: config.embeddings.model,
      input: texts,
      // Declared in defaults.json since the beginning and never actually sent, so
      // every vector was full-width. text-embedding-3-small is trained to stay
      // meaningful when truncated, and a third of the storage matters once these
      // live in Atlas beside everything else rather than in Chroma's own volume.
      dimensions: config.embeddings.dimension,
    })
    return response.data.map((item) => item.embedding)
  }
}

export const embeddingService = new EmbeddingService()
