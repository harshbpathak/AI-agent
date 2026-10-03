import { ProviderRegistry, ResilientLLM } from 'resilient-llm'

export function coralConfig() {
  return { enabled: Boolean(process.env.CORAL_API_KEY), baseUrl: (process.env.CORAL_BASE_URL || 'https://inference.coralbricks.ai/v1').replace(/\/$/, ''), model: process.env.CORAL_MODEL || 'deepseek-v4-flash-lite', fallbackModel: process.env.CORAL_FALLBACK_MODEL || 'deepseek-v4.1-flash-fast-fp4' }
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Coral response did not contain a JSON object')
  return JSON.parse(candidate.slice(start, end + 1))
}

export async function compileWithCoral(observedEvents) {
  if (!process.env.CORAL_API_KEY) return null
  const { baseUrl, model, fallbackModel } = coralConfig()
  ProviderRegistry.configure('coralbricks', {
    displayName: 'Coral Bricks',
    chatApiUrl: `${baseUrl}/chat/completions`,
    defaultModel: model,
    envVarNames: ['CORAL_API_KEY'],
    authConfig: { type: 'header', headerName: 'Authorization', headerFormat: 'Bearer {key}' },
    chatConfig: { messageFormat: 'openai', responseParsePath: 'choices[0].message.content', toolSchemaType: 'openai' },
  })
  const prompt = `You are a GUI workflow compiler. Convert these observed browser events into a reusable semantic workflow for repeatedly transferring rows from a spreadsheet into a website. Preserve action order and target locator hints. Identify each form field, describe it semantically, use {{field_key}} placeholders for values that come from a spreadsheet, and end with a verification action. Return only valid JSON with this shape: {"name":"string","goal":"string","steps":[{"action":"open_url|find|click|fill|scroll|wait|verify","label":"string","target":"string","field_key":"string or null","expected":"string","recovery":"string or null"}]}. Observed browser events (values are deliberately redacted): ${JSON.stringify(observedEvents)}`
  let lastError
  for (const candidateModel of [...new Set([model, fallbackModel])]) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const resilient = new ResilientLLM({ aiService: 'coralbricks', model: candidateModel, temperature: 0.1, maxTokens: 1400, timeout: 30000, retries: 2, backoffFactor: 2, circuitBreakerConfig: { failureThreshold: 3, cooldownPeriod: 30000 }, rateLimitConfig: { requestsPerMinute: 20, llmTokensPerMinute: 30000 } })
      const result = await resilient.chat([{ role: 'system', content: 'You output strict JSON only.' }, { role: 'user', content: prompt }], { apiKey: process.env.CORAL_API_KEY, aiService: 'coralbricks', model: candidateModel, responseFormat: { type: 'json_object' }, retries: 2, backoffFactor: 2 })
      const parsed = typeof result.content === 'string' ? extractJson(result.content) : result.content
      if (!parsed || !Array.isArray(parsed.steps)) throw new Error('Coral returned no workflow steps')
      return { ...parsed, provider: 'Coral Bricks via ResilientLLM', model: candidateModel, metadata: result.metadata }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}
