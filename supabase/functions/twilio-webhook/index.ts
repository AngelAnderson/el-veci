import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/* ──────────────────────────── ENV ──────────────────────────── */
const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
const supabaseKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const openaiKey    = Deno.env.get('OPENAI_API_KEY') || ''
const supabase     = createClient(supabaseUrl, supabaseKey)

const AI_ENABLED   = !!openaiKey
const PAGE_SIZE    = 3

/* ──────────────────────────── TYPES ─────────────────────────── */
type LineKey = '8228' | '7711' | '888' | 'default'
type Json = Record<string, unknown>

interface PlaceRow {
  id: string; name: string; description: string; category: string;
  subcategory: string; one_liner: string; address: string; phone: string;
  gmaps_url: string; contact_info: Json | null; tags: string[];
  vibe: string[]; price_level: string; is_featured: boolean;
  sponsor_weight: number; similarity?: number;
}

interface EventRow {
  id: string; title: string; description: string; location_name: string;
  map_link: string; start_time: string; end_time: string;
  ticket_link: string; price_range: string; vibes: string[];
  similarity?: number;
}

/* ──────────────────────── LINE CONFIG ──────────────────────── */
const LINE_CONFIG: Record<LineKey, { name: string; cta: string; voice: string; personality: string }> = {
  '8228': {
    name: 'CaboRojo Concierge',
    cta: 'Si tienes negocio y quieres aparecer, responde ALIADO.',
    voice: 'Saludos, CaboRojo punto com Concierge. Envíame WhatsApp o SMS.',
    personality: 'Eres el Concierge de CaboRojo.com — guía turístico y local digital de Cabo Rojo, Puerto Rico.',
  },
  '7711': {
    name: 'Empleado Invisible',
    cta: '',
    voice: 'Saludos, habla el Empleado Invisible.',
    personality: 'Eres el Empleado Invisible — un demo de bot para negocios. Muestras cómo un asistente AI puede responder por WhatsApp/SMS.',
  },
  '888': {
    name: 'Veci Nacional',
    cta: '',
    voice: 'Saludos, habla El Veci.',
    personality: 'Eres El Veci — asistente digital de Puerto Rico.',
  },
  default: {
    name: 'El Veci',
    cta: '',
    voice: 'Saludos, habla El Veci.',
    personality: 'Eres El Veci — asistente digital de Puerto Rico.',
  },
}

const SYSTEM_PROMPT = `Eres "El Veci" — el primer asistente local por mensaje con AI de Puerto Rico. Copiloto del Pueblo de Cabo Rojo.

PERSONALIDAD:
- Español casual boricua, usas "veci" como forma cariñosa
- Directo, útil, con sabor local
- Conoces Cabo Rojo como la palma de tu mano

FORMATO OBLIGATORIO:
- MÁXIMO 2-3 oraciones de texto conversacional
- Luego lista los negocios/eventos relevantes en formato compacto
- SMS: nombre + teléfono solamente (ultra breve)
- WhatsApp: nombre + teléfono + emoji (un poco más detallado)
- NUNCA copies la descripción completa de un negocio
- NUNCA excedas 280 caracteres para SMS o 450 para WhatsApp

CAPACIDADES:
- Recomendar restaurantes, negocios, servicios de Cabo Rojo
- Informar sobre eventos locales
- Buscar servicios específicos (plomero, doctor, mecánico, etc.)
- Dar info turística de Cabo Rojo

REGLAS:
- NUNCA inventes negocios o datos que no estén en el contexto
- Si hay resultados, úsalos. Incluye teléfono SIEMPRE que esté disponible
- Si no hay resultados, sugiere otra búsqueda
- Si no sabes algo, dilo con honestidad
- NO uses formato markdown, asteriscos ni negritas — texto plano solamente`

