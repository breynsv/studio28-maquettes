/**
 * Studio 28 — API de l'outil de remarques (Cloudflare Pages Function).
 *
 * Remplace review-api.php. Même contrat, mais servi depuis le même domaine que la
 * maquette : aucun CORS, aucun second hébergement, rien à maintenir.
 *
 *   GET  /api/feedback?p=studio28&t=JETON     → { pins, counter, name, updated_at }
 *   POST /api/feedback?p=studio28&t=JETON     ← { pins, counter, name }
 *   POST /api/upload?p=studio28&t=JETON       ← multipart "photo"   → { url }
 *   POST /api/finalize?p=studio28&t=JETON     scelle un tour et prévient par mail
 *   POST /api/purge?p=smoke-xxx&t=JETON       efface un projet de TEST, et rien d'autre
 *   GET  /api/photo/<clef>                    → l'image
 *
 * Bindings attendus (voir wrangler.toml) :
 *   DB (ou D1)    D1        les remarques + leur historique
 *   PHOTOS        KV        les images
 *   REVIEW_TOKEN  secret    le jeton qui vaut mot de passe
 *   RESEND_API_KEY  secret  (facultatif) pour l'envoi du mail à la clôture
 *   REVIEW_MAIL_TO  var     (facultatif) destinataire, défaut sven@membrero.com
 *   REVIEW_MAIL_FROM var    (facultatif) expéditeur vérifié chez Resend
 *
 * Les clefs de photo sont aléatoires et indevinables : la lecture d'une image ne
 * demande donc pas le jeton, ce qui évite de le recopier dans chaque <img src>.
 */

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES   = 4 * 1024 * 1024;
const ALLOWED_IMAGES = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, message) => json({ error: message }, status);

/** Comparaison à temps constant : une comparaison naïve laisse deviner le jeton. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Un projet de test : « smoke-… » ou « test-… ». Ces projets ne déclenchent aucun
   mail et sont les seuls que /api/purge accepte d'effacer. La règle existe parce
   qu'un essai de la clôture, le 23 septembre 2026, a envoyé deux vrais mails. */
const EST_TEST = /^(smoke|test)\d*[-_]/;

function projectName(url) {
  const p = (url.searchParams.get('p') || 'studio28').toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,40}$/.test(p) ? p : null;
}

