/**
 * dsh-run-guard: agent run-rhythm guard for DeepSeek Harness.
 *
 * Merged from dsh-reasoning-guard + todo-continue:
 *  - guard: intercepts `llm/stream`, detects reasoning dead loops
 *    (sliding-window repeat ratio + hard per-call caps) and terminates the
 *    stream with a `REASONING_GUARD` error finish.
 *  - continue: after a turn ends, resumes execution — with pending todos it
 *    injects the todo status and guidance; without todos but a
 *    "thought-only stop" (last assistant/message has only reasoning) it
 *    injects a todo-free continuation, unbounded. `pause_work` suppresses it.
 *
 * @module dsh-run-guard
 */
import z from '@deepseek-ai/schemastery';
import { applyGuard, applyGuardRecovery, probeAgentScopedEvents, selfCheckRecovery } from './guard.js';
import { applyContinue } from './continue.js';
import { debugLog } from './debug.js';

/** Settings namespace exposed to the DSH Settings shell (client section id). */
export const SETTINGS_NAMESPACE = 'run-guard';

/** Bounded JSON body reader for the settings API routes. */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > 1 << 20) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('malformed JSON body');
  }
}

/** Write a JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * Register the /run-guard/api settings routes (settings.get / settings.update).
 * These bypass the host apiproxy allow-list (WEB_SETTINGS_NAMESPACES) so the
 * plugin's own Settings shell section can read/write its namespace directly
 * through the settings service — same pattern as dsh-better-sidebar.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context owning the route effect.
 * @param {object} settings - DSH 0.2 SettingsForms service.
 * @param {object | undefined} webServer - optional host web server service.
 */
function registerSettingsRoutes(ctx, settings, webServer) {
  if (typeof webServer?.register !== 'function') return;
  const route = {
    kind: 'prefix',
    path: '/run-guard/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith('/run-guard/api/') ? pathname.slice('/run-guard/api/'.length) : undefined;
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } });
        return;
      }
      const viewOf = () => {
        const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === SETTINGS_NAMESPACE);
        return descriptor === undefined
          ? { value: undefined, revision: undefined }
          : { value: descriptor.value, revision: descriptor.revision };
      };
      try {
        const body = await readJsonBody(req);
        if (method === 'settings.get') {
          writeJson(res, 200, { ok: true, value: viewOf() });
          return;
        }
        if (method === 'settings.update') {
          const ops = Array.isArray(body?.ops) ? body.ops : null;
          if (ops === null) throw new Error('ops must be an array of path edits');
          const expectedRevision = typeof body?.expectedRevision === 'number' ? body.expectedRevision : undefined;
          await settings.mutate(SETTINGS_NAMESPACE, ops, expectedRevision);
          writeJson(res, 200, { ok: true, value: viewOf() });
          return;
        }
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } });
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: { code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };
  const register = () => webServer.register(route);
  if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-run-guard: settings routes');
  else register();
}

/** Plugin display name registered with the Cordis loader. */
export const name = 'dsh-run-guard';

/** Services consumed by the two halves. Settings and webServer are optional. */
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'sessionPersistence'];

/** Schemastery schema; editable live fields are volatile in DSH 0.2. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  guard: z.object({
    enabled: z.boolean().default(true).volatile(),
    windowChars: z.number().step(1).min(64).max(1000000).default(2000).volatile(),
    substrLen: z.number().step(1).min(8).max(128).default(32).volatile(),
    repeatRatio: z.number().min(0).max(1).default(0.7).volatile(),
    checkEvery: z.number().step(1).min(1).max(100000).default(50).volatile(),
    maxBlocks: z.number().step(1).min(100).default(10000).volatile(),
    maxChars: z.number().step(1).min(1000).default(500000).volatile(),
    maxGuardRetries: z.number().step(1).min(0).max(10).default(2).volatile(),
    autoRetryErrors: z.array(z.string()).default(['PI_AI_ERROR']).volatile(),
  }).default({}),
  continue: z.object({
    enabled: z.boolean().default(true).volatile(),
    maxAutoFollowups: z.number().min(1).max(20).default(3).volatile(),
  }).default({}),
});

/** Read either an ordinary value or a DSH volatile reference. */
function readValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Resolve a possibly-partial config to complete plain values. The recursive
 * read keeps direct unit-test callers and DSH's volatile Config output on the
 * same API, while runtime users always receive detached snapshots.
 */
