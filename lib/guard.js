/**
 * Reasoning dead-loop detector: exact sliding-window repeat-ratio analysis
 * over a stream of reasoning text deltas, plus hard per-call caps.
 *
 * Pure logic, zero runtime dependencies — unit-testable in isolation.
 *
 * @module dsh-run-guard/guard
 */

/**
 * Create one detector instance. Each detector owns one streaming model call
 * (one `llm/stream` dispatch), so counters are per-call by construction.
 *
 * @param {object} config - resolved guard configuration.
 * @param {number} config.substrLen - fixed substring length used for repeat
 *   analysis (characters).
 * @param {number} config.windowChars - sliding window size in characters; the
 *   window keeps only the most recent text, so a past burst of repetition
 *   cannot keep the ratio elevated forever.
 * @param {number} config.repeatRatio - trigger threshold in [0, 1]; the
 *   detector fires when the share of non-unique substrings inside the window
 *   reaches this value.
 * @param {number} config.checkEvery - run the ratio check once per N pushed
 *   blocks (de-rate limiting; the check is O(window) so it must not run on
 *   the per-delta hot path).
 * @param {number} config.maxBlocks - hard cap: total reasoning blocks in one
 *   call. Fires regardless of repetition.
 * @param {number} config.maxChars - hard cap: total reasoning characters in
 *   one call. Fires regardless of repetition.
 * @returns {object} detector with `push(text)` and `stats()`.
 */
export function createReasoningGuard(config) {
  const { substrLen, windowChars, repeatRatio, checkEvery, maxBlocks, maxChars } = config;

  /** Current window text (length <= windowChars). */
  let window = '';
  /** Substring -> occurrence count inside the window (multiset). */
  const freq = new Map();
  /** Total substrings inside the window. */
  let totalSubstrs = 0;
  /** Cumulative reasoning blocks pushed into this detector. */
  let blocks = 0;
  /** Cumulative reasoning characters pushed into this detector. */
  let chars = 0;
  /** Blocks since the last ratio check. */
  let sinceCheck = 0;

  /**
   * Append `text` to the window and register every newly completed substring
   * of length `substrLen`.
   */
  function addSubstrs(text) {
    const combined = window + text;
    // New substring starts: everything past the last substring already fully
    // inside the old window (window.length - substrLen), i.e. starts that
    // could not exist before `text` was appended.
    const start = Math.max(0, window.length - substrLen + 1);
    for (let i = start; i + substrLen <= combined.length; i++) {
      const s = combined.slice(i, i + substrLen);
      freq.set(s, (freq.get(s) ?? 0) + 1);
      totalSubstrs++;
    }
    window = combined;
  }

  /**
   * Drop characters from the window head until it fits `windowChars`.
   * Removing one head character removes exactly one substring (the one
   * starting at the removed position); every other substring shifts left by
   * one position without changing content, so the multiset stays exact.
   */
  function trimWindow() {
    while (window.length > windowChars) {
      // 窗口长度小于子串长度时(仅 windowChars < substrLen 的退化配置会出现),
      // 窗口内没有完整子串,无需维护 freq——否则 slice 会取出从未入表的子串,
      // freq.get() 返回 undefined 导致 NaN 污染计数。
      if (window.length >= substrLen) {
        const s = window.slice(0, substrLen);
        const next = freq.get(s) - 1;
        if (next <= 0) freq.delete(s);
        else freq.set(s, next);
        totalSubstrs--;
      }
      window = window.slice(1);
    }
  }

  /**
   * Evaluate the current state.
   * @returns {{triggered: boolean, reason?: string, ratio?: number, blocks: number, chars: number}}
   */
  function check() {
    const result = { triggered: false, blocks, chars };
    if (totalSubstrs >= substrLen * 2) {
      const ratio = 1 - freq.size / totalSubstrs;
      result.ratio = ratio;
      if (ratio >= repeatRatio) {
        return { ...result, triggered: true, reason: 'repeat' };
      }
    }
    if (blocks >= maxBlocks) {
      return { ...result, triggered: true, reason: 'blocks' };
    }
    if (chars >= maxChars) {
      return { ...result, triggered: true, reason: 'chars' };
    }
    return result;
  }

  return {
    /**
     * Push one reasoning delta.
     * @param {string} text - delta text (may be empty).
     * @returns {null | {triggered: boolean, reason?: string, ratio?: number, blocks: number, chars: number}}
     *   a check result on de-rate boundaries, otherwise null.
     */
    push(text) {
      blocks++;
      chars += text.length;
      // 无长度守卫:真实 reasoning 流可能切成 1-9 字符的碎片(SSE 分块),
      // 短块追加后仍会在窗口尾部形成跨边界子串,必须始终进入分析。
      addSubstrs(text);
      trimWindow();
      sinceCheck++;
      if (sinceCheck >= checkEvery) {
        sinceCheck = 0;
        return check();
      }
      return null;
    },

    /** Current diagnostic snapshot. */
    stats() {
      return { blocks, chars, totalSubstrs, unique: freq.size };
    },
  };
}

