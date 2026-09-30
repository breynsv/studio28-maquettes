/**
 * Mot de passe sur tout ce qui vit sous /review.
 *
 * Pourquoi ici et pas dans le tableau de bord Cloudflare : l'outil doit rester
 * dans le même projet Pages que le site, et Access demande une configuration
 * séparée que personne ne retrouvera dans six mois. Ici, c'est dans le dépôt.
 *
 * Une fois le mot de passe donné, on pose un cookie qui porte le jeton de l'API.
 * Le client n'a donc plus qu'une adresse et un mot de passe à retenir — plus de
 * lien à rallonge avec un jeton dedans, qui traîne dans un historique ou un mail.
 * Le cookie est HttpOnly : le JavaScript de la page ne peut pas le lire, mais le
 * navigateur l'envoie à /api tout seul.
 *
 * Variables attendues (Cloudflare → Settings → Environment variables) :
 *   REVIEW_USER      l'identifiant  (défaut : studio28)
 *   REVIEW_PASSWORD  le mot de passe (secret)
 *   REVIEW_TOKEN     le jeton que l'API vérifie déjà
 */

/** Comparaison à temps constant : une comparaison naïve laisse deviner le secret. */
function egal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const DEMANDE = () =>
  new Response(
    "Cet espace est réservé. Demandez le mot de passe à Sven.",
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Studio 28 — espace de relecture", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );

export async function onRequest({ request, env, next }) {
  const attendu = env.REVIEW_PASSWORD;

  // Tant que REVIEW_PASSWORD n'est pas configuré, on retombe sur l'ancien
  // garde : le jeton dans l'adresse. Ce n'est jamais plus faible qu'avant, et
  // ça évite d'enfermer dehors le client entre la mise en ligne et le moment où
  // Sven pose la variable. Ce qu'on ne fait pas, c'est ouvrir en grand.
  if (!attendu) {
    const url = new URL(request.url);
    if (env.REVIEW_TOKEN && egal(url.searchParams.get('t') || '', env.REVIEW_TOKEN)) {
      const r = await next();
      const sortie = new Response(r.body, r);
      sortie.headers.set('x-robots-tag', 'noindex, nofollow');
      return sortie;
    }
    return DEMANDE();
  }

  const entete = request.headers.get('Authorization') || '';
  if (!entete.startsWith('Basic ')) return DEMANDE();

  let identifiant = '', motdepasse = '';
  try {
    const brut = atob(entete.slice(6));
    const i = brut.indexOf(':');
    identifiant = brut.slice(0, i);
    motdepasse = brut.slice(i + 1);
  } catch {
    return DEMANDE();
  }

  const bonUser = egal(identifiant, env.REVIEW_USER || 'studio28');
  const bonPass = egal(motdepasse, attendu);
  if (!bonUser || !bonPass) return DEMANDE();

  // next() une seule fois : chaque appel relance toute la chaîne.
  const r = await next();
  const sortie = new Response(r.body, r);
  sortie.headers.set('cache-control', 'no-store');
  sortie.headers.set('x-robots-tag', 'noindex, nofollow');
  if (env.REVIEW_TOKEN) {
    sortie.headers.append(
      'Set-Cookie',
      `s28=${env.REVIEW_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    );
  }
  return sortie;
}