export function resolveConfig(config) {
  const source = readValue(config) ?? {};
  const guard = readValue(source.guard) ?? {};
  const cont = readValue(source.continue) ?? {};
  return {
    enabled: readValue(source.enabled) ?? true,
    guard: {
      enabled: readValue(guard.enabled) ?? true,
      windowChars: readValue(guard.windowChars) ?? 2000,
      substrLen: readValue(guard.substrLen) ?? 32,
      repeatRatio: readValue(guard.repeatRatio) ?? 0.7,
      checkEvery: readValue(guard.checkEvery) ?? 50,
      maxBlocks: readValue(guard.maxBlocks) ?? 10000,
      maxChars: readValue(guard.maxChars) ?? 500000,
      maxGuardRetries: readValue(guard.maxGuardRetries) ?? 2,
      autoRetryErrors: readValue(guard.autoRetryErrors) ?? ['PI_AI_ERROR'],
    },
    continue: {
      enabled: readValue(cont.enabled) ?? true,
      maxAutoFollowups: readValue(cont.maxAutoFollowups) ?? 3,
    },
  };
}

/**
 * Build a nested live view. DSH updates volatile leaves in place; each scalar
 * read below therefore observes the latest Settings value without remounting
 * listeners or tools.
 */
function liveConfig(config) {
  const proxies = new Map();
  const at = path => {
    const cacheKey = path.join('.');
    const existing = proxies.get(cacheKey);
    if (existing) return existing;
    const proxy = new Proxy({}, {
      get(_target, key) {
        if (key === 'toJSON') return () => path.reduce((value, part) => value?.[part], resolveConfig(config));
        if (key === 'then') return undefined;
        if (typeof key !== 'string') return undefined;
        const nextPath = [...path, key];
        const value = nextPath.reduce((current, part) => current?.[part], resolveConfig(config));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? at(nextPath) : value;
      },
    });
    proxies.set(cacheKey, proxy);
    return proxy;
  };
  return at([]);
}

/** Combine the master switch with one half's live switch. */
function withMasterSwitch(section, root) {
  return new Proxy(section, {
    get(target, key, receiver) {
      if (key === 'enabled') return Boolean(root.enabled && Reflect.get(target, key, receiver));
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Cordis plugin entry: mount both halves.
 *
 * Configuration source: the Loader-owned `config` object is always used. In a
 * DSH 0.2 host its volatile leaves are updated in place by SettingsForms, so
 * the listeners below read the latest values on each event. Settings setup and
 * the custom browser route are optional enhancements and never gate mounting.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - validated plugin config (fallback source).
 */
export function apply(ctx, config) {
  const live = liveConfig(config);
  const initial = resolveConfig(config);
  const guardConfig = withMasterSwitch(live.guard, live);
  const continueConfig = withMasterSwitch(live.continue, live);
  let guardMounted = false;
  let continueMounted = false;
  const mountGuard = () => {
    if (guardMounted) return;
    applyGuard(ctx, guardConfig);
    applyGuardRecovery(ctx, guardConfig);
    probeAgentScopedEvents(ctx);
    void selfCheckRecovery(ctx);
    guardMounted = true;
  };
  const mountContinue = () => {
    if (continueMounted) return;
    applyContinue(ctx, continueConfig);
    continueMounted = true;
  };

  // Register enabled halves once. Their event handlers read volatile values at
  // dispatch time, while the update listener can activate a half that started
  // disabled without duplicating listeners. A half disabled at startup stays
  // absent until the host emits its standard volatile-update event.
  if (initial.enabled && initial.guard.enabled) mountGuard();
  if (initial.enabled && initial.continue.enabled) mountContinue();
  ctx.on?.('loader/volatile-update', () => {
    const next = resolveConfig(config);
    if (next.enabled && next.guard.enabled) mountGuard();
    if (next.enabled && next.continue.enabled) mountContinue();
  });
  if (initial.enabled) {
    ctx.logger?.info(
      `[dsh-run-guard] plugin loaded: guard=${initial.guard.enabled} continue=${initial.continue.enabled} maxGuardRetries=${initial.guard.maxGuardRetries}`
    );
    debugLog(`plugin loaded guard=${initial.guard.enabled} continue=${initial.continue.enabled} maxGuardRetries=${initial.guard.maxGuardRetries}`);
  } else debugLog('plugin disabled by config');

  // SettingsForms discovers Config from the Loader entry. Do not register a
  // second namespace: configure() only opts this entry out of auto-generated UI.
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.settings;
    try {
      settingsCtx.effect?.(() => settings.configure({ auto: false }, ctx.fiber), 'dsh-run-guard: settings presentation');
      // The Settings service can be ready before the web server. Keep route
      // registration in a separate optional injection so headless profiles
      // still get SettingsForms without blocking core plugin mounting.
      settingsCtx.inject?.(['webServer'], webCtx => {
        registerSettingsRoutes(webCtx, settings, webCtx.webServer);
      });
    } catch (error) {
      settingsCtx.logger?.warn?.(`[dsh-run-guard] settings integration unavailable: ${error?.message ?? error}`);
    }
  });
}
