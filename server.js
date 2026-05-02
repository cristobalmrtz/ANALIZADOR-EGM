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
const MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID;
const MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET;
const MODAL_APP = 'luiscrisma0107/main/deployed/viral-analyzer';
const MODAL_FUNCTION = 'analyze_video';


// In-memory store (Phase 2: replace with DB)
const reports = [];

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function apifyRun(actorId, input) {
  const r = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!r.ok) throw new Error(`Apify run failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function apifyPoll(runId, maxAttempts = 25, intervalMs = 5000) {
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
  const messages = Array.isArray(userContent)
    ? [{ role: 'user', content: userContent }]
    : [{ role: 'user', content: userContent }];

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
      messages
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
  if (!MODAL_TOKEN_ID || !MODAL_TOKEN_SECRET) {
    throw new Error('Modal tokens not configured');
  }
  const auth = Buffer.from(`${MODAL_TOKEN_ID}:${MODAL_TOKEN_SECRET}`).toString('base64');

  const callRes = await fetch(
    `https://api.modal.com/v1/functions/viral-analyzer-analyze-video/call`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify({ args: [videoUrl], kwargs: {} })
    }
  );

  if (!callRes.ok) {
    const errText = await callRes.text();
    throw new Error(`Modal call failed ${callRes.status}: ${errText.substring(0, 200)}`);
  }

  const { call_id } = await callRes.json();

  // Poll for result (max 5 min)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const resultRes = await fetch(
      `https://api.modal.com/v1/calls/${call_id}/result`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    if (resultRes.status === 200) return resultRes.json();
    if (resultRes.status !== 202) throw new Error(`Modal polling error: ${resultRes.status}`);
  }
  throw new Error('Modal timed out after 5 minutes');
}

// ── 12 SCRIPT STRUCTURES ──────────────────────────────────────────────────────
const STRUCTURES = {
  // ATRACCIÓN
  1: { cat: 'ATRACCIÓN', name: 'Síntoma → Creencia errónea → Problema invisible → Mini solución → CTA', steps: ['Síntoma', 'Creencia errónea', 'Problema invisible', 'Micro-explicación', 'Mini solución', 'CTA'] },
  2: { cat: 'ATRACCIÓN', name: 'Contradicción directa → Reframe → Enseñanza → Aplicación', steps: ['Contradicción directa', 'Reframe', 'Enseñanza', 'Aplicación/CTA'] },
  3: { cat: 'ATRACCIÓN', name: 'Pregunta incómoda → Diagnóstico → Clasificación → Solución', steps: ['Pregunta incómoda', 'Diagnóstico', 'Clasificación', 'Solución/CTA'] },
  4: { cat: 'ATRACCIÓN', name: 'Mito → Demolición → Verdad → Sistema simple', steps: ['Mito', 'Demolición', 'Verdad', 'Sistema simple/CTA'] },
  // RETENCIÓN
  5: { cat: 'RETENCIÓN', name: 'Open Loop → Desarrollo → Giro → Resolución', steps: ['Open loop (gancho)', 'Desarrollo', 'Giro inesperado', 'Resolución/CTA'] },
  6: { cat: 'RETENCIÓN', name: 'Antes → Intentos fallidos → Descubrimiento → Después → Lección', steps: ['Antes (situación inicial)', 'Intentos fallidos', 'Descubrimiento clave', 'Después (resultado)', 'Lección/CTA'] },
  7: { cat: 'RETENCIÓN', name: 'Demostración → Explicación → Breakdown → CTA', steps: ['Demostración visual', 'Explicación', 'Breakdown (desglose)', 'CTA'] },
  8: { cat: 'RETENCIÓN', name: 'Error → Corrección → Comparación → Resultado', steps: ['Error común', 'Corrección', 'Comparación (antes/después)', 'Resultado/CTA'] },
  // VENTA
  9: { cat: 'VENTA', name: 'Dolor → Valor → Autoridad → Objeción → CTA', steps: ['Dolor (hook)', 'Valor entregado', 'Autoridad', 'Objeción resuelta', 'CTA/Venta'] },
  10: { cat: 'VENTA', name: 'Historia → Identificación → Punto de quiebre → Solución → Oferta', steps: ['Historia inicial', 'Identificación del lector', 'Punto de quiebre', 'Solución', 'Oferta/CTA'] },
  11: { cat: 'VENTA', name: 'Problema → Costo de no actuar → Oportunidad → CTA', steps: ['Problema urgente', 'Costo de no actuar', 'Oportunidad', 'CTA urgente'] },
  12: { cat: 'VENTA', name: 'Micro-valor → Prueba → Expansión → Cierre', steps: ['Micro-valor (tip rápido)', 'Prueba/ejemplo', 'Expansión', 'Cierre/CTA'] }
};