/** Rien de ce qui arrive du navigateur n'est écrit tel quel. */
function cleanPayload(data) {
  const pins = Array.isArray(data.pins) ? data.pins : [];
  return {
    pins: pins.slice(0, 500).map((p) => ({
      id:     String(p.id ?? '').slice(0, 40),
      n:      Number.isFinite(+p.n) ? +p.n : 0,
      sel:    String(p.sel ?? '').slice(0, 500),
      rx:     Number.isFinite(+p.rx) ? +p.rx : 0.5,
      ry:     Number.isFinite(+p.ry) ? +p.ry : 0.5,
      ctx:    String(p.ctx ?? '').slice(0, 300),
      text:   String(p.text ?? '').slice(0, 20000),
      status: ['ok', 'change', 'remove'].includes(p.status) ? p.status : 'change',
      mt:     Number.isFinite(+p.mt) ? +p.mt : 0,
      vw:     p.vw === 'phone' ? 'phone' : 'desktop',   // sur quel écran la remarque a été faite
      ver:    String(p.ver ?? '').slice(0, 40),          // sur quelle version de la maquette
      round:  Number.isFinite(+p.round) ? +p.round : 0,  // 0 = pas encore envoyé
      sealed: !!p.sealed,
      photos: (Array.isArray(p.photos) ? p.photos : [])
        .slice(0, 12)
        .map(String)
        .filter((u) => u.length < 2000),
    })),
    // Tombstones : sans elles, une suppression faite ici réapparaîtrait au prochain
    // enregistrement d'un autre onglet.
    deleted: (Array.isArray(data.deleted) ? data.deleted : [])
      .slice(0, 1000)
      .map((d) => ({ id: String(d.id ?? '').slice(0, 40), mt: Number.isFinite(+d.mt) ? +d.mt : 0 }))
      .filter((d) => d.id),
    counter: Number.isFinite(+data.counter) ? +data.counter : pins.length,
    name:    String(data.name ?? '').slice(0, 120),
  };
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS reviews (
         project    TEXT PRIMARY KEY,
         payload    TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS review_rounds (
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         project      TEXT NOT NULL,
         round        INTEGER NOT NULL,
         version      TEXT,
         name         TEXT,
         payload      TEXT NOT NULL,
         finalized_at TEXT NOT NULL,
         mail         TEXT
       )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS review_history (
         id       INTEGER PRIMARY KEY AUTOINCREMENT,
         project  TEXT NOT NULL,
         payload  TEXT NOT NULL,
         saved_at TEXT NOT NULL
       )`
    ),
  ]);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = (Array.isArray(params.path) ? params.path : [params.path]).filter(Boolean);
  const action = path[0] || '';

  /* ── une photo se lit sans jeton : sa clef est déjà indevinable ───────── */
  if (action === 'photo' && request.method === 'GET') {
    if (!env.PHOTOS) return fail(500, 'stockage des photos non configuré');
    const key = path.slice(1).join('/');
    if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(key)) return fail(400, 'clef invalide');

    const obj = await env.PHOTOS.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!obj || !obj.value) return fail(404, 'photo introuvable');
    return new Response(obj.value, {
      headers: {
        'content-type': obj.metadata?.contentType || 'application/octet-stream',
        // la clef ne change jamais de contenu : on peut mettre en cache longtemps
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  /* ── tout le reste demande le jeton ───────────────────────────────────── */
  const expected = env.REVIEW_TOKEN;
  if (!expected) return fail(500, "le jeton du serveur n'a pas été configuré");
  if (!safeEqual(expected, url.searchParams.get('t') || '')) return fail(403, 'lien invalide');

  const project = projectName(url);
  if (!project) return fail(400, 'projet invalide');
  /* Le nom de la liaison D1 dépend de ce qui a été choisi dans le tableau de bord.
     On accepte les deux plutôt que d'imposer une renomination. */
  const DB = env.DB || env.D1;
  if (!DB) return fail(500, 'base de données non configurée');

  /* ── les remarques ────────────────────────────────────────────────────── */
  if (action === 'feedback' && request.method === 'GET') {
    await ensureSchema(DB);
    const row = await DB.prepare('SELECT payload, updated_at FROM reviews WHERE project = ?')
      .bind(project)
      .first();
    if (!row) return json({ pins: [], counter: 0, name: '' });
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = { pins: [], counter: 0, name: '' }; }
    return json({ ...payload, updated_at: row.updated_at });
  }

  if (action === 'feedback' && request.method === 'POST') {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, 'contenu trop volumineux');

    let data;
    try { data = JSON.parse(raw); } catch { return fail(400, 'contenu invalide'); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.pins)) {
      return fail(400, 'contenu invalide');
    }

    const clean = cleanPayload(data);
    await ensureSchema(DB);

    /* Le verrou est imposé ICI, pas seulement dans l'interface. Une remarque déjà
       envoyée ne peut plus être modifiée ni supprimée, quoi qu'envoie le client :
       on réimpose la copie du serveur. Sans cela, un onglet resté ouvert ou une
       requête fabriquée suffirait à réécrire un retour que le client a signé. */
    const prev = await DB.prepare('SELECT payload FROM reviews WHERE project = ?')
      .bind(project).first();
    if (prev) {
      let old = null;
      try { old = JSON.parse(prev.payload); } catch {}
      const scelles = new Map(
        ((old && old.pins) || []).filter((p) => p.sealed).map((p) => [p.id, p])
      );
      if (scelles.size) {
        const vus = new Set();
        clean.pins = clean.pins.map((p) => {
          if (scelles.has(p.id)) { vus.add(p.id); return scelles.get(p.id); }
          return p;
        });
        // une remarque scellée que le client aurait « oubliée » est remise
        for (const [id, p] of scelles) if (!vus.has(id)) clean.pins.push(p);
        clean.pins.sort((a, b) => (a.n || 0) - (b.n || 0));
        // et une pierre tombale ne peut pas effacer un retour déjà envoyé
        clean.deleted = (clean.deleted || []).filter((d) => !scelles.has(d.id));
      }
    }

    /* Écriture conditionnelle. Le client annonce la version qu'il a lue ; si le
       serveur a bougé depuis (un autre onglet, un autre appareil), on refuse et on
       lui renvoie l'état courant pour qu'il fusionne. Sans ce garde-fou, deux
       onglets ouverts se recouvrent mutuellement et des remarques disparaissent. */
    const base = url.searchParams.get('base');
    if (base !== null) {
      const cur = await DB.prepare('SELECT payload, updated_at FROM reviews WHERE project = ?')
        .bind(project).first();
      const curVersion = cur ? cur.updated_at : '';
      if (base !== curVersion) {
        let current = { pins: [], counter: 0, name: '' };
        if (cur) { try { current = JSON.parse(cur.payload); } catch {} }
        return json({ conflict: true, current: { ...current, updated_at: curVersion } }, 409);
      }
    }

    const now = new Date().toISOString();
    const payload = JSON.stringify(clean);
    // On garde chaque version : un retour de client ne doit jamais pouvoir disparaître.
    await DB.batch([
      DB.prepare(
        `INSERT INTO reviews (project, payload, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(project) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).bind(project, payload, now),
      DB.prepare('INSERT INTO review_history (project, payload, saved_at) VALUES (?, ?, ?)')
        .bind(project, payload, now),
    ]);

    return json({ ok: true, count: clean.pins.length, updated_at: now });
  }

  /* ── l'envoi d'une photo ──────────────────────────────────────────────── */
  if (action === 'upload' && request.method === 'POST') {
    if (!env.PHOTOS) return fail(500, 'stockage des photos non configuré');

    const form = await request.formData();
    const file = form.get('photo');
    if (!file || typeof file === 'string') return fail(400, 'aucun fichier');
    if (file.size > MAX_UPLOAD_BYTES) return fail(413, 'photo trop lourde (8 Mo maximum)');

    const buf = await file.arrayBuffer();
    const type = sniffImage(new Uint8Array(buf));
    if (!type) return fail(415, 'seules les images sont acceptées');

    const id = crypto.randomUUID().replace(/-/g, '');
    const key = `${project}:${id}.${ALLOWED_IMAGES[type]}`;
    await env.PHOTOS.put(key, buf, {
      metadata: { contentType: type, name: String(file.name || '').slice(0, 120), at: new Date().toISOString() },
    });

    return json({ ok: true, url: `${url.origin}/api/photo/${key}`, key });
  }

  /* ── clôture d'un tour ────────────────────────────────────────────────── */
  if (action === 'finalize' && request.method === 'POST') {
    await ensureSchema(DB);

    const cur = await DB.prepare('SELECT payload, updated_at FROM reviews WHERE project = ?')
      .bind(project).first();
    if (!cur) return fail(400, 'aucune remarque à envoyer');

    let doc;
    try { doc = JSON.parse(cur.payload); } catch { return fail(500, 'données illisibles'); }

    const ouvertes = (doc.pins || []).filter((p) => !p.sealed);
    if (!ouvertes.length) return fail(400, 'aucune nouvelle remarque à envoyer');

    const last = await DB.prepare('SELECT MAX(round) AS n FROM review_rounds WHERE project = ?')
      .bind(project).first();
    const round = ((last && last.n) || 0) + 1;
    const now = new Date().toISOString();
    const version = String(ouvertes.find((p) => p.ver)?.ver || '');

    // On scelle : ces remarques ne bougeront plus, ni ici ni dans l'interface.
    doc.pins = (doc.pins || []).map((p) => (p.sealed ? p : { ...p, sealed: true, round }));
    const payload = JSON.stringify(doc);

    let mail;
    if (EST_TEST.test(project)) {
      mail = 'projet de test — aucun mail envoyé';
    } else {
      try { mail = await sendMail(env, project, round, version, doc.name, ouvertes, url.origin); }
      catch (e) { mail = 'échec : ' + String(e).slice(0, 180); }
    }

    await DB.batch([
      DB.prepare(`INSERT INTO review_rounds (project, round, version, name, payload, finalized_at, mail)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(project, round, version, String(doc.name || ''), JSON.stringify(ouvertes), now, mail),
      DB.prepare(`UPDATE reviews SET payload = ?, updated_at = ? WHERE project = ?`)
        .bind(payload, now, project),
    ]);

    return json({ ok: true, round, count: ouvertes.length, finalized_at: now, mail });
  }

  /* ── effacement d'un projet de test ───────────────────────────────────── */
  if (action === 'purge' && request.method === 'POST') {
    /* Volontairement incapable de toucher à un vrai projet : le nom doit annoncer
       qu'il s'agit d'un essai. Un outil de nettoyage qui peut effacer les remarques
       du client est plus dangereux que le désordre qu'il range. */
    if (!EST_TEST.test(project)) return fail(403, 'seuls les projets de test peuvent être effacés');
    await ensureSchema(DB);
    await DB.batch([
      DB.prepare('DELETE FROM review_rounds WHERE project = ?').bind(project),
      DB.prepare('DELETE FROM reviews WHERE project = ?').bind(project),
    ]);
    return json({ ok: true, purged: project });
  }

  if (action === 'rounds' && request.method === 'GET') {
    await ensureSchema(DB);
    /* Le contenu du tour est renvoyé aussi : c'est la seule copie figée d'un retour
       signé par le client, elle doit être relisible (sauvegarde et fetch-review). */
    const r = await DB.prepare(
      'SELECT round, version, name, finalized_at, mail, payload FROM review_rounds WHERE project = ? ORDER BY round'
    ).bind(project).all();
    const rows = (r.results || []).map((x) => {
      let pins = [];
      try { pins = JSON.parse(x.payload || '[]'); } catch {}
      const { payload, ...rest } = x;
      return { ...rest, count: pins.length, pins };
    });
    return json({ rounds: rows });
  }

  return fail(404, 'action inconnue');
}

/** Prévient par mail que le client a terminé. Silencieux si Resend n'est pas configuré. */
async function sendMail(env, project, round, version, name, pins, origin) {
  const key = env.RESEND_API_KEY;
  if (!key) return 'non configuré';

  const to   = env.REVIEW_MAIL_TO   || 'sven@membrero.com';
  /* Le domaine vérifié chez Resend est l'apex membrero.com ; send.membrero.com ne
     porte que les enregistrements SPF/MX et n'est PAS un expéditeur valide. */
  const from = env.REVIEW_MAIL_FROM || 'Studio 28 <studio28@membrero.com>';
  const LBL  = { ok: 'Ça me va', change: 'À changer', remove: 'À supprimer' };
  const esc  = (x) => String(x ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const lignes = pins.map((p) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e7ddcc;vertical-align:top;white-space:nowrap">
        <b>${esc(p.n)}</b><br>
        <span style="color:#8C4A2E;font-size:12px">${esc(LBL[p.status] || p.status)}</span>
        ${p.vw === 'phone' ? '<br><span style="color:#7C7468;font-size:11px">téléphone</span>' : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e7ddcc">
        ${esc(p.text) || '<i style="color:#9a948a">(sans texte)</i>'}
        <div style="color:#7C7468;font-size:12px;margin-top:4px">« ${esc(p.ctx)} »</div>
        ${(p.photos || []).length ? `<div style="font-size:12px;margin-top:4px">${p.photos.length} photo(s) jointe(s)</div>` : ''}
      </td>
    </tr>`).join('');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#33302B;max-width:640px">
      <h2 style="font-weight:600">${esc(name) || 'Le client'} a terminé ses remarques</h2>
      <p style="color:#6A6357">
        Projet <b>${esc(project)}</b> — retour n° <b>${round}</b> — <b>${pins.length}</b> remarque(s)
        ${version ? `sur la maquette <code>${esc(version)}</code>` : ''}.
      </p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">${lignes}</table>
      <p style="color:#6A6357;font-size:13px;margin-top:18px">
        Tout récupérer :<br>
        <code>python3 fetch-review.py ${esc(origin)}/api LE_JETON ${esc(project)}</code>
      </p>
    </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to: [to],
      subject: `Studio 28 — ${pins.length} remarque(s), retour n° ${round}`,
      html,
    }),
  });
  if (!r.ok) return `échec ${r.status} : ${(await r.text()).slice(0, 160)}`;
  return 'envoyé à ' + to;
}

/**
 * Le type est déterminé à partir des premiers octets, jamais d'après ce
 * qu'annonce le navigateur : un fichier peut mentir sur son content-type.
 */
function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return null;
}