/**
 * Reasoning dead-loop guard plugin half: intercepts `llm/stream`, feeds
 * reasoning deltas into the detector, and terminates the stream with a
 * `REASONING_GUARD` error finish when the detector fires.
 */

/** Stable failure code carried by the terminating finish chunk. */
export const REASONING_GUARD_CODE = 'REASONING_GUARD';

/** Trigger-reason -> human-readable cause (shown in the GUI turn error). */
const REASON_TEXT = {
  repeat: '重复率异常:模型持续输出高度重复的推理内容(疑似推理死循环)',
  blocks: '单次调用推理块数超过上限',
  chars: '单次调用推理字符数超过上限',
};

/**
 * Build the user-facing failure message. This text is what the GUI shows on
 * the interrupted turn, so it explains why the guard fired and what to do.
 * @param {object} verdict - detector verdict (triggered/reason/ratio/blocks/chars).
 * @param {object} config - resolved guard config (thresholds for the message).
 * @returns {string} multi-line Chinese explanation.
 */
export function guardMessage(verdict, config) {
  const ratioText = verdict.ratio === undefined ? 'n/a' : verdict.ratio.toFixed(3);
  const lines = [
    `推理输出疑似死循环,已被推理护栏中断。`,
    `原因: ${REASON_TEXT[verdict.reason] ?? verdict.reason}`,
    `触发时状态: ${verdict.blocks} 个推理块 / ${verdict.chars} 字符` +
      (verdict.ratio === undefined ? '' : `,窗口重复率 ${ratioText}`),
    `这是保护性中断:模型在空转输出,继续会浪费时间和 token。可直接继续对话或重试。`,
  ];
  return lines.join('\n');
}

/**
 * Register the `llm/stream` waterfall listener. Every streaming model call
 * passes through it; when the detector fires, the stream is terminated with
 * an error finish chunk. The listener never breaks a healthy stream:
 * detector failures degrade it to pure passthrough, and non-reasoning chunks
 * are forwarded untouched.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - resolved guard configuration (guard.enabled etc.).
 */
export function applyGuard(ctx, config) {
  ctx.on('llm/stream', (options, next) => {
    if (!config.enabled) return next();
    const stream = next();
    /** Per-call detector; null once degraded (detector error) or fired. */
    let guard = createReasoningGuard(config);
    return (async function* () {
      for await (const chunk of stream) {
        if (guard !== null && chunk.type === 'reasoning-delta') {
          try {
            const verdict = guard.push(chunk.text);
            if (verdict?.triggered) {
              const ratio = verdict.ratio === undefined ? 'n/a' : verdict.ratio.toFixed(3);
              ctx.logger.warn(
                `[dsh-run-guard] ${verdict.reason} 触发中断: ` +
                `blocks=${verdict.blocks} chars=${verdict.chars} ratio=${ratio}`
              );
              yield {
                type: 'finish',
                reason: {
                  kind: 'error',
                  failure: {
                    message: guardMessage(verdict, config),
                    code: REASONING_GUARD_CODE,
                  },
                },
              };
              guard = null;
              return;
            }
          } catch (error) {
            // Guard bugs must never break a healthy model stream.
            ctx.logger.warn(`[dsh-run-guard] 检测器异常,降级为透传: ${error?.message ?? error}`);
            guard = null;
          }
        }
        yield chunk;
      }
    })();
  });
}

import { debugLog } from './debug.js';

/**
 * Register `agent/request-error` recovery: when a request fails with a
 * retryable error — the guard's own REASONING_GUARD, plus any code listed in
 * config.autoRetryErrors (e.g. transient upstream failures like PI_AI_ERROR
 * that llm-retry does not own) — automatically retry the step instead of
 * failing the turn. Bounded per-turn (config.maxGuardRetries); once exceeded
 * the turn fails visibly for the user.
 *
 * Errors outside the retryable set are passed through untouched (llm-retry
 * owns SERVER/TIMEOUT/RATE_LIMIT/TRANSPORT etc.; persistent errors like
 * AUTH/QUOTA are never auto-retried).
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {object} config - resolved guard configuration.
 */
