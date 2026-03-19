import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const openaiKey = Deno.env.get('OPENAI_API_KEY')!

const supabase = createClient(supabaseUrl, supabaseKey)

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
      dimensions: 768,
    }),
  })
  const json = await res.json()
  if (!json.data?.[0]?.embedding) {
    throw new Error(`OpenAI error: ${JSON.stringify(json)}`)
  }
  return json.data[0].embedding
}

function buildPlaceText(p: Record<string, unknown>): string {
  const parts = [
    p.name,
    p.one_liner,
    p.description,
    p.category,
    p.subcategory,
    p.address,
    Array.isArray(p.tags) ? p.tags.join(', ') : '',
    Array.isArray(p.vibe) ? p.vibe.join(', ') : '',
  ].filter(Boolean)
  return parts.join(' | ').slice(0, 8000)
}

function buildEventText(e: Record<string, unknown>): string {
  const parts = [
    e.title,
    e.description,
    e.location_name,
    e.category,
    Array.isArray(e.vibes) ? e.vibes.join(', ') : '',
    e.price_range,
  ].filter(Boolean)
  return parts.join(' | ').slice(0, 8000)
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('POST only', { status: 405 })
  }

  const { table = 'places', batch_size = 20, force = false } = await req.json().catch(() => ({}))

  if (table !== 'places' && table !== 'events') {
    return new Response(JSON.stringify({ error: 'table must be places or events' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let query = supabase.from(table).select('*')
  if (!force) {
    query = query.is('embedding', null)
  }
  const { data: rows, error } = await query.limit(batch_size)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!rows || rows.length === 0) {
    return new Response(JSON.stringify({ message: 'No rows to process', table }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let processed = 0
  let errors = 0
  const details: string[] = []

  for (const row of rows) {
    try {
      const text = table === 'places' ? buildPlaceText(row) : buildEventText(row)
      const embedding = await getEmbedding(text)

      const { error: updateError } = await supabase
        .from(table)
        .update({ embedding: JSON.stringify(embedding) })
        .eq('id', row.id)

      if (updateError) {
        errors++
        details.push(`${row.id}: update error - ${updateError.message}`)
      } else {
        processed++
        details.push(`${row.id}: ${((row.name || row.title || 'untitled') as string).slice(0, 40)} OK`)
      }
    } catch (err) {
      errors++
      details.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return new Response(JSON.stringify({
    table,
    total_found: rows.length,
    processed,
    errors,
    details,
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
