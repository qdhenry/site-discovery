/**
 * The page a service Worker shows at its own address.
 *
 * A MicroDot's service answers `/rpc` and has no site, so opening its address
 * in a browser used to give an empty 404, which reads as a broken deploy. This
 * is what the Worker shell answers there instead: a branded page that says the
 * service is running, what an owner does next, and that a visitor who followed
 * a link has found nothing broken.
 *
 * FOUR RULES, and the tests hold each one.
 *
 *  * **It says only what the address already says.** No version, no build, no
 *    state of any secret or cap. "Running" means the Worker answered.
 *  * **The name is the first label of the hostname, and the hostname is input
 *    from the network.** It is checked against hostname characters before it
 *    is used, and escaped anyway. Anything else gets the page with no name.
 *  * **No script.** The policy header allows the page's own styles, an inline
 *    icon and the two brand fonts, and nothing else.
 *
 * The owner's first button opens the Platform, which sits behind a sign-in:
 * a stranger who follows it meets the sign-in and nothing more.
 *  * **It is one string.** No file, no asset binding, no build step: a Worker
 *    entry stays one call.
 *
 * The look is the MicroDots Web Design System's, the way
 * `apps/coming-soon/public/index.html` inlines it. The design and its rulings
 * are in `wiki/plans/active/service-landing-page.md`.
 */

const PLATFORM_URL = 'https://platform.microdots.cloud/'
const DOCS_URL = 'https://docs.microdots.cloud/'
const SITE_URL = 'https://microdots.cloud/'
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=DM+Mono&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap'

/** A DNS hostname: labels of letters, digits and inner hyphens, 253 at most. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, char => ESCAPES[char] ?? char)

export type LandingName = {
  /** The first label: `storefront-agent`. What the title names. */
  readonly label: string
  /** The whole hostname, for the footer. */
  readonly hostname: string
}

/**
 * The service's name as its address gives it. `undefined` for anything that is
 * not a plain hostname, an address made of numbers included: the page then
 * names nothing rather than repeat what it was sent.
 */
export const landingName = (host: string): LandingName | undefined => {
  const hostname = host.trim().toLowerCase().replace(/\.$/, '')
  if (!HOSTNAME.test(hostname) || IPV4.test(hostname)) return undefined
  const [label] = hostname.split('.')
  return label === undefined ? undefined : { label, hostname }
}

/** The 3 by 3 mark, as an icon the page carries with it. */
const ICON_ROWS: ReadonlyArray<number> = [6.4, 16, 25.6]
const ICON_COLUMNS: ReadonlyArray<readonly [number, number]> = [
  [6.4, 1],
  [16, 0.7],
  [25.6, 0.45],
]
const ICON_DOTS = ICON_ROWS.flatMap(cy =>
  ICON_COLUMNS.map(
    ([cx, opacity]) =>
      `<circle cx="${cx}" cy="${cy}" r="3" opacity="${opacity}"/>`,
  ),
).join('')
const ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g transform="rotate(-8 16 16)" fill="#2563eb">${ICON_DOTS}</g></svg>`,
)}`

const DOTS = '<span></span>'.repeat(9)

