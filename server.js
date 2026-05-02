const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MODAL_ENDPOINT_URL = process.env.MODAL_ENDPOINT_URL;

const reports = [];

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function apifyRun(actorId, input) {
  const r = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  });
  if (!r.ok) throw new Error(`Apify run failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function apifyPoll(runId, maxAttempts = 30, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const r = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const data = await r.json();
    const status = data.data?.status;
    if (status === 'SUCCEEDED') return data.data?.defaultDatasetId;
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Apify run ${status}`);
  }
  throw new Error('Apify timed out');
}

async function apifyDataset(datasetId, limit = 50) {
  const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=${limit}`);
  return r.json();
}

async function callClaude(system, userContent, maxTokens = 5000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const data = await r.json();
  if (data.error) throw new Error('Claude: ' + data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

function parseJSON(raw) {
  const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON valido en respuesta de Claude');
  return JSON.parse(match[0]);
}

async function callModal(videoUrl) {
  if (!MODAL_ENDPOINT_URL) throw new Error('MODAL_ENDPOINT_URL no configurada en Render.');
  console.log('Calling Modal:', MODAL_ENDPOINT_URL);
  const r = await fetch(MODAL_ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl })
  });
  console.log('Modal status:', r.status);
  if (!r.ok) throw new Error(`Modal error ${r.status}: ${await r.text()}`);
  const result = await r.json();
  console.log('Modal duration:', result.duration, 'transcript length:', result.full_transcript?.length);
  return result;
}

// ── ENGAGEMENT FORMULAS ───────────────────────────────────────────────────────
function scoreTikTok(p) {
  // Guardados×4 + Compartidos×3 + Comentarios×2 + Likes×1 + Views×0.05
  return (p.saves * 4) + (p.shares * 3) + (p.comments * 2) + (p.likes * 1) + (p.views * 0.05);
}

function scoreInstagram(p, followers) {
  // IEI = (Likes + (Comentarios×5) / Views) × (1/log10(Seguidores)) × 100
  // Comentarios×5 porque asumimos ~40% son automatizados (ManyChat etc)
  const views = Math.max(p.views, 1);
  const subs = Math.max(followers || 10000, 10);
  return ((p.likes + (p.comments * 5)) / views) * (1 / Math.log10(subs)) * 100;
}

// ── H1: VIDEO ANALYSIS ────────────────────────────────────────────────────────
app.post('/api/h1/analyze', async (req, res) => {
  try {
    const { videoUrl, userNiche } = req.body;
    if (!videoUrl?.trim()) return res.status(400).json({ error: 'Falta el link del video.' });
    if (!userNiche?.trim()) return res.status(400).json({ error: 'Falta tu nicho o profesion.' });

    const platform = videoUrl.includes('tiktok') ? 'TikTok' : 'Instagram';

    // Instagram block warning
    if (platform === 'Instagram') {
      return res.status(400).json({
        error: 'Instagram bloquea la descarga de videos desde servidores en la nube. Usa un link de TikTok para H1, o descarga el video y subelo manualmente.'
      });
    }

    // Modal processing
    let videoData = null;
    let modalWorked = false;
    try {
      videoData = await callModal(videoUrl);
      if (videoData.error) {
        console.error('Modal returned error:', videoData.error);
        videoData = { duration: 0, language: 'es', full_transcript: '', transcript_segments: [], key_frames: [], total_frames: 0 };
      } else {
        modalWorked = true;
      }
    } catch (modalErr) {
      console.error('Modal failed:', modalErr.message);
      videoData = { duration: 0, language: 'es', full_transcript: '', transcript_segments: [], key_frames: [], total_frames: 0 };
    }

    const hasTranscript = videoData.full_transcript?.trim().length > 20;
    const hasFrames = videoData.key_frames?.length > 0;

    // Build Claude message
    const userContent = [];

    if (hasFrames) {
      const hookFrames = videoData.key_frames.filter(f => f.section === 'hook').slice(0, 2);
      for (const frame of hookFrames) {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: frame.b64 }
        });
      }
    }

    userContent.push({
      type: 'text',
      text: `Eres un estratega experto en guiones virales para TikTok.

Analiza este video viral y genera 2 guiones adaptados al nicho del usuario.

URL: ${videoUrl}
Plataforma: TikTok
Duracion: ${videoData.duration}s
Idioma: ${videoData.language || 'es'}
Video procesado con IA visual: ${modalWorked ? 'SI - tienes frames reales' : 'NO'}
Nicho del usuario: ${userNiche}

TRANSCRIPCION COMPLETA:
${hasTranscript ? videoData.full_transcript : '(No disponible)'}

TRANSCRIPCION CON TIMESTAMPS:
${videoData.transcript_segments?.length > 0
  ? videoData.transcript_segments.map(s => `[${s.start}s] ${s.text}`).join('\n')
  : '(No disponible)'}

INSTRUCCIONES:
1. Determina la categoria del video: ATRACCION, RETENCION o VENTA
2. Elige la estructura mas adecuada de estas 12:

ATRACCION:
1. Sintoma -> Creencia erronea -> Problema invisible -> Micro-explicacion -> Mini solucion -> CTA
2. Contradiccion directa -> Reframe -> Ensenanza -> Aplicacion
3. Pregunta incomoda -> Diagnostico -> Clasificacion -> Solucion
4. Mito -> Demolicion -> Verdad -> Sistema simple

RETENCION:
5. Open Loop -> Desarrollo -> Giro -> Resolucion
6. Antes -> Intentos fallidos -> Descubrimiento -> Despues -> Leccion
7. Demostracion -> Explicacion -> Breakdown -> CTA
8. Error -> Correccion -> Comparacion -> Resultado

VENTA:
9. Dolor -> Valor -> Autoridad -> Objecion -> CTA
10. Historia -> Identificacion -> Punto de quiebre -> Solucion -> Oferta
11. Problema -> Costo de no actuar -> Oportunidad -> CTA
12. Micro-valor -> Prueba -> Expansion -> Cierre

3. Genera 2 guiones adaptados al nicho "${userNiche}":
   - GUION LARGO: 30-45 segundos (80-110 palabras)
   - GUION CORTO: 15-25 segundos (40-60 palabras)

REGLAS:
- Lenguaje natural y conversacional, NO corporativo
- Cada frase maxima 8 palabras
- Hook en la primera frase
- Saltos de linea entre cada frase
- Listo para grabar sin indicaciones de direccion

Responde SOLO con JSON valido:
{
  "reporte": {
    "hook_visual": "que se ve en los primeros 3 segundos",
    "hook_verbal": "primeras palabras exactas",
    "tipo_hook": "curiosidad/dolor/promesa/controversia/pregunta/demostracion",
    "texto_pantalla": "texto superpuesto si existe",
    "transcripcion_limpia": "transcripcion completa limpia",
    "ritmo_corte": "lento/medio/rapido y cada cuantos segundos",
    "musica_sonido": "tipo de musica o sonido",
    "cta_visual": "CTA visual si existe",
    "cta_verbal": "CTA verbal si existe",
    "estructura_detectada": "como esta organizado el video",
    "por_que_viral": "por que este video funciona viralmente",
    "elementos_clave": ["elemento 1", "elemento 2", "elemento 3"]
  },
  "categoria": "ATRACCION|RETENCION|VENTA",
  "estructura_elegida": {
    "numero": 1,
    "nombre": "nombre exacto de la estructura",
    "razon": "por que elegiste esta estructura"
  },
  "guion_largo": {
    "duracion_estimada": "30-45s",
    "palabras": 95,
    "estructura_pasos": ["Paso 1: texto", "Paso 2: texto"],
    "guion_completo": "Linea 1.\nLinea 2.\nLinea 3."
  },
  "guion_corto": {
    "duracion_estimada": "15-25s",
    "palabras": 50,
    "estructura_pasos": ["Paso 1: texto", "Paso 2: texto"],
    "guion_completo": "Linea 1 corta.\nLinea 2 corta."
  },
  "meta": {
    "plataforma": "TikTok",
    "duracion_video": ${videoData.duration},
    "nicho_usuario": "${userNiche}",
    "modal_usado": ${modalWorked}
  }
}`
    });

    const SYSTEM = `Eres un experto en guiones virales para TikTok. Analizas videos reales y creas guiones naturales, directos y grabables. Nunca usas lenguaje corporativo. SIEMPRE responde SOLO con JSON valido, sin markdown.`;

    const rawResponse = await callClaude(SYSTEM, userContent, 6000);
    const analysis = parseJSON(rawResponse);
    analysis.id = Date.now().toString();

    reports.unshift({
      id: analysis.id,
      type: 'h1',
      url: videoUrl,
      nicho: userNiche,
      categoria: analysis.categoria,
      estructura: analysis.estructura_elegida?.nombre,
      fecha: new Date().toLocaleDateString('es-ES'),
      data: analysis
    });
    if (reports.length > 100) reports.pop();

    res.json(analysis);
  } catch (e) {
    console.error('H1 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── H2: PROFILE ANALYSIS ──────────────────────────────────────────────────────
app.post('/api/h2/analyze', async (req, res) => {
  try {
    const { profileUrl } = req.body;
    if (!profileUrl?.trim()) return res.status(400).json({ error: 'Falta la URL del perfil.' });

    const isTikTok = profileUrl.includes('tiktok');
    let posts = [];
    let profileFollowers = 0;

    if (isTikTok) {
      const username = profileUrl.match(/tiktok\.com\/@([^/?#\s]+)/)?.[1]
        || profileUrl.replace('@', '').replace(/https?:\/\//, '').trim();

      console.log('Scraping TikTok:', username);
      const runData = await apifyRun('clockworks~tiktok-profile-scraper', {
        profiles: [username],
        resultsPerPage: 50,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false
      });

      const dsId = await apifyPoll(runData.data?.id);
      const raw = await apifyDataset(dsId, 50);

      // Get followers from first item
      profileFollowers = raw[0]?.authorMeta?.fans || raw[0]?.author?.followerCount || 0;

      posts = raw.map(p => ({
        url: p.webVideoUrl || p.url || '',
        caption: (p.text || p.desc || '').substring(0, 300),
        views: p.playCount || p.stats?.playCount || 0,
        likes: p.diggCount || p.stats?.diggCount || 0,
        comments: p.commentCount || p.stats?.commentCount || 0,
        shares: p.shareCount || p.stats?.shareCount || 0,
        saves: p.collectCount || p.stats?.collectCount || 0,
        date: p.createTimeISO || (p.createTime ? new Date(p.createTime * 1000).toISOString() : '')
      }));

    } else {
      let cleanUrl = profileUrl.trim();
      if (!cleanUrl.startsWith('http')) cleanUrl = `https://www.instagram.com/${cleanUrl.replace('@', '')}/`;
      if (!cleanUrl.endsWith('/')) cleanUrl += '/';

      console.log('Scraping Instagram:', cleanUrl);
      const runData = await apifyRun('apify~instagram-scraper', {
        directUrls: [cleanUrl],
        resultsType: 'posts',
        resultsLimit: 50,
        addParentData: false
      });

      const dsId = await apifyPoll(runData.data?.id, 30, 5000);
      const raw = await apifyDataset(dsId, 50);

      if (!raw.length) throw new Error('No se encontraron posts. El perfil puede ser privado.');

      // Get followers
      profileFollowers = raw[0]?.ownerFollowersCount || raw[0]?.owner?.followersCount || 10000;

      posts = raw.map(p => ({
        url: p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : ''),
        caption: (p.caption || '').substring(0, 300),
        views: p.videoViewCount || p.videoPlayCount || 0,
        likes: p.likesCount || p.likes || 0,
        comments: p.commentsCount || p.comments || 0,
        shares: 0,
        saves: 0,
        date: p.timestamp || ''
      }));
    }

    if (!posts.length) throw new Error('No se encontraron posts. El perfil puede ser privado.');

    // Apply platform-specific scoring
    const scored = posts.map(p => ({
      ...p,
      engagement_score: isTikTok
        ? scoreTikTok(p)
        : scoreInstagram(p, profileFollowers),
      formula_usada: isTikTok
        ? 'Guardados×4 + Compartidos×3 + Comentarios×2 + Likes×1 + Views×0.05'
        : 'IEI = (Likes + Comentarios×5) / Views × (1/log10(Seguidores)) × 100'
    })).sort((a, b) => b.engagement_score - a.engagement_score);

    const top10 = scored.slice(0, 10);

    // Claude pattern analysis
    const SYSTEM_H2 = `Eres experto en analisis de contenido viral. Detectas patrones con precision. Solo JSON valido, sin markdown.`;

    const prompt = `Analiza estos top 10 posts por engagement real de ${isTikTok ? 'TikTok' : 'Instagram'}.

Formula usada: ${isTikTok ? 'TikTok: Guardados×4 + Compartidos×3 + Comentarios×2 + Likes×1 + Views×0.05' : 'Instagram IEI: (Likes + Comentarios×5) / Views × (1/log10(Seguidores)) × 100'}

${JSON.stringify(top10.map((p, i) => ({
  rank: i + 1,
  caption: p.caption,
  views: p.views,
  likes: p.likes,
  comments: p.comments,
  shares: p.shares,
  saves: p.saves,
  score: parseFloat(p.engagement_score.toFixed(4))
})), null, 2)}

Responde con este JSON:
{
  "patron_general": "que tienen en comun estos 10 posts",
  "que_genera_engagement": "que hace que generen interaccion real",
  "hook_pattern": "patron de hook que se repite",
  "tipo_contenido_top": "tipo de contenido que mas funciona",
  "tono": "tono predominante: educativo/entretenimiento/inspiracional/ventas",
  "oportunidad_detectada": "que falta o podria mejorarse",
  "resumen": "insight principal en una frase"
}`;

    const rawPatterns = await callClaude(SYSTEM_H2, prompt, 2000);
    const patterns = parseJSON(rawPatterns);

    const result = {
      id: Date.now().toString(),
      platform: isTikTok ? 'tiktok' : 'instagram',
      profile_url: profileUrl,
      followers: profileFollowers,
      total_analyzed: posts.length,
      formula: isTikTok
        ? 'Guardados×4 + Compartidos×3 + Comentarios×2 + Likes×1 + Views×0.05'
        : 'IEI = (Likes + Comentarios×5) / Views × (1/log10(Seguidores)) × 100',
      top10,
      patterns,
      fecha: new Date().toLocaleDateString('es-ES')
    };

    reports.unshift({
      id: result.id,
      type: 'h2',
      url: profileUrl,
      platform: result.platform,
      fecha: result.fecha,
      data: result
    });
    if (reports.length > 100) reports.pop();

    res.json(result);
  } catch (e) {
    console.error('H2 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── REPORTS ───────────────────────────────────────────────────────────────────
app.get('/api/reports', (req, res) => res.json(reports.slice(0, 50)));

app.get('/api/reports/:id', (req, res) => {
  const r = reports.find(x => x.id === req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/reports/:id', (req, res) => {
  const i = reports.findIndex(x => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  reports.splice(i, 1);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VIRALIQ running on port ${PORT}`));
