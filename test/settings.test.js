/**
 * DSH 0.2 settings integration tests. The Loader owns the namespace and
 * SettingsForms only presents Config fields marked volatile().
 * @module dsh-run-guard/test/settings
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config, resolveConfig, SETTINGS_NAMESPACE } from '../lib/index.js';

function makeVolatile(initial) {
  let value = initial;
  return {
    get: () => value,
    set: (next) => { value = next; },
  };
}

/** Full Cordis-like context with DSH 0.2 settings and optional web server. */
function createCtx({ settingsValue = {}, configureThrows = false } = {}) {
  const listeners = new Map();
  const contextDefs = [];
  const tools = [];
  const routeDefs = [];
  const effects = [];
  const configured = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return disposer;
    },
    systemPrompt: { context: (def) => contextDefs.push(def) },
    tools: { register: (def) => tools.push(def) },
    agents: { get: () => undefined },
    sessions: { get: () => ({ append: () => {} }) },
    sessionPersistence: { readFrom: async () => ({ events: [] }) },
    inject(deps, callback) {
      if (deps.includes('settings') || deps.includes('webServer')) callback(this);
    },
    get(name) {
      return name === 'webServer' ? this.webServer : undefined;
    },
    webServer: {
      register: (def) => {
        routeDefs.push(def);
        return () => {
          const index = routeDefs.indexOf(def);
          if (index >= 0) routeDefs.splice(index, 1);
        };
      },
    },
    settings: {
      configure(presentation, owner) {
        if (configureThrows) throw new Error('settings presentation unavailable');
        configured.push({ presentation, owner });
        return () => {};
      },
      describe: () => [
        { ns: SETTINGS_NAMESPACE, value: settingsValue, revision: 1 },
      ],
      mutate: async (nsName, ops) => {
        assert.equal(nsName, SETTINGS_NAMESPACE);
        for (const op of ops) {
          if (op.op !== 'set') continue;
          let current = settingsValue;
          for (let i = 0; i < op.path.length - 1; i++) {
            current[op.path[i]] ??= {};
            current = current[op.path[i]];
          }
          current[op.path.at(-1)] = op.value;
        }
      },
    },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
    _contextDefs: contextDefs,
    _tools: tools,
    _routes: routeDefs,
    _effects: effects,
    _configured: configured,
  };
  return ctx;
}

function recoveryPayload() {
  return {
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    failure: { message: 'x', code: 'REASONING_GUARD' },
    signal: new AbortController().signal,
  };
}

test('Config 的可编辑字段全部标记为 volatile', () => {
  const json = Config.toJSON();
  const field = ref => json.refs[String(ref)];
  assert.equal(field(json.refs['101'].dict.enabled).meta.volatile, true);
  assert.equal(field(json.refs['90'].dict.maxGuardRetries).meta.volatile, true);
  assert.equal(field(json.refs['100'].dict.maxAutoFollowups).meta.volatile, true);
});

test('有 settings 服务时:调用 configure({ auto:false }) 并注册设置路由', () => {
  const ctx = createCtx();
  apply(ctx, resolveConfig());
  assert.equal(ctx._configured.length, 1);
  assert.deepEqual(ctx._configured[0].presentation, { auto: false });
  assert.equal(ctx._routes.length, 1);
  assert.equal(ctx._routes[0].kind, 'prefix');
  assert.equal(ctx._routes[0].path, '/run-guard/api');
  assert.equal(typeof ctx._routes[0].handler, 'function');
});

test('settings 路由由 effect 管理:插件卸载时移除路由', () => {
  const ctx = createCtx();
  apply(ctx, resolveConfig());
  assert.equal(ctx._routes.length, 1);
  assert.equal(typeof ctx._effects.at(-1), 'function');
  ctx._effects.at(-1)();
  assert.equal(ctx._routes.length, 0);
});

test('settings 不是运行时配置源: Loader config 仍决定初始重试上限', async () => {
  const ctx = createCtx({ settingsValue: { guard: { maxGuardRetries: 5 } } });
  apply(ctx, resolveConfig({ guard: { maxGuardRetries: 1 } }));
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  assert.deepEqual(await listener(recoveryPayload(), next), { kind: 'retry' });
  assert.equal(await listener(recoveryPayload(), next), undefined);
});

test('volatile 配置更新后:运行时读取新值', async () => {
  const maxRetries = makeVolatile(1);
  const ctx = createCtx();
  apply(ctx, {
    ...resolveConfig(),
    guard: {
      ...resolveConfig().guard,
      maxGuardRetries: maxRetries,
    },
  });
  const listener = ctx._listeners('agent/request-error')[0];
  const next = async () => undefined;
  assert.deepEqual(await listener(recoveryPayload(), next), { kind: 'retry' });
  assert.equal(await listener(recoveryPayload(), next), undefined);
  maxRetries.set(2);
  assert.deepEqual(await listener({ ...recoveryPayload(), turn: 2 }, next), { kind: 'retry' });
  assert.deepEqual(await listener({ ...recoveryPayload(), turn: 2 }, next), { kind: 'retry' });
  assert.equal(await listener({ ...recoveryPayload(), turn: 2 }, next), undefined);
});

test('settings configure 抛错不阻断插件挂载', () => {
  const ctx = createCtx({ configureThrows: true });
  apply(ctx, resolveConfig({ guard: { maxGuardRetries: 3 } }));
  assert.ok(ctx._listeners('llm/stream').length >= 1, '仍应挂载 guard');
  assert.ok(ctx._listeners('agent/request-error').length >= 1, '仍应挂载 recovery');
});

test('无 settings 服务时:直接使用 Loader config', () => {
  const listeners = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context: () => {} },
    tools: { register: () => {} },
    agents: { get: () => undefined },
    sessions: { get: () => ({ append: () => {} }) },
    sessionPersistence: { readFrom: async () => ({ events: [] }) },
    _listeners(name) {
      return listeners.get(name) ?? [];
    },
  };
  apply(ctx, resolveConfig({ guard: { enabled: false } }));
  assert.equal(ctx._listeners('llm/stream').length, 0, 'guard 关闭不挂载');
  assert.ok(ctx._listeners('session/event').length >= 1, 'continue 仍挂载');
});

test('路由 handler:settings.get 返回当前值(revision)', async () => {
  const ctx = createCtx({ settingsValue: { guard: { maxGuardRetries: 4 } } });
  apply(ctx, resolveConfig());
  const handler = ctx._routes[0].handler;
  const req = {
    method: 'POST',
    url: 'http://dsh.internal/run-guard/api/settings.get',
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({});
    },
  };
  let responseBody;
  const res = {
    writeHead: (status) => { res.status = status; },
    end: (payload) => { responseBody = JSON.parse(payload); },
  };
  await handler(req, res);
  assert.equal(res.status, 200);
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.value.value.guard.maxGuardRetries, 4);
});