// ── H1: VIDEO ANALYSIS ────────────────────────────────────────────────────────
app.post('/api/h1/analyze', async (req, res) => {
  try {
    const { videoUrl, userNiche } = req.body;
    if (!videoUrl?.trim()) return res.status(400).json({ error: 'Falta el link del video.' });
    if (!userNiche?.trim()) return res.status(400).json({ error: 'Falta tu nicho o profesión.' });

    const platform = videoUrl.includes('tiktok') ? 'TikTok' : 'Instagram';

    // Step 1: Try Modal for real video analysis
    let videoData = null;
    let modalWorked = false;
    try {
      videoData = await callModal(videoUrl);
      modalWorked = true;
      console.log('Modal success - duration:', videoData.duration, 'transcript length:', videoData.full_transcript?.length);
    } catch (modalErr) {
      console.error('Modal failed:', modalErr.message);
      videoData = { duration: 0, language: 'es', full_transcript: '', transcript_segments: [], key_frames: [], total_frames: 0 };
    }

    const hasTranscript = videoData.full_transcript?.trim().length > 20;
    const hasFrames = videoData.key_frames?.length > 0;

    // Build Claude message content
    const userContent = [];

    // Add key frames if available (hook frames first)
    if (hasFrames) {
      const hookFrames = videoData.key_frames.filter(f => f.section === 'hook').slice(0, 2);
      const ctaFrames = videoData.key_frames.filter(f => f.section === 'cta').slice(0, 1);
      for (const frame of [...hookFrames, ...ctaFrames]) {
        userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.b64 } });
      }
    }

    userContent.push({
      type: 'text',
      text: `Analiza este video viral de ${platform}.

URL: ${videoUrl}
Duración: ${videoData.duration}s
Idioma: ${videoData.language || 'auto'}
Nicho del usuario: ${userNiche}
Video procesado con Modal: ${modalWorked ? 'Sí' : 'No (analiza con la URL e infiere)'}

TRANSCRIPCIÓN COMPLETA:
${hasTranscript ? videoData.full_transcript : 'No disponible - infiere basándote en la URL y el nicho'}

TRANSCRIPCIÓN CON TIMESTAMPS:
${videoData.transcript_segments?.map(s => `[${s.start}s] ${s.text}`).join('\n') || 'No disponible'}

INSTRUCCIONES:
1. Analiza el video y determina su categoría: ATRACCIÓN, RETENCIÓN o VENTA
2. De las 12 estructuras disponibles, elige la más adecuada según el contenido analizado
3. Genera 2 guiones REALES, GRABABLES, en español natural (no corporativo):
   - Guión LARGO: 30-45 segundos (±80-110 palabras)
   - Guión CORTO: 15-25 segundos (±40-60 palabras)
4. Los guiones deben estar adaptados al nicho: ${userNiche}
5. Cada línea del guión debe ser una frase corta que se diga en 3-5 segundos

Responde SOLO con JSON válido:
{
  "reporte": {
    "hook_visual": "exactamente qué se ve en los primeros 3 segundos",
    "hook_verbal": "primeras palabras exactas del video",
    "tipo_hook": "curiosidad/dolor/promesa/controversia/pregunta/demostración",
    "texto_pantalla": "todo el texto superpuesto en pantalla",
    "transcripcion_limpia": "transcripción completa editada y limpia",
    "ritmo_corte": "descripción del ritmo: lento/medio/rápido, cada cuántos segundos",
    "musica_sonido": "tipo de música o sonido de fondo",
    "cta_visual": "CTA visual si existe",
    "cta_verbal": "CTA verbal si existe",
    "estructura_detectada": "cómo está organizado el video paso a paso",
    "por_que_viral": "análisis de por qué este video funciona",
    "elementos_clave": ["elemento 1", "elemento 2", "elemento 3"]
  },
  "categoria": "ATRACCIÓN|RETENCIÓN|VENTA",
  "estructura_elegida": {
    "numero": 1,
    "nombre": "nombre de la estructura",
    "razon": "por qué elegiste esta estructura para este video y este nicho"
  },
  "guion_largo": {
    "duracion_estimada": "30-45s",
    "palabras": 0,
    "estructura_pasos": ["paso 1: texto", "paso 2: texto"],
    "guion_completo": "el guión completo listo para grabar, con saltos de línea entre frases"
  },
  "guion_corto": {
    "duracion_estimada": "15-25s",
    "palabras": 0,
    "estructura_pasos": ["paso 1: texto", "paso 2: texto"],
    "guion_completo": "el guión corto completo listo para grabar"
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
Analizas videos reales y creas guiones que suenan naturales, directos y grabables.
Los guiones que escribes son conversacionales, en primera persona, sin lenguaje corporativo.
Cada frase es corta (3-5 palabras idealmente). El hook es lo más importante.
SIEMPRE responde SOLO con JSON válido, sin markdown, sin texto adicional.`;

    const rawResponse = await callClaude(SYSTEM, userContent, 6000);
    const analysis = parseJSON(rawResponse);
    analysis.id = Date.now().toString();

    // Save report
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
    const isInstagram = profileUrl.includes('instagram') || (!isTikTok && !profileUrl.includes('http'));
    let posts = [];

    if (isTikTok) {
      const username = profileUrl.match(/tiktok\.com\/@([^/?#\s]+)/)?.[1]
        || profileUrl.replace('@','').replace(/https?:\/\//,'').trim();

      console.log('Scraping TikTok profile:', username);
      const runData = await apifyRun('clockworks~tiktok-profile-scraper', {
        profiles: [username],
        resultsPerPage: 50,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false
      });

      const dsId = await apifyPoll(runData.data?.id);
      const raw = await apifyDataset(dsId, 50);

      posts = raw.map(p => ({
        url: p.webVideoUrl || p.url || `https://www.tiktok.com/@${username}`,
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
      if (!cleanUrl.startsWith('http')) cleanUrl = `https://www.instagram.com/${cleanUrl.replace('@','')}/`;
      if (!cleanUrl.endsWith('/')) cleanUrl += '/';

      console.log('Scraping Instagram profile:', cleanUrl);
      const runData = await apifyRun('apify~instagram-scraper', {
        directUrls: [cleanUrl],
        resultsType: 'posts',
        resultsLimit: 50,
        addParentData: false
      });

      const dsId = await apifyPoll(runData.data?.id, 30, 5000);
      const raw = await apifyDataset(dsId, 50);

      if (!raw.length) throw new Error('No se encontraron posts. El perfil puede ser privado o la URL es incorrecta.');

      posts = raw.map(p => ({
        url: p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : ''),
        caption: (p.caption || '').substring(0, 300),
        views: p.videoViewCount || p.videoPlayCount || 0,
        likes: p.likesCount || p.likes || 0,
        comments: p.commentsCount || p.comments || 0,
        shares: 0,
        saves: p.savesCount || 0,
        date: p.timestamp || p.taken_at || ''
      }));
    }

    if (!posts.length) throw new Error('No se encontraron posts. El perfil puede ser privado.');

    // Score: saves×4 + shares×3 + comments×2 + likes×1 + views×0.05
    const scored = posts
      .map(p => ({
        ...p,
        engagement_score: (p.saves * 4) + (p.shares * 3) + (p.comments * 2) + (p.likes * 1) + (p.views * 0.05)
      }))
      .sort((a, b) => b.engagement_score - a.engagement_score);

    const top10 = scored.slice(0, 10);

    // Claude pattern analysis
    const prompt = `Analiza estos top 10 posts por engagement real de ${isTikTok ? 'TikTok' : 'Instagram'} y detecta qué tienen en común:

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

Responde SOLO con JSON:
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

    const SYSTEM_H2 = `Eres experto en análisis de contenido viral. Detectas patrones con precisión quirúrgica. Solo JSON válido.`;
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

// ── REPORTS API ───────────────────────────────────────────────────────────────
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
