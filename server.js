const express = require(‘express’);
const cors = require(‘cors’);
const fetch = (…args) => import(‘node-fetch’).then(({default: f}) => f(…args));
const path = require(‘path’);

const app = express();
app.use(cors());
app.use(express.json({ limit: ‘10mb’ }));
app.use(express.static(path.join(__dirname, ‘public’)));

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID || ‘ak-xQ5bihavpCrRf7HYxYq1SG’;
const MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET || ‘as-bblHReTrZv8TxhqvgExIrk’;
const MODAL_APP = ‘viral-analyzer’;
const MODAL_FUNCTION = ‘analyze_video’;

// ── In-memory report store (replace with DB in Phase 2) ──────────────────────
const reports = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function apifyRun(actorId, input) {
const r = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
method: ‘POST’, headers: { ‘Content-Type’: ‘application/json’ }, body: JSON.stringify(input)
});
if (!r.ok) throw new Error(`Apify run failed: ${r.status}`);
return r.json();
}

async function apifyStatus(runId) {
return (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)).json();
}

async function apifyDataset(datasetId, limit = 100) {
return (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=${limit}`)).json();
}

async function callClaude(system, messages, maxTokens = 4000) {
const r = await fetch(‘https://api.anthropic.com/v1/messages’, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’, ‘x-api-key’: ANTHROPIC_KEY, ‘anthropic-version’: ‘2023-06-01’ },
body: JSON.stringify({ model: ‘claude-sonnet-4-6’, max_tokens: maxTokens, system, messages })
});
const data = await r.json();
if (data.error) throw new Error(‘Claude API: ’ + data.error.message);
return data.content?.map(b => b.text || ‘’).join(’’) || ‘’;
}

async function callModal(videoUrl) {
const auth = Buffer.from(`${MODAL_TOKEN_ID}:${MODAL_TOKEN_SECRET}`).toString(‘base64’);
const r = await fetch(`https://api.modal.com/v1/apps/${MODAL_APP}/functions/${MODAL_FUNCTION}/call`, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’, ‘Authorization’: `Basic ${auth}` },
body: JSON.stringify({ args: [videoUrl], kwargs: {} })
});
if (!r.ok) {
const err = await r.text();
throw new Error(`Modal API error: ${r.status} - ${err}`);
}
const call = await r.json();
const callId = call.call_id;

// Poll for result
for (let i = 0; i < 60; i++) {
await new Promise(res => setTimeout(res, 5000));
const statusRes = await fetch(`https://api.modal.com/v1/calls/${callId}/result`, {
headers: { ‘Authorization’: `Basic ${auth}` }
});
if (statusRes.status === 200) {
const result = await statusRes.json();
return result;
} else if (statusRes.status === 202) {
continue; // Still processing
} else {
throw new Error(`Modal polling error: ${statusRes.status}`);
}
}
throw new Error(‘Modal timed out after 5 minutes’);
}