const STYLES = `
:root{--page:#f8fafc;--surface:#fdfeff;--border:#e2e8f0;--heading:#0f172a;--text:#0f172a;--secondary:#3d4a5e;--muted:#515f74;--accent:#1d4ed8;--accent-hover:#2563eb;--on-brand:#ffffff;--wordmark:#1e293b;--brand:#2563eb;--ok:#16a34a;--ok-bg:rgba(22,163,74,.07);--ok-border:rgba(22,163,74,.15);--marker:#fcda65;--violet:#8b3dff;--cyan:#00e5ff;--amber:#ffc400;--crimson:#ff1e5a;--jade:#00e676;--sans:"DM Sans",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;--mono:"DM Mono","SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--page:#050509;--surface:#0a0e1a;--border:#1a2038;--heading:#d0daf0;--text:#c8d4e8;--secondary:#9bacd4;--muted:#8194bc;--accent:#60a5fa;--accent-hover:#93c5fd;--wordmark:#93afd0;--ok:#4ade80;--ok-bg:rgba(74,222,128,.08);--ok-border:rgba(74,222,128,.15);--marker:#9b7804}.btn{--accent:#1d4ed8;--accent-hover:#2563eb}}
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;position:relative;overflow-x:hidden;font-family:var(--sans);font-size:16px;line-height:1.6;background:var(--page);color:var(--text);-webkit-font-smoothing:antialiased}
a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.confetti{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.confetti i{position:absolute;display:block}
@media (max-width:760px){.confetti{display:none}}
main{position:relative;flex:1;width:100%;max-width:760px;margin:0 auto;padding:clamp(32px,8vw,88px) clamp(20px,6vw,40px) 48px;display:flex;flex-direction:column;gap:22px}
.mark-hop{align-self:flex-start;animation:hop 1.6s ease-in-out infinite}
.mark{display:grid;grid-template-columns:repeat(3,9px);gap:5px;transform:rotate(-8deg)}
.mark span,.brand-grid span{display:block;border-radius:50%;background:var(--brand)}
.mark span{width:9px;height:9px}
.mark span:nth-child(3n+2),.brand-grid span:nth-child(3n+2){opacity:.7}
.mark span:nth-child(3n),.brand-grid span:nth-child(3n){opacity:.45}
.eyebrow{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:1.5;letter-spacing:.06em;padding:3px 8px;border-radius:999px;color:var(--ok);background:var(--ok-bg);border:1px solid var(--ok-border)}
.pill i{width:6px;height:6px;border-radius:50%;background:var(--ok)}
h1{margin:0;font-size:clamp(34px,6.4vw,60px);line-height:1.06;letter-spacing:-.03em;font-weight:600;color:var(--heading);text-wrap:balance;overflow-wrap:anywhere}
.swipe{position:relative;isolation:isolate;white-space:nowrap}
.swipe i{position:absolute;left:-.06em;right:-.06em;bottom:.04em;height:.36em;background:var(--marker);border-radius:4px;transform:rotate(-1.4deg);z-index:-1}
.lede{margin:0;font-size:clamp(17px,2.2vw,19px);color:var(--secondary);max-width:560px;text-wrap:pretty}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px;margin-top:6px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.card p{margin:0;font-size:15px;color:var(--secondary)}
.card .label{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
h2{margin:0;font-size:20px;line-height:1.3;font-weight:600;color:var(--heading)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.btn{display:inline-flex;font-size:14px;line-height:1.4;font-weight:600;padding:9px 15px;border-radius:8px;background:var(--accent);color:var(--on-brand);text-decoration:none}
.btn:hover{background:var(--accent-hover)}
.btn.quiet{background:transparent;color:var(--text);border:1px solid var(--border);padding:8px 14px;font-weight:500}
.btn.quiet:hover{background:transparent;border-color:var(--muted)}
.link{margin-top:6px;font-size:14px;font-weight:600;color:var(--accent);text-decoration:none}
.link:hover{color:var(--accent-hover)}
footer{position:relative;border-top:1px solid var(--border);background:var(--surface)}
.foot{max-width:760px;margin:0 auto;padding:16px clamp(20px,6vw,40px);display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;justify-content:space-between}
.brand{display:inline-flex;align-items:center;gap:10px;line-height:1;text-decoration:none}
.brand-grid{display:inline-grid;grid-template-columns:repeat(3,5px);gap:3px;transform:rotate(-8deg)}
.brand-grid span{width:5px;height:5px}
.brand b{font-size:18px;font-weight:650;letter-spacing:-.7px;color:var(--wordmark)}
.meta{font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--muted);overflow-wrap:anywhere;min-width:0}
@keyframes hop{0%,55%,100%{transform:translateY(0)}25%{transform:translateY(-6px)}40%{transform:translateY(1px)}}
@keyframes drift{0%{transform:translate(0,0) rotate(0deg)}100%{transform:translate(6px,-14px) rotate(6deg)}}
@media (prefers-reduced-motion:reduce){.mark-hop,.confetti i{animation:none!important}}
`.trim()