export function applyGuardRecovery(ctx, config) {
  /** sessionId -> turn -> consecutive recovery count for that turn. */
  const guardRetries = new Map();
  const retryableCodes = () => new Set([
    REASONING_GUARD_CODE,
    ...(config.autoRetryErrors ?? []),
  ]);

  ctx.on('agent/request-error', async (payload, next) => {
    if (config.enabled === false) return next();
    const retryable = retryableCodes();
    const code = payload.failure?.code;
    const retryableCode = typeof code === 'string' && retryable.has(code);
    ctx.logger?.info(
      `[dsh-run-guard][recovery] request-error code=${code} turn=${payload.turn} step=${payload.step} agent=${payload.agent?.id} retryable=${retryableCode}`
    );
    debugLog(`recovery:request-error code=${code} turn=${payload.turn} step=${payload.step} agent=${payload.agent?.id} retryable=${retryableCode}`);
    if (typeof code !== 'string' || !retryable.has(code)) return next();
    const sessionId = payload.agent?.id;
    if (sessionId === void 0) return next();
    let byTurn = guardRetries.get(sessionId);
    if (byTurn === void 0) {
      byTurn = new Map();
      guardRetries.set(sessionId, byTurn);
    }
    const count = (byTurn.get(payload.turn) ?? 0) + 1;
    byTurn.set(payload.turn, count);
    if (count <= config.maxGuardRetries) {
      const label = code === REASONING_GUARD_CODE ? '死循环中断' : `请求失败(${code})`;
      ctx.logger.warn(
        `[dsh-run-guard] ${label},自动重试 ${count}/${config.maxGuardRetries} (turn ${payload.turn} step ${payload.step})`
      );
      debugLog(`recovery:retry ${count}/${config.maxGuardRetries} code=${code} turn=${payload.turn} step=${payload.step}`);
      // append llm/retry 事件(复用 llm-retry 的事件名与结构),让重试在会话页面可见
      try {
        payload.agent?.session?.append?.('llm/retry', {
          retryId: `run-guard:${payload.turn}:${payload.step}:${count}`,
          turn: payload.turn,
          step: payload.step,
          provider: payload.provider,
          mode: 'normal',
          policyKey: 'dsh-run-guard:auto-retry',
          retry: count,
          maxRetries: config.maxGuardRetries,
          delayMs: 0,
          failure: payload.failure,
        });
      } catch (appendError) {
        ctx.logger?.warn(`[dsh-run-guard] 重试事件 append 失败: ${appendError?.message}`);
      }
      return { kind: 'retry' };
    }
    debugLog(`recovery:give-up code=${code} turn=${payload.turn} step=${payload.step} count=${count}`);
    // 超过上限:该 turn 不再自动重试,让错误可见(用户可手动继续)
    byTurn.delete(payload.turn);
    return undefined;
  }, { global: true }); // agent/request-error 是 scoped 事件,global 才能收到

  // turn 结束清理计数(新 turn 重新计数)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      guardRetries.get(session.id)?.delete(event.data.turn);
    }
  }, { global: true }); // 同上:scoped 事件需 global
}

/**
 * 自检(apply 时执行,无需等待真实死循环):用真实的 dsh-scope carrier
 * 模拟一次 agent/request-error scoped dispatch,验证 listener 是否真的
 * 在事件总线上被调用。结果写入 /tmp/dsh-run-guard.log。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 */
/**
 * 探测 agent-scoped 事件是否送达本插件(决定性验证):
 * 注册 agent/pre-step 监听(每个真实 step 都触发),记录日志。
 * 若日志出现真实 step 的 pre-step → agent-scoped 事件送达插件;
 * 若不出现 → agent-loop 的 loopCtx 与插件 ctx 不在同一事件总线(根因)。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 */
export function probeAgentScopedEvents(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    debugLog(`probe:agent/pre-step T${payload.turn} S${payload.step} agent=${payload.agent?.id}`);
    return next();
  }, { global: true });
}

export async function selfCheckRecovery(ctx) {
  const payload = {
    agent: { id: 'selfcheck' },
    turn: -999,
    step: -999,
    provider: 'selfcheck',
    failure: { message: 'selfcheck', code: REASONING_GUARD_CODE },
    signal: new AbortController().signal,
  };
  try {
    const { scopeTarget } = await import('@deepseek-ai/dsh-scope');
    const carrier = scopeTarget({ id: 'selfcheck' }, 'selfcheck-agent');
    // 方式 1:ctx.events.waterfall(共享 events 实例)
    const out1 = await ctx.events.waterfall(carrier, 'agent/request-error', payload, () => Promise.resolve(undefined));
    debugLog(`selfcheck[events.waterfall]: ${JSON.stringify(out1)}`);
    // 方式 2:ctx.waterfall(agent-loop 的真实调用路径)
    const out2 = await ctx.waterfall(carrier, 'agent/request-error', payload, () => Promise.resolve(undefined));
    debugLog(`selfcheck[ctx.waterfall]: ${JSON.stringify(out2)} (agent-loop 实际走这条)`);
    // 方式 3:两者是否同一函数
    debugLog(`selfcheck[identity]: ctx.waterfall===ctx.events.waterfall? ${ctx.waterfall === ctx.events.waterfall}`);
  } catch (e) {
    debugLog(`selfcheck: error=${e.message}`);
  }
}
