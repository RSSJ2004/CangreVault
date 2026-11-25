#!/usr/bin/env node
// Revisión visual en Chromium de todas las páginas con un backend SIMULADO.
//
// Uso:
//   VITE_SUPABASE_URL=https://qafixture.supabase.co VITE_SUPABASE_ANON_KEY=qa npx vite --port 4173 &
//   node scripts/visual-qa/run.mjs [carpetaSalida] [--only=ruta1,ruta2] [--vp=desktop,mobile] [--scenario=full|empty]
//
// Intercepta todas las peticiones a https://qafixture.supabase.co y responde con
// scripts/visual-qa/fixture.mjs (forma de PostgREST). Realtime y Edge Functions no
// existen en este entorno: se muestran como "sin conexión"/error, que también es un
// estado que hay que ver. Guarda capturas, desbordamientos horizontales y errores
// de consola en <salida>/report.json.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixture, USER_ID } from './fixture.mjs';

// Playwright viene preinstalado en el entorno (no es dependencia del proyecto): require global.
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'visual-qa-out';
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const BASE = process.env.QA_BASE_URL ?? 'http://localhost:4173';
const API = 'https://qafixture.supabase.co';
const today = new Date().toISOString().slice(0, 10);

const ROUTES = [
  ['simple', '/simple', 'simple'], ['simple-movimientos', '/simple/movimientos', 'simple'],
  ['dashboard', '/dashboard', 'normal'], ['diario', '/diario', 'normal'], ['resultados', '/resultados', 'normal'],
  ['tarjeta', '/tarjeta', 'normal'], ['recurrentes', '/recurrentes', 'normal'], ['metas', '/metas', 'normal'],
  ['simulador', '/simulador', 'normal'], ['conciliar', '/conciliar', 'normal'], ['importar', '/importar', 'normal'],
  ['exportar', '/exportar', 'normal'], ['asesor', '/asesor', 'normal'], ['ajustes', '/ajustes', 'normal'], ['guia', '/guia', 'normal'],
  ['login', '/login', 'anon'], ['bienvenida', '/bienvenida', 'onboarding'],
];
const VIEWPORTS = {
  wide: { width: 1600, height: 1000 }, laptop: { width: 1280, height: 800 }, tablet: { width: 820, height: 1180 }, mobile: { width: 390, height: 844 },
};

const only = opt('only')?.split(',');
const vps = (opt('vp') ?? 'wide,laptop,tablet,mobile').split(',');
const scenario = opt('scenario') ?? 'full';
const fullPage = !args.includes('--viewport-only');

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'qa@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const session = {
  access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: USER_ID, exp, role: 'authenticated' })}.qa`,
  token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'qa-refresh', user,
};

async function routeApi(page, data) {
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/auth/v1/user')) return json(user);
    if (url.pathname.startsWith('/auth/v1/')) return json({});
    if (url.pathname.startsWith('/functions/v1/')) return json({ error: 'Servicio de IA no disponible en el entorno de QA' }, 503);
    const m = url.pathname.match(/^\/rest\/v1\/(?:rpc\/)?([a-z_]+)/);
    if (!m) return json({});
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return json([]);
    let rows = data[m[1]] ?? [];
    for (const [k, v] of url.searchParams) {
      if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
    }
    return json(rows);
  });
}

const report = [];
const browser = await chromium.launch();
mkdirSync(outDir, { recursive: true });
for (const vpName of vps) {
  const vp = VIEWPORTS[vpName];
  for (const [name, path, kind] of ROUTES) {
    if (only && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: 'es-DO', timezoneId: 'America/Santo_Domingo' });
    const page = await ctx.newPage();
    const data = buildFixture(scenario, today);
    if (kind === 'onboarding') data.profiles[0].onboarding_completed_at = null;
    await routeApi(page, data);
    await page.addInitScript(([s, mode, anon]) => {
      try {
        if (!anon) localStorage.setItem('sb-qafixture-auth-token', JSON.stringify(s));
        localStorage.setItem('cangrevault.mode', mode);
      } catch { /* */ }
    }, [session, kind === 'simple' ? 'simple' : 'normal', kind === 'anon']);
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|realtime|fonts\.g|ERR_NAME|net::|503/i.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > w + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
          let p = el.parentElement, clipped = false;
          while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break; } p = p.parentElement; }
          if (!clipped) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: w, offenders: offenders.slice(0, 8) };
    });
    const file = join(outDir, `${vpName}-${name}${scenario === 'empty' ? '-empty' : ''}.png`);
    await page.screenshot({ path: file, fullPage });
    const h1 = await page.locator('h1').allInnerTexts();
    report.push({ vp: vpName, name, scenario, file, h1, errors, overflow: overflow.scrollWidth > overflow.clientWidth ? overflow : null });
    console.log(`${vpName.padEnd(7)} ${name.padEnd(20)} ${overflow.scrollWidth > overflow.clientWidth ? 'OVERFLOW ' : ''}${errors.length ? `ERR(${errors.length}) ` : ''}${h1.join(' | ')}`);
    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const bad = report.filter((r) => r.errors.length || r.overflow);
console.log(`\n${report.length} capturas · ${bad.length} con problemas`);
process.exit(bad.length ? 1 : 0);