// ── H1: VIDEO ANALYSIS ────────────────────────────────────────────────────────
app.post(’/api/h1/analyze’, async (req, res) => {
try {
const { videoUrl, userNiche } = req.body;
if (!videoUrl) return res.status(400).json({ error: ‘videoUrl required’ });
if (!userNiche) return res.status(400).json({ error: ‘userNiche required’ });

```
// Step 1: Modal processes video
let videoData;
try {
  videoData = await callModal(videoUrl);
} catch (modalErr) {
  // Fallback: analyze without video frames (text only from URL)
  console.error('Modal error, using fallback:', modalErr.message);
  videoData = {
    duration: 0,
    language: 'es',
    full_transcript: '',
    transcript_segments: [],
    key_frames: [],
    total_frames: 0,
    fallback: true
  };
}

// Step 2: Claude analyzes everything
const hasFrames = videoData.key_frames && videoData.key_frames.length > 0;

// Build Claude messages with frames if available
const userContent = [];

if (hasFrames) {
  // Add hook frames (first 3 seconds)
  const hookFrames = videoData.key_frames.filter(f => f.section === 'hook');
  for (const frame of hookFrames.slice(0, 3)) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: frame.b64 }
    });
  }
}

userContent.push({
  type: 'text',
  text: `Analiza este video viral de ${videoUrl.includes('tiktok') ? 'TikTok' : 'Instagram'}.
```

DATOS DEL VIDEO:

- Duración: ${videoData.duration}s
- Idioma detectado: ${videoData.language}
- Plataforma: ${videoUrl.includes(‘tiktok’) ? ‘TikTok’ : ‘Instagram’}
- URL: ${videoUrl}

TRANSCRIPCIÓN COMPLETA:
${videoData.full_transcript || ‘No disponible’}

TRANSCRIPCIÓN CON TIMESTAMPS:
${videoData.transcript_segments?.map(s => `[${s.start}s - ${s.end}s] ${s.text}`).join(’\n’) || ‘No disponible’}

NICHO DEL USUARIO QUE USARÁ ESTE ANÁLISIS: ${userNiche}

Responde SOLO con este JSON exacto:
{
“reporte”: {
“hook_visual”: “Qué se ve exactamente en los primeros 3 segundos”,
“hook_verbal”: “Primeras palabras exactas que dice o aparecen en pantalla”,
“tipo_hook”: “curiosidad/dolor/promesa/controversia/pregunta/otro”,
“texto_pantalla”: “Todo el texto que aparece superpuesto en el video”,
“transcripcion_limpia”: “La transcripción completa editada y limpia”,
“ritmo_corte”: “Descripción del ritmo visual: lento/medio/rápido, cada cuántos segundos hay corte”,
“musica_sonido”: “Tipo de música o sonido de fondo detectado”,
“cta_visual”: “El llamado a la acción visual si existe”,
“cta_verbal”: “El llamado a la acción verbal si existe”,
“estructura_detectada”: “Cómo está estructurado el video paso a paso”,
“por_que_viral”: “Análisis de por qué este video funciona viralmente”,
“elementos_clave”: [“elemento 1”, “elemento 2”, “elemento 3”]
},
“guion_estructura_1”: {
“nombre”: “Síntoma → Solución”,
“sintoma”: “El síntoma que siente la audiencia de ${userNiche} adaptado al video analizado”,
“creencia_erronea”: “La creencia errónea que tiene esa audiencia”,
“dolor_hook”: “Hook adaptado al nicho con el dolor real de su audiencia”,
“problema_invisible”: “El problema de fondo que no ven”,
“explicacion_breve”: “La explicación breve del problema”,
“consecuencia”: “Consecuencia de no resolver esto”,
“promesa_solucion”: “La promesa de solución adaptada al nicho del usuario como CTA”,
“guion_completo”: “El guión completo listo para grabar adaptado a ${userNiche}”
},
“guion_estructura_2”: {
“nombre”: “Dolor → CTA”,
“dolor_hook”: “Hook con dolor directo adaptado a ${userNiche}”,
“valor”: “El valor que se entrega”,
“autoridad”: “Cómo se posiciona la autoridad”,
“objecion”: “La objeción que se resuelve”,
“cta”: “El llamado a la acción final”,
“guion_completo”: “El guión completo listo para grabar adaptado a ${userNiche}”
},
“meta”: {
“plataforma”: “${videoUrl.includes(‘tiktok’) ? ‘TikTok’ : ‘Instagram’}”,
“duracion”: ${videoData.duration},
“url”: “${videoUrl}”,
“nicho_usuario”: “${userNiche}”,
“fecha”: “${new Date().toISOString()}”
}
}`
});

```
const SYSTEM = `Eres un estratega experto en contenido viral. Analiza videos y crea guiones adaptados al nicho del usuario. 
```

Tus análisis son precisos, basados en evidencia real del video.
Los guiones que generas son listos para grabar, naturales, no corporativos.
SIEMPRE responde SOLO con JSON válido, sin markdown, sin texto extra.`;

```
const rawResponse = await callClaude(SYSTEM, [{ role: 'user', content: userContent }], 6000);
const clean = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
const match = clean.match(/\{[\s\S]*\}/);
if (!match) throw new Error('No se generó análisis válido.');

const analysis = JSON.parse(match[0]);
analysis.id = Date.now().toString();
analysis.video_data = {
  duration: videoData.duration,
  language: videoData.language,
  transcript: videoData.full_transcript
};

// Save to reports store
reports.unshift({
  id: analysis.id,
  type: 'h1',
  url: videoUrl,
  nicho: userNiche,
  fecha: new Date().toLocaleDateString('es-ES'),
  data: analysis
});

res.json(analysis);
```

} catch (e) {
console.error(‘H1 error:’, e.message);
res.status(500).json({ error: e.message });
}
});