/* ──────────────────────── UTILITIES ────────────────────────── */
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c] || c))
}
function twiml(msg: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(msg)}</Message></Response>`
}
function normalizePhone(v?: string | null) {
  const raw = (v || '').trim()
  return raw.startsWith('whatsapp:') ? raw.replace('whatsapp:', '') : raw
}
function lineFromTo(to?: string | null): LineKey {
  const n = normalizePhone(to)
  if (n.endsWith('8228')) return '8228'
  if (n.endsWith('7711')) return '7711'
  if (n.endsWith('6121')) return '888'
  return 'default'
}
function looksLikeStop(t: string) { return /^(stop|basta|cancel|quit|unsubscribe)$/i.test(t.trim()) }
function looksLikeStart(t: string) { return /^(start|reanudar|resume|unstop)$/i.test(t.trim()) }

function nowPR(): string {
  return new Date().toLocaleString('es-PR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Puerto_Rico'
  })
}

/* ──────────────────── OPENAI HELPERS ──────────────────────── */
async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text, dimensions: 768 }),
  })
  const json = await res.json()
  return json.data?.[0]?.embedding || []
}

async function chatCompletion(messages: Array<{role: string; content: string}>, maxTokens = 200): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  })
  const json = await res.json()
  return json.choices?.[0]?.message?.content || ''
}

/* ────────────────── SEMANTIC SEARCH ───────────────────────── */
async function searchPlaces(embedding: number[], limit = PAGE_SIZE): Promise<PlaceRow[]> {
  const { data, error } = await supabase.rpc('match_places', {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.25,
    match_count: limit,
  })
  if (error) { console.error('match_places error', error); return [] }
  return (data || []) as PlaceRow[]
}

async function searchEvents(embedding: number[], limit = PAGE_SIZE): Promise<EventRow[]> {
  const now = new Date()
  const weekLater = new Date(now.getTime() + 14 * 86400000)
  const { data, error } = await supabase.rpc('match_events', {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.2,
    match_count: limit,
    from_date: now.toISOString(),
    to_date: weekLater.toISOString(),
  })
  if (error) { console.error('match_events error', error); return [] }
  return (data || []) as EventRow[]
}

/* ──────────────── CONVERSATION MEMORY ─────────────────────── */
async function getHistory(contact: string, channel: string): Promise<string> {
  const { data } = await supabase.rpc('get_recent_messages', {
    p_contact: contact,
    p_channel: channel,
    p_limit: 6,
  })
  if (!data || !data.length) return ''
  return data.reverse().map((m: {direction: string; body: string}) =>
    `${m.direction === 'inbound' ? 'Usuario' : 'Veci'}: ${(m.body || '').slice(0, 150)}`
  ).join('\n')
}

/* ──────────────── FORMAT RESULTS (v42 — COMPACT) ─────────── */
function formatPlaces(places: PlaceRow[], channel: string): string {
  return places.map(p => {
    const ph = p.phone || (p.contact_info as Record<string, string>)?.phone || ''
    const liner = (p.one_liner || p.category || '').slice(0, 60)
    if (channel === 'sms') {
      return `${p.name}${ph ? ' ' + ph : ''}`
    }
    return `${p.name} — ${liner}${ph ? '\n  Tel: ' + ph : ''}`
  }).join('\n')
}

function formatEvents(events: EventRow[], channel: string): string {
  return events.map(e => {
    const when = e.start_time ? new Date(e.start_time).toLocaleString('es-PR', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/Puerto_Rico'
    }) : 'Fecha TBD'
    if (channel === 'sms') {
      return `${e.title} — ${when}`
    }
    return `${e.title}${e.location_name ? ' @ ' + e.location_name : ''} — ${when}`
  }).join('\n')
}

/* ──────────── IDENTITY (same as v39) ──────────────────────── */
async function upsertIdentity(params: {
  from: string; channel: string; profileName?: string | null;
  waId?: string | null; direction: 'inbound' | 'outbound'
}) {
  const { data, error } = await supabase.rpc('upsert_person_contact', {
    p_phone: params.from, p_channel: params.channel,
    p_profile_name: params.profileName || null,
    p_wa_id: params.waId || null,
    p_display_name: params.profileName || null,
    p_metadata: {}, p_direction: params.direction,
  })
  if (error || !data?.length) return { person_id: null, contact_id: null }
  const row = data[0] as Record<string, string>
  return {
    person_id: row.person_id || row.out_person_id || null,
    contact_id: row.contact_id || row.out_contact_id || null,
  }
}

async function getPerson(pid: string | null) {
  if (!pid) return null
  const { data } = await supabase.from('people').select('id,is_blocked,metadata').eq('id', pid).single()
  return data as { id: string; is_blocked: boolean; metadata: Json | null } | null
}

async function setBlocked(pid: string, blocked: boolean, reason: string) {
  await supabase.from('people').update({ is_blocked: blocked, block_reason: reason }).eq('id', pid)
}

async function logMessage(p: {
  personId?: string | null; direction: 'inbound' | 'outbound'; channel: string;
  from?: string | null; to?: string | null; body?: string | null;
  messageSid?: string | null; intent?: string | null; rawPayload?: Json; context?: Json;
}) {
  await supabase.from('messages').insert({
    person_id: p.personId || null, direction: p.direction, channel: p.channel,
    from: p.from, to: p.to, body: p.body, message_sid: p.messageSid,
    intent: p.intent, raw_intent: p.context || {}, context: p.context || {},
    source: 'twilio-webhook', raw_payload: p.rawPayload || {},
  })
}

async function touchConversation(p: {
  contact: string; channel: string; line: string;
  personId?: string | null; contactId?: string | null; intent?: string | null;
}) {
  await supabase.from('conversations').upsert({
    contact: p.contact, channel: p.channel, line: p.line,
    person_id: p.personId, contact_id: p.contactId,
    intent: p.intent, last_message_at: new Date().toISOString(),
  }, { onConflict: 'contact,channel,line' })
  await supabase.rpc('increment_message_count', {
    p_contact: p.contact, p_channel: p.channel, p_line: p.line,
  }).catch(() => {})
}

/* ─────────── FALLBACK: keyword intent (from v39) ──────────── */
function keywordFallback(text: string, line: LineKey): string {
  const n = text.toLowerCase().trim()
  if (/^(menu|opciones|ayuda|help|comandos?)$/i.test(n)) {
    return 'Preguntame lo que quieras veci! COMER, RADAR (eventos), CITA (agendar), o pregunta libre. STOP para salir.'
  }
  if (/\b(cita|agenda|angel|reunion)\b/i.test(n)) {
    return 'Dale veci. Dime tema + dia y te envio el link para agendar con Angel.'
  }
  if (/\b(demo|servicio|bot)\b/i.test(n) && line === '7711') {
    return 'Demo express: te lo monto en 90 min con tus FAQs y WhatsApp. Responde con tu negocio + volumen de mensajes.'
  }
  if (/\b(cobro|pago|stripe|precio)\b/i.test(n)) {
    return line === '7711'
      ? 'Planes desde setup + mensualidad. Escribe DEMO y te doy propuesta según tu negocio.'
      : 'Para cobros usamos Stripe/ATH. Dime COBRO y te envío el enlace.'
  }
  return ''
}

/* ═══════════════════ MAIN HANDLER ═════════════════════════ */
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let formData: FormData
  try { formData = await req.formData() } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const body       = (formData.get('Body') || '').toString().trim()
  const from       = (formData.get('From') || '').toString()
  const to         = (formData.get('To') || '').toString()
  const profileName = (formData.get('ProfileName') || '').toString() || null
  const waId       = (formData.get('WaId') || '').toString() || null
  const messageSid = (formData.get('MessageSid') || formData.get('SmsSid') || '').toString() || null
  const callSid    = (formData.get('CallSid') || '').toString() || null
  const msgStatus  = formData.get('MessageStatus') || formData.get('SmsStatus')
  const line       = lineFromTo(to)
  const channel    = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms'
  const cfg        = LINE_CONFIG[line]

  // Voice call
  if (callSid && !body) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="es-US" voice="Polly.Lupe">${cfg.voice}</Say><Record playBeep="true" maxLength="120" timeout="5" /></Response>`,
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }

  // Status callback
  if (!body && msgStatus) return new Response(null, { status: 204 })
  if (!body) return new Response(twiml('Escribeme en texto y te contesto, veci.'), { headers: { 'Content-Type': 'text/xml' } })

  // Identity
  const identity = await upsertIdentity({ from, channel, profileName, waId, direction: 'inbound' })
  await touchConversation({ contact: from, channel, line, personId: identity.person_id, contactId: identity.contact_id })
  const person = await getPerson(identity.person_id)

  // Log inbound
  await logMessage({
    personId: identity.person_id, direction: 'inbound', channel, from, to, body, messageSid,
    context: { line, profileName }, rawPayload: Object.fromEntries(formData.entries()),
  })

  // Block handling
  if (person?.is_blocked) {
    if (looksLikeStart(body)) {
      await setBlocked(person.id, false, 'user_start')
      const msg = 'Bienvenido de vuelta, veci. Escribe lo que necesites.'
      await logMessage({ personId: person.id, direction: 'outbound', channel, from: to, to: from, body: msg, intent: 'unblock' })
      return new Response(twiml(msg), { headers: { 'Content-Type': 'text/xml' } })
    }
    return new Response(null, { status: 204 })
  }

  if (looksLikeStop(body)) {
    if (person?.id) await setBlocked(person.id, true, 'stop_keyword')
    const msg = 'Listo veci, te saqué de mensajes. Si cambias de opinión, escribe START.'
    await logMessage({ personId: person?.id, direction: 'outbound', channel, from: to, to: from, body: msg, intent: 'stop' })
    return new Response(twiml(msg), { headers: { 'Content-Type': 'text/xml' } })
  }

  // ─── AI PATH ────────────────────────────────────────────────
  let reply = ''
  let detectedIntent = 'ai_conversation'

  // First check keyword shortcuts
  const kwReply = keywordFallback(body, line)
  if (kwReply) {
    reply = kwReply
    detectedIntent = 'keyword_shortcut'
  } else if (AI_ENABLED) {
    try {
      // 1. Get embedding of user message
      const embedding = await getEmbedding(body)

      // 2. Search places AND events in parallel
      const [places, events, history] = await Promise.all([
        embedding.length ? searchPlaces(embedding, 5) : Promise.resolve([]),
        embedding.length ? searchEvents(embedding, 3) : Promise.resolve([]),
        getHistory(from, channel),
      ])

      // 3. Build context for AI
      let context = `\n\nFECHA/HORA ACTUAL: ${nowPR()}`
      if (places.length) {
        context += `\n\nNEGOCIOS RELEVANTES:\n${formatPlaces(places, channel)}`
        detectedIntent = 'ai_places'
      }
      if (events.length) {
        context += `\n\nEVENTOS PROXIMOS:\n${formatEvents(events, channel)}`
        detectedIntent = events.length && !places.length ? 'ai_events' : detectedIntent
      }
      if (!places.length && !events.length) {
        context += '\n\nNo encontre resultados relevantes en la base de datos.'
      }

      const historyContext = history ? `\n\nHISTORIAL:\n${history}` : ''
      const maxChars = channel === 'whatsapp' ? 450 : 280

      // 4. Call AI
      const aiMessages = [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${cfg.personality}\n\nCanal: ${channel}. MAXIMO ${maxChars} caracteres.${context}${historyContext}` },
        { role: 'user', content: body },
      ]

      reply = await chatCompletion(aiMessages, channel === 'whatsapp' ? 250 : 150)

      // Hard trim safety net
      if (channel === 'sms' && reply.length > 320) {
        reply = reply.slice(0, 317) + '...'
      }
      if (channel === 'whatsapp' && reply.length > 1500) {
        reply = reply.slice(0, 1497) + '...'
      }
    } catch (err) {
      console.error('AI error:', err)
      reply = `Soy ${cfg.name}. Tengo un problemita tecnico. Escribe MENU para opciones.`
      detectedIntent = 'ai_error'
    }
  } else {
    // No AI key — ultra basic fallback
    reply = `Soy ${cfg.name}. Escríbeme COMER, RADAR, CITA o MENU.`
    detectedIntent = 'fallback_no_ai'
  }

  // Add CTA for public line
  if (cfg.cta && line === '8228') {
    reply = `${reply}\n${cfg.cta}`
  }

  // Update conversation intent
  await supabase.from('conversations').update({ intent: detectedIntent })
    .eq('contact', from).eq('channel', channel).eq('line', line)

  // Log outbound
  await logMessage({
    personId: person?.id || identity.person_id, direction: 'outbound', channel,
    from: to, to: from, body: reply, intent: detectedIntent,
    context: { line, ai_enabled: AI_ENABLED, detected_intent: detectedIntent },
  })

  return new Response(twiml(reply), { headers: { 'Content-Type': 'text/xml' } })
})
