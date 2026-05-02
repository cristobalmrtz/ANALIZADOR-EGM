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
const MODAL_ENDPOINT_URL = process.env.MODAL_ENDPOINT_URL; // e.g. https://luiscrisma0107--viral-analyzer-analyze-video.modal.run

// In-memory store (Phase 2: replace with DB)
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
      messages: Array.isArray(userContent)
        ? [{ role: 'user', content: userContent }]
        : [{ role: 'user', content: userContent }]
    })
  });
  const data = await r.json();
  if (data.error) throw new Error('Claude: ' + data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

function parseJSON(raw) {
  const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON válido en respuesta de Claude');
  return JSON.parse(match[0]);
}

async function callModal(videoUrl) {
  if (!MODAL_ENDPOINT_URL) {
    throw new Error('MODAL_ENDPOINT_URL no está configurada en las variables de entorno de Render.');
  }

  console.log('Calling Modal endpoint:', MODAL_ENDPOINT_URL);

  const r = await fetch(MODAL_ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl })
  });

  console.log('Modal response status:', r.status);

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Modal error ${r.status}: ${errText.substring(0, 300)}`);
  }

  const result = await r.json();
  console.log('Modal success - duration:', result.duration, 'transcript length:', result.full_transcript?.length);
  return result;
}

// ── H1: VIDEO ANALYSIS ────────────────────────────────────────────────────────
app.post('/api/h1/analyze', async (req, res) => {
  try {
    const { videoUrl, userNiche } = req.body;
    if (!videoUrl?.trim()) return res.status(400).json({ error: 'Falta el link del video.' });
    if (!userNiche?.trim()) return res.status(400).json({ error: 'Falta tu nicho o profesión.' });

    const platform = videoUrl.includes('tiktok') ? 'TikTok' : 'Instagram';

    // Step 1: Modal processes the video
    let videoData = null;
    let modalWorked = false;
    try {
      videoData = await callModal(videoUrl);
      if (videoData.error) {
        console.error('Modal returned error:', videoData.error);
        modalWorked = false;
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

    // Step 2: Build Claude message
    const userContent = [];

    // Add hook frames if available
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
      text: `Eres un estratega experto en guiones virales para ${platform}.

Analiza este video viral y genera 2 guiones adaptados al nicho del usuario.

URL del video: ${videoUrl}
Plataforma: ${platform}
Duración: ${videoData.duration}s
Idioma detectado: ${videoData.language || 'es'}
Video procesado con IA visual: ${modalWorked ? 'SÍ - tienes frames reales' : 'NO - analiza con URL e infiere'}
Nicho del usuario: ${userNiche}

TRANSCRIPCIÓN COMPLETA DEL VIDEO:
${hasTranscript ? videoData.full_transcript : '(No disponible - el video puede ser privado o no tiene audio detectable)'}

TRANSCRIPCIÓN CON TIMESTAMPS:
${videoData.transcript_segments?.length > 0
  ? videoData.transcript_segments.map(s => `[${s.start}s] ${s.text}`).join('\n')
  : '(No disponible)'}

INSTRUCCIONES PARA EL ANÁLISIS:
1. Analiza el video y determina su categoría: ATRACCIÓN, RETENCIÓN o VENTA
2. Elige la estructura más adecuada de estas 12 opciones según el contenido:

ATRACCIÓN:
1. Síntoma → Creencia errónea → Problema invisible → Micro-explicación → Mini solución → CTA
2. Contradicción directa → Reframe → Enseñanza → Aplicación
3. Pregunta incómoda → Diagnóstico → Clasificación → Solución
4. Mito → Demolición → Verdad → Sistema simple

RETENCIÓN:
5. Open Loop → Desarrollo → Giro → Resolución
6. Antes → Intentos fallidos → Descubrimiento → Después → Lección
7. Demostración → Explicación → Breakdown → CTA
8. Error → Corrección → Comparación → Resultado

VENTA:
9. Dolor → Valor → Autoridad → Objeción → CTA
10. Historia → Identificación → Punto de quiebre → Solución → Oferta
11. Problema → Costo de no actuar → Oportunidad → CTA
12. Micro-valor → Prueba → Expansión → Cierre

3. Genera 2 guiones REALES adaptados al nicho "${userNiche}":
   - GUIÓN LARGO: exactamente 30-45 segundos (entre 80-110 palabras)
   - GUIÓN CORTO: exactamente 15-25 segundos (entre 40-60 palabras)

REGLAS PARA LOS GUIONES:
- Lenguaje natural y conversacional, NO corporativo
- Cada frase máximo 8 palabras
- El hook en la primera frase
- Saltos de línea entre cada frase del guión
- Adaptado 100% al nicho "${userNiche}"
- Listo para grabar, sin indicaciones de dirección