// ── H2: PROFILE ANALYSIS ──────────────────────────────────────────────────────
app.post(’/api/h2/analyze’, async (req, res) => {
try {
const { profileUrl } = req.body;
if (!profileUrl) return res.status(400).json({ error: ‘profileUrl required’ });

```
const isTikTok = profileUrl.includes('tiktok');
const isInstagram = profileUrl.includes('instagram');

let posts = [];

if (isTikTok) {
  const username = profileUrl.match(/tiktok\.com\/@([^/?#]+)/)?.[1] || profileUrl.replace('@','').trim();
  const runData = await apifyRun('clockworks~tiktok-profile-scraper', {
    profiles: [username], resultsPerPage: 50, shouldDownloadVideos: false
  });
  const runId = runData.data?.id;
  if (!runId) throw new Error('No se pudo iniciar el scraper de TikTok.');

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const sd = await apifyStatus(runId);
    if (sd.data?.status === 'SUCCEEDED') {
      posts = await apifyDataset(sd.data?.defaultDatasetId, 50);
      break;
    } else if (sd.data?.status === 'FAILED' || sd.data?.status === 'ABORTED') {
      throw new Error('Scraper falló.');
    }
  }

  // Map TikTok fields
  posts = posts.map(p => ({
    url: p.webVideoUrl || p.url || '',
    thumbnail: p.coverUrl || p.covers?.[0] || '',
    caption: (p.text || p.desc || '').substring(0, 300),
    views: p.playCount || 0,
    likes: p.diggCount || 0,
    comments: p.commentCount || 0,
    shares: p.shareCount || 0,
    saves: p.collectCount || 0,
    date: p.createTimeISO || new Date(p.createTime * 1000).toISOString()
  }));

} else if (isInstagram) {
  const cleanUrl = profileUrl.startsWith('http') ? profileUrl : `https://www.instagram.com/${profileUrl.replace('@','')}/`;
  const runData = await apifyRun('apify~instagram-scraper', {
    directUrls: [cleanUrl], resultsType: 'posts', resultsLimit: 50
  });
  const runId = runData.data?.id;
  if (!runId) throw new Error('No se pudo iniciar el scraper de Instagram.');

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const sd = await apifyStatus(runId);
    if (sd.data?.status === 'SUCCEEDED') {
      posts = await apifyDataset(sd.data?.defaultDatasetId, 50);
      break;
    } else if (sd.data?.status === 'FAILED' || sd.data?.status === 'ABORTED') {
      throw new Error('Scraper falló. Perfil privado?');
    }
  }

  // Map Instagram fields
  posts = posts.map(p => ({
    url: p.url || p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : '',
    thumbnail: p.displayUrl || p.thumbnailUrl || '',
    caption: (p.caption || '').substring(0, 300),
    views: p.videoViewCount || 0,
    likes: p.likesCount || 0,
    comments: p.commentsCount || 0,
    shares: 0, // Instagram doesn't expose shares
    saves: p.savesCount || 0,
    date: p.timestamp || ''
  }));
} else {
  throw new Error('URL debe ser de TikTok o Instagram.');
}

if (!posts.length) throw new Error('No se encontraron posts. El perfil puede ser privado.');

// Score by REAL engagement: saves×4 + shares×3 + comments×2 + likes×1 + views×0.05
const scored = posts.map(p => ({
  ...p,
  engagement_score: (p.saves * 4) + (p.shares * 3) + (p.comments * 2) + (p.likes * 1) + (p.views * 0.05)
})).sort((a, b) => b.engagement_score - a.engagement_score);

const top10 = scored.slice(0, 10);

// Claude pattern analysis
const SYSTEM = `Eres un experto en análisis de contenido viral. Analiza los top 10 posts por engagement real y detecta patrones.
```

Responde SOLO con JSON válido, sin markdown.`;

```
const prompt = `Analiza estos top 10 posts por engagement real de ${isTikTok ? 'TikTok' : 'Instagram'}:
```

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

Responde con este JSON:
{
“patrones_comunes”: [“patrón 1”, “patrón 2”, “patrón 3”],
“tipo_contenido_top”: “descripción del tipo de contenido que más funciona”,
“hook_pattern”: “patrón de hook que se repite”,
“mejor_momento_publicar”: “análisis de cuándo publican”,
“que_genera_guardados”: “qué hace que guarden el contenido”,
“que_genera_compartidos”: “qué hace que compartan el contenido”,
“oportunidad_detectada”: “qué falta o podría mejorarse”,
“resumen”: “insight principal de por qué este perfil funciona”
}`;

```
const rawResponse = await callClaude(SYSTEM, [{ role: 'user', content: prompt }]);
const clean = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
const match = clean.match(/\{[\s\S]*\}/);
const patterns = match ? JSON.parse(match[0]) : {};

const result = {
  id: Date.now().toString(),
  platform: isTikTok ? 'tiktok' : 'instagram',
  profile_url: profileUrl,
  total_analyzed: posts.length,
  top10,
  patterns,
  fecha: new Date().toLocaleDateString('es-ES')
};

// Save to reports
reports.unshift({
  id: result.id,
  type: 'h2',
  url: profileUrl,
  platform: result.platform,
  fecha: result.fecha,
  data: result
});

res.json(result);
```

} catch (e) {
console.error(‘H2 error:’, e.message);
res.status(500).json({ error: e.message });
}
});

// ── REPORTS ───────────────────────────────────────────────────────────────────
app.get(’/api/reports’, (req, res) => {
res.json(reports.slice(0, 50));
});

app.get(’/api/reports/:id’, (req, res) => {
const report = reports.find(r => r.id === req.params.id);
if (!report) return res.status(404).json({ error: ‘Report not found’ });
res.json(report);
});

app.delete(’/api/reports/:id’, (req, res) => {
const idx = reports.findIndex(r => r.id === req.params.id);
if (idx === -1) return res.status(404).json({ error: ‘Report not found’ });
reports.splice(idx, 1);
res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Viral Analyzer v2 running on port ${PORT}`));
