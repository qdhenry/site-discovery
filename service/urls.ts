import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import type { CaptureInput } from '../src/contract.ts'
import { fail } from './config.ts'

export const isPublicAddress = (address: string): boolean => {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(a) === 4) {
    const [x = 0, y = 0, z = 0] = a.split('.').map(Number)
    return !(
      x === 0 ||
      x === 10 ||
      x === 127 ||
      x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || y === 0)) ||
      (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
      (x === 203 && y === 0 && z === 113) ||
      (x === 192 && ((y === 0 && z === 2) || (y === 88 && z === 99)))
    )
  }
  if (isIP(a) === 6)
    return (
      (a.startsWith('2') || a.startsWith('3')) &&
      !/^2001:(?:0:|db8:|2:|10:|20:)/.test(a) &&
      !a.startsWith('2002:') &&
      !a.startsWith('3ffe:')
    ) // global unicast only; mapped/local/link-local excluded
  return false
}
export function publicUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return fail('validation', 'Enter a complete public http(s) URL')
  }
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !['80', '443'].includes(u.port))
  )
    return fail(
      'validation',
      'Only public HTTP(S) URLs without credentials or custom ports are supported',
    )
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (!host.includes('.') && !isIP(host)) ||
    (isIP(host) && !isPublicAddress(host))
  )
    return fail('validation', 'Private and local destinations are not allowed')
  u.hash = ''
  return u
}
export async function resolvePublic(u: URL) {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const addresses = await lookup(host, { all: true })
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address)))
    return fail(
      'validation',
      'Destination DNS includes a private or reserved address',
    )
  return addresses[0]!
}
/** Pins the validated address into the socket lookup, validates each redirect, caps body/time. */
export async function fetchPublicText(
  raw: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<string> {
  const u = publicUrl(raw)
  if (redirects > 5) return fail('provider', 'Too many website redirects')
  const address = await resolvePublic(u)
  const result = await new Promise<{
    status: number
    location: string
    body: string
  }>((resolve, reject) => {
    const request = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        signal,
        agent: false,
        headers: {
          'user-agent': 'SiteDiscovery/1.0 (public website review)',
          accept: 'text/html,application/xml,text/xml,text/plain',
        },
        lookup: (_host, _options, cb) =>
          cb(null, address.address, address.family),
      },
      response => {
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2_000_000)
            request.destroy(new Error('Website document exceeds 2 MB'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location || '',
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.setTimeout(20_000, () =>
      request.destroy(new Error('Website request timed out')),
    )
    request.on('error', reject)
    request.end()
  })
  if (result.status >= 300 && result.status < 400 && result.location)
    return fetchPublicText(
      new URL(result.location, u).href,
      signal,
      redirects + 1,
    )
  if (result.status < 200 || result.status >= 300)
    return fail('provider', `Website returned HTTP ${result.status}`, true)
  return result.body
}
export function validateInput(input: CaptureInput): void {
  if (
    !Number.isInteger(input.depth) ||
    input.depth < 1 ||
    input.depth > 3 ||
    !Number.isInteger(input.maxPages) ||
    input.maxPages < 1 ||
    input.maxPages > 50
  )
    fail('validation', 'Depth must be 1–3 and the page cap 1–50')
  if (!input.desktop && !input.mobile)
    fail('validation', 'Choose at least one viewport')
  const urls =
    input.mode === 'batch'
      ? input.source
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean)
      : [input.source]
  if (!urls.length || urls.length > 50 || input.source.length > 30_000)
    fail('validation', 'Provide between 1 and 50 URLs')
  for (const url of urls) publicUrl(url)
}
export async function discoverUrls(
  input: CaptureInput,
  signal: AbortSignal,
): Promise<string[]> {
  validateInput(input)
  if (input.mode === 'batch')
    return [
      ...new Set(
        input.source
          .split(/\r?\n/)
          .filter(s => s.trim())
          .map(s => publicUrl(s).href),
      ),
    ].slice(0, input.maxPages)
  const first = publicUrl(input.source).href
  if (input.mode === 'single') return [first]
  if (input.evidenceMode === 'fixture')
    return [
      first,
      new URL('/about', first).href,
      new URL('/articles/example', first).href,
    ].slice(0, input.maxPages)
  if (input.mode === 'sitemap') {
    const xml = await fetchPublicText(first, signal)
    return [
      ...new Set(
        [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(
          m => publicUrl(m[1]!.replace(/&amp;/g, '&')).href,
        ),
      ),
    ].slice(0, input.maxPages)
  }
  const queue = [{ url: first, depth: 0 }]
  const seen = new Set([first])
  const result: string[] = []
  while (queue.length && result.length < input.maxPages) {
    const next = queue.shift()!
    result.push(next.url)
    if (next.depth >= input.depth) continue
    const html = await fetchPublicText(next.url, signal)
    for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      try {
        const u = publicUrl(new URL(match[1]!, next.url).href)
        if (
          u.origin === new URL(first).origin &&
          !seen.has(u.href) &&
          seen.size < input.maxPages
        ) {
          seen.add(u.href)
          queue.push({ url: u.href, depth: next.depth + 1 })
        }
      } catch {
        /* Non-public and non-HTTP links are not candidates. */
      }
    }
  }
  return result
}
export async function robotsAllowed(
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  let robots: string
  try {
    robots = await fetchPublicText(new URL('/robots.txt', url).href, signal)
  } catch {
    return true
  }
  let applies = false
  const path = new URL(url).pathname
  for (const line of robots.split(/\r?\n/)) {
    const [name = '', ...parts] = line.split(':')
    const value = parts.join(':').split('#')[0]!.trim()
    if (name.toLowerCase().trim() === 'user-agent') applies = value === '*'
    if (
      applies &&
      name.toLowerCase().trim() === 'disallow' &&
      value &&
      path.startsWith(value)
    )
      return false
  }
  return true
}