Responde SOLO con JSON válido:
{
  "reporte": {
    "hook_visual": "qué se ve exactamente en los primeros 3 segundos",
    "hook_verbal": "primeras palabras exactas del video",
    "tipo_hook": "curiosidad/dolor/promesa/controversia/pregunta/demostración",
    "texto_pantalla": "texto superpuesto en pantalla si existe",
    "transcripcion_limpia": "transcripción completa limpia y editada",
    "ritmo_corte": "lento/medio/rápido y cada cuántos segundos hay corte",
    "musica_sonido": "tipo de música o sonido de fondo",
    "cta_visual": "CTA visual si existe",
    "cta_verbal": "CTA verbal si existe",
    "estructura_detectada": "cómo está organizado el video paso a paso",
    "por_que_viral": "análisis de por qué este video funciona viralmente",
    "elementos_clave": ["elemento 1", "elemento 2", "elemento 3"]
  },
  "categoria": "ATRACCIÓN|RETENCIÓN|VENTA",
  "estructura_elegida": {
    "numero": 1,
    "nombre": "nombre exacto de la estructura",
    "razon": "por qué elegiste esta estructura para este video y nicho"
  },
  "guion_largo": {
    "duracion_estimada": "30-45s",
    "palabras": 95,
    "estructura_pasos": ["Síntoma: texto...", "Creencia errónea: texto..."],
    "guion_completo": "Línea 1 del guión.\nLínea 2 del guión.\nLínea 3 del guión."
  },
  "guion_corto": {
    "duracion_estimada": "15-25s",
    "palabras": 50,
    "estructura_pasos": ["Hook: texto...", "Valor: texto..."],
    "guion_completo": "Línea 1 corta.\nLínea 2 corta.\nLínea 3 corta."
  },
  "meta": {
    "plataforma": "${platform}",
    "duracion_video": ${videoData.duration},
    "nicho_usuario": "${userNiche}",
    "modal_usado": ${modalWorked}
  }
}`
    });

    const SYSTEM = `Eres un experto en guiones virales para TikTok e Instagram.
Analizas videos reales y creas guiones naturales, directos y grabables.
Nunca usas lenguaje corporativo. Siempre en primera persona o segunda persona directa.
SIEMPRE responde SOLO con JSON válido, sin markdown, sin texto adicional.`;

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
      // Instagram
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

      posts = raw.map(p => ({
        url: p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : ''),
        caption: (p.caption || '').substring(0, 300),
        views: p.videoViewCount || p.videoPlayCount || 0,
        likes: p.likesCount || p.likes || 0,
        comments: p.commentsCount || p.comments || 0,
        shares: 0,
        saves: p.savesCount || 0,
        date: p.timestamp || ''
      }));
    }

    if (!posts.length) throw new Error('No se encontraron posts. El perfil puede ser privado o incorrecto.');

    // Score: saves×4 + shares×3 + comments×2 + likes×1 + views×0.05
    const scored = posts
      .map(p => ({
        ...p,
        engagement_score: (p.saves * 4) + (p.shares * 3) + (p.comments * 2) + (p.likes * 1) + (p.views * 0.05)
      }))
      .sort((a, b) => b.engagement_score - a.engagement_score);

    const top10 = scored.slice(0, 10);

    // Claude pattern analysis
    const SYSTEM_H2 = `Eres experto en análisis de contenido viral. Detectas patrones con precisión. Solo JSON válido, sin markdown.`;

    const prompt = `Analiza estos top 10 posts por engagement real de ${isTikTok ? 'TikTok' : 'Instagram'} y detecta patrones:

${JSON.stringify(top10.map((p, i) => ({
  rank: i + 1,
  caption: p.caption,
  views: p.views,
  likes: p.likes,
  comments: p.comments,
  shares: p.shares,
  saves: p.saves,
  score: Math.round(p.engagement_score)
})), null, 2)}

Responde con este JSON exacto:
{
  "patron_general": "qué tienen en común estos 10 posts",
  "que_genera_guardados": "qué hace que los guarden",
  "que_genera_compartidos": "qué hace que los compartan",
  "hook_pattern": "patrón de hook que se repite",
  "tipo_contenido_top": "tipo de contenido que más funciona",
  "tono": "tono predominante: educativo/entretenimiento/inspiracional/ventas",
  "oportunidad_detectada": "qué falta o podría mejorarse",
  "resumen": "insight principal en una frase"
}`;

    const rawPatterns = await callClaude(SYSTEM_H2, prompt, 2000);
    const patterns = parseJSON(rawPatterns);

    const result = {
      id: Date.now().toString(),
      platform: isTikTok ? 'tiktok' : 'instagram',
      profile_url: profileUrl,
      total_analyzed: posts.length,
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