const CONFETTI = [
  'width:150px;height:150px;top:-56px;right:-48px;border-radius:50%;background:var(--violet);animation:drift 6s ease-in-out infinite alternate',
  'width:16px;height:16px;top:44px;right:138px;border-radius:50%;background:var(--amber);animation:hop 2.25s ease-in-out -1s infinite',
  'width:44px;height:44px;top:214px;left:-20px;border-radius:50%;border:7px solid var(--jade)',
  'width:120px;height:16px;bottom:150px;right:-76px;border-radius:99px;background:var(--cyan);transform:rotate(-14deg)',
  'width:70px;height:70px;bottom:84px;left:-36px;border-radius:50%;background:var(--crimson);animation:drift 8s ease-in-out -2s infinite alternate',
]
  .map(style => `<i style="${style}"></i>`)
  .join('')

/** The whole page for one address. A pure function of the hostname. */
export const landingPage = (host: string): string => {
  const name = landingName(host)
  const subject = name === undefined ? 'This service' : escapeHtml(name.label)
  const where = name === undefined ? '' : `${escapeHtml(name.hostname)} · `

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${subject} is running</title>
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${ICON}">
<link rel="stylesheet" href="${FONTS_URL}">
<style>${STYLES}</style>
</head>
<body>
<div class="confetti" aria-hidden="true">${CONFETTI}</div>
<main>
<span class="mark-hop" aria-hidden="true"><span class="mark">${DOTS}</span></span>
<div class="eyebrow"><span>MicroDot service</span><span class="pill"><i></i>Running</span></div>
<h1>${subject} is <span class="swipe"><i aria-hidden="true"></i>running.</span></h1>
<p class="lede">This address is the service behind a MicroDot. It answers the component on the pages that embed it, so there is no site to browse here.</p>
<div class="cards">
<section class="card">
<p class="label">If you own this service</p>
<h2>Add it to a page.</h2>
<p>The service is up. Mount its component on your site and the component calls this address.</p>
<div class="actions"><a class="btn" href="${PLATFORM_URL}">Open the Platform</a><a class="btn quiet" href="${DOCS_URL}">Read the docs</a></div>
</section>
<section class="card">
<p class="label">If a link brought you here</p>
<h2>Nothing is broken.</h2>
<p>The page that uses this service lives on another site. Go back to the one that sent you.</p>
<a class="link" href="${SITE_URL}">What is a MicroDot? →</a>
</section>
</div>
</main>
<footer><div class="foot">
<a class="brand" href="${SITE_URL}" aria-label="MicroDots"><span class="brand-grid" aria-hidden="true">${DOTS}</span><b aria-hidden="true">microdots</b></a>
<span class="meta">${where}hosted on MicroDots</span>
</div></footer>
</body>
</html>
`
}

/**
 * What the page may load: its own styles, its inline icon and the two brand
 * fonts. No script source is named, so no script runs, whatever the markup
 * says.
 */
export const LANDING_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'cache-control': 'public, max-age=300',
}

/** `GET` or `HEAD` on `/`, and nothing else. */
export const asksForOwnAddress = (request: Request): boolean =>
  (request.method === 'GET' || request.method === 'HEAD') &&
  new URL(request.url).pathname === '/'

/** The page as a response. A `HEAD` gets the headers and no body. */
export const landingResponse = (request: Request): Response =>
  new Response(
    request.method === 'HEAD'
      ? null
      : landingPage(new URL(request.url).hostname),
    { status: 200, headers: LANDING_HEADERS },
  )
