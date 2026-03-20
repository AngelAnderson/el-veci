import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const openaiKey = Deno.env.get('OPENAI_API_KEY') || ''
const AI_ENABLED = !!openaiKey

type LineKey = '8228' | '7711' | '888' | 'default'
type Json = Record<string, unknown>

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;')
}
function twiml(msg: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(msg)}</Message></Response>`
}
function lineFromTo(to: string): LineKey {
  const n = to.replace('whatsapp:', '').trim()
  if (n.endsWith('8228')) return '8228'
  if (n.endsWith('7711')) return '7711'
  if (n.endsWith('6121')) return '888'
  return 'default'
}

async function getConvId(contact: string, channel: string, line: string, personId: string | null): Promise<string | null> {
  const { data } = await supabase.from('conversations')
    .upsert({ contact, channel, line, person_id: personId, last_message_at: new Date().toISOString() },
      { onConflict: 'contact,channel,line' })
    .select('id').single()
  if (data) return data.id
  const { data: fb } = await supabase.from('conversations').select('id').eq('contact', contact).eq('channel', channel).eq('line', line).single()
  return fb?.id || null
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  try {
    const formData = await req.formData()
    const body = (formData.get('Body') || '').toString().trim()
    const from = (formData.get('From') || '').toString()
    const to = (formData.get('To') || '').toString()
    const messageSid = (formData.get('MessageSid') || '').toString()
    const callSid = (formData.get('CallSid') || '').toString()
    const msgStatus = formData.get('MessageStatus')
    const channel = from.startsWith('whatsapp:') ? 'whatsapp' : 'sms'
    const line = lineFromTo(to)

    if (callSid && !body) {
      return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="es-US" voice="Polly.Lupe">Saludos, habla El Veci.</Say></Response>', { headers: { 'Content-Type': 'text/xml' } })
    }
    if (!body && msgStatus) return new Response(null, { status: 204 })
    if (!body) return new Response(twiml('Escribeme en texto y te contesto, veci.'), { headers: { 'Content-Type': 'text/xml' } })

    // Identity
    const { data: idData } = await supabase.rpc('upsert_person_contact', {
      p_phone: from, p_channel: channel, p_profile_name: null, p_wa_id: null,
      p_display_name: null, p_metadata: {}, p_direction: 'inbound',
    })
    const personId = idData?.[0]?.out_person_id || null

    // Conversation
    const convId = await getConvId(from, channel, line, personId)

    // Log inbound
    if (convId) {
      await supabase.from('messages').insert({
        conversation_id: convId, person_id: personId, direction: 'inbound',
        channel, from, to, body, message_sid: messageSid,
        intent: null, raw_intent: {}, context: {}, source: 'twilio-webhook', raw_payload: {},
      })
    }

    // Check blocked
    let blocked = false
    if (personId) {
      const { data: person } = await supabase.from('people').select('is_blocked').eq('id', personId).single()
      blocked = person?.is_blocked || false
    }
    if (blocked) {
      if (/^(start|reanudar|resume)$/i.test(body.trim())) {
        await supabase.from('people').update({ is_blocked: false }).eq('id', personId)
        return new Response(twiml('Bienvenido de vuelta, veci.'), { headers: { 'Content-Type': 'text/xml' } })
      }
      return new Response(null, { status: 204 })
    }
    if (/^(stop|basta|cancel|quit|unsubscribe)$/i.test(body.trim())) {
      if (personId) await supabase.from('people').update({ is_blocked: true, block_reason: 'stop' }).eq('id', personId)
      return new Response(twiml('Listo veci, te saque de mensajes. Escribe START para volver.'), { headers: { 'Content-Type': 'text/xml' } })
    }

    // Keyword shortcuts
    const lower = body.toLowerCase().trim()
    if (/^(menu|opciones|ayuda|help)$/.test(lower)) {
      return new Response(twiml('Preguntame lo que quieras veci! COMER, RADAR, CITA, o pregunta libre. STOP para salir.'), { headers: { 'Content-Type': 'text/xml' } })
    }

    // AI path
    let reply = ''
    let intent = 'ai_conversation'
    if (AI_ENABLED) {
      const embRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: body, dimensions: 768 }),
      })
      const embJson = await embRes.json()
      const embedding = embJson.data?.[0]?.embedding || []

      const [placesRes, eventsRes] = await Promise.all([
        embedding.length ? supabase.rpc('match_places', { query_embedding: JSON.stringify(embedding), match_threshold: 0.25, match_count: 5 }) : { data: [] },
        embedding.length ? supabase.rpc('match_events', { query_embedding: JSON.stringify(embedding), match_threshold: 0.2, match_count: 3, from_date: new Date().toISOString(), to_date: new Date(Date.now() + 14*86400000).toISOString() }) : { data: [] },
      ])
      const places = (placesRes.data || []) as Array<{name: string; one_liner: string; phone: string; category: string}>
      const events = (eventsRes.data || []) as Array<{title: string; start_time: string; location_name: string}>

      let context = ''
      if (places.length) {
        intent = 'ai_places'
        const formatted = places.map(p => {
          const ph = p.phone || ''
          if (channel === 'sms') return `${p.name}${ph ? ' ' + ph : ''}`
          return `${p.name} - ${(p.one_liner || p.category || '').slice(0, 60)}${ph ? ' Tel: ' + ph : ''}`
        }).join('\n')
        context += `\nNEGOCIOS:\n${formatted}`
      }
      if (events.length) {
        if (!places.length) intent = 'ai_events'
        const formatted = events.map(e => `${e.title}${e.location_name ? ' @ ' + e.location_name : ''}`).join('\n')
        context += `\nEVENTOS:\n${formatted}`
      }

      const maxChars = channel === 'whatsapp' ? 450 : 280
      const sysPrompt = `Eres El Veci, asistente local de Cabo Rojo PR. Hablas espanol boricua casual. Responde en MAXIMO ${maxChars} caracteres. Incluye telefono de negocios. Texto plano, sin markdown.${context}`

      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: body }],
          max_tokens: channel === 'whatsapp' ? 250 : 150,
          temperature: 0.7,
        }),
      })
      const aiJson = await aiRes.json()
      reply = aiJson.choices?.[0]?.message?.content || 'No pude procesar tu mensaje. Escribe MENU.'
      if (channel === 'sms' && reply.length > 320) reply = reply.slice(0, 317) + '...'
    } else {
      reply = 'Soy El Veci. Escribeme COMER, RADAR, CITA o MENU.'
      intent = 'fallback_no_ai'
    }

    if (line === '8228') reply += '\nSi tienes negocio y quieres aparecer, responde ALIADO.'

    if (convId) {
      await supabase.from('messages').insert({
        conversation_id: convId, person_id: personId, direction: 'outbound',
        channel, from: to, to: from, body: reply, intent,
        raw_intent: {}, context: { ai_enabled: AI_ENABLED }, source: 'twilio-webhook', raw_payload: {},
      })
    }

    await supabase.from('conversations').update({ intent }).eq('contact', from).eq('channel', channel).eq('line', line)

    return new Response(twiml(reply), { headers: { 'Content-Type': 'text/xml' } })
  } catch (err) {
    console.error('FATAL:', err)
    return new Response(twiml('Tengo un problemita tecnico, veci. Intenta de nuevo.'), { headers: { 'Content-Type': 'text/xml' } })
  }
})
