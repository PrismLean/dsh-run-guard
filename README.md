# 🛡️ dsh-run-guard

> DeepSeek Harness 插件 · **Agent 运行节奏守护** — 一体两面,让 LLM 在长任务中既不会「推理死循环停不下来」,也不会「想完就停不干活」。

[![GitHub stars](https://img.shields.io/github/stars/Dis2017/dsh-run-guard?style=flat-square)](https://github.com/Dis2017/dsh-run-guard)
[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-blue?style=flat-square)](https://github.com/topics/dsh-plugin)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

---

## ✨ 功能特性

| 能力 | 方向 | 说明 |
|------|------|------|
| **guard(刹车)** | 拦截推理死循环 | 监听 `llm/stream` 流,滑动窗口重复率检测 + 硬性上限双保险,死循环在 **1~2 秒内被中断**(而非空转数分钟);中断后**自动重试**(默认每 turn 2 次,可配),仍失败才停止并给出中文原因提示 |
| **recovery(恢复)** | 上游请求失败自动重试 | `PI_AI_ERROR` 等瞬时上游失败(不在 llm-retry 默认集合的)也自动重试(白名单可扩展),与 guard 共用每 turn 上限 |
| **continue(油门)** | 防止提前停摆 | turn 正常结束后自动续跑:有未完成 todo 时注入状态续跑;无 todo 但模型「想完就停」(最后只有推理、无正文无工具调用)时注入简洁提示续跑 |
| **pause_work 暂停** | 人工控制 | 模型可随时调用 `pause_work` 工具主动暂停,两路都不会再自动继续 |

**核心设计**:刹车与油门共用一套状态感知,互不干扰——guard 中断的 turn 以 error 结束,continue 天然不会误推;continue 推进的新 turn 若再次死循环,guard 立刻拦截。闭环自洽。

---

## 🎯 为什么需要它

DeepSeek V4 Flash 配合 `reasoningEffort: max` 在长任务中会出现两种典型异常:

1. **想完就停**:模型输出完整思考后直接正常结束 turn,没有正文、没有工具调用,留下未完成的任务——表现为「不干活」。
2. **推理死循环**:模型推理进入重复空转(实测单步可输出 10.9 万块、132 万字符垃圾推理),持续数分钟不停——表现为「停不下来」。

DeepSeek Harness 的 agent loop 本身对这两种异常都没有调控机制。本插件在两端补齐:**guard 保证它不会无限干活,continue 保证它不会不干活**。

---

## 🧠 工作原理

```
模型推理流 ──► llm/stream (waterfall) ──► [guard] 滑动窗口重复率 + 硬闸
                                            │ 触发:注入 REASONING_GUARD 错误中断
                                            ▼
                                   agent/request-error 恢复扩展点
                                            │ 错误码 ∈ {REASONING_GUARD} ∪ autoRetryErrors 且
                                            │ 该 turn 重试 < maxGuardRetries → 自动重跑 step
                                            └─ 超限或非可重试错误 → turn 以 error 结束(用户可见)
                                            ▲
                                            │ 天然抑制:continue 只在 completed 触发
                                            │
turn/end (completed) ──► [continue] 有 todo → 注入状态续跑(计数上限)
                              └─────── 无 todo + 想完就停 → 注入简洁提示续跑(无上限)
                              └─────── pause_work 已标记 → 不续跑
```

| 扩展点 | 用途 |
|--------|------|
| `llm/stream`(waterfall) | guard:包装每次模型调用,拦截 reasoning 死循环 |
| `session/event` | continue:跟踪 turn 生命周期、todo 状态、产出判定 |
| `systemPrompt.context` | continue:预防层——有未完成 todo 时注入状态与引导 |
| `tools.register` | continue:注册 `pause_work` 暂停工具 |

---

## 🚀 快速开始

### 安装(GitHub 发布版,推荐)

```bash
dsh plugin --profile web add "github:Dis2017/dsh-run-guard#v0.1.19"
```

`dsh plugin add` 检测到包内 `dsh.bundle` 声明后自动挂载:追加进 profile 的 bundles 列表,插件行由 bundle patch 提供。

### 验证

1. 重启 GUI
2. 打开 **设置 → 插件 → Plugin list**,确认 `dsh-run-guard` 为 **Mounted / Enabled**
3. 打开 **设置 → Run guard**,可编辑全部配置项(总开关 / Guard 死循环拦截 / Continue 自动继续),保存后落盘并实时更新运行中的插件
4. 正常使用:死循环会被 1~2 秒内中断并自动重试(页面可见);「想完就停」后会自动收到续跑提示

### 开发模式(绝对路径挂载,改代码即时生效)

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: run-guard
      name: /绝对/路径/dsh-run-guard/lib/index.js?v=1
```

---

## ⚙️ 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `enabled` | `true` | 总开关 |
| `guard.enabled` | `true` | 死循环拦截开关 |
| `guard.windowChars` | `2000` | 滑动窗口大小(字符) |
| `guard.substrLen` | `32` | 重复检测子串长度 |
| `guard.repeatRatio` | `0.7` | 窗口重复率阈值(≥ 触发) |
| `guard.checkEvery` | `50` | 每 N 块检测一次(降频) |
| `guard.maxBlocks` | `10000` | 硬闸:单次调用推理块数上限 |
| `guard.maxChars` | `500000` | 硬闸:单次调用推理字符数上限 |
| `guard.maxGuardRetries` | `2` | 中断后每 turn 自动重试次数上限(0 禁用) |
| `guard.autoRetryErrors` | `["PI_AI_ERROR"]` | 额外自动重试的错误码白名单(REASONING_GUARD 恒重试);瞬时上游错误可加入 |
| `continue.enabled` | `true` | 自动继续开关 |
| `continue.maxAutoFollowups` | `3` | 有 todo 场景连续无产出续跑上限 |

---

## 🧪 测试

```bash
pnpm install
pnpm test
```

76 个单元/集成测试,覆盖:

- **guard 检测器**:死循环触发、正常流不误报、硬闸、滑动窗口精确性、极端配置
- **中断恢复**:guard/上游错误自动重试、超限停止、turn 隔离、白名单外与持久错误不干预
- **流拦截**:透传、中断、顺序保持、退化降级
- **continue**:todo 续跑、想完就停续跑、暂停抑制、计数上限、UI 投影恢复
- **两 half 集成**:guard 中断不误推、continue 推进的新 turn 死循环被拦截

---

## 🔧 故障排查

### `Cannot read properties of undefined (reading 'prepare')`

**根因**:profile 顶层 node_modules 出现了第二份 `@deepseek-ai/dsh-tools` 副本(通常由插件把 `@deepseek-ai/*` 放进 `dependencies` 引起,pnpm hoisted 会提升)。DSH 的 `TOOL_RUNTIME_SCHEDULER` 是 Symbol,双实例下跨实例读取为 undefined。

**修复**:把 `@deepseek-ai/*` 移回 `peerDependencies`(宿主单例),清理 profile 顶层副本后重启。

```bash
cd ~/.dsh/profiles/web
pnpm remove <出问题的插件>
# 确认 node_modules/@deepseek-ai/ 已清空
ls node_modules/@deepseek-ai/
# 重启 dsh web
```

### 历史会话打开卡死

**根因**:死循环推理被全量落盘(单 step 可达 132 万字符),GUI 打开时前端处理巨型事件。

**修复**:本插件的 guard 保证**之后**不会再产生;存量会话需清理数据(结构保留、清空死循环文本)或归档。

---

## 🤝 开发

### 仓库结构

```
dsh-run-guard/
├── lib/
│   ├── index.js      # 合并入口:嵌套配置 + 按子开关挂载
│   ├── guard.js      # 刹车 half:检测器 + llm/stream 拦截 + 中断文案
│   └── continue.js   # 油门 half:自动继续 + pause_work
├── test/             # 76 个测试(guard / stream / continue / index / integration / settings)
├── cordis.patch.yml  # bundle patch(dsh plugin add 自动挂载)
└── scripts/
```

### 迭代流程

```bash
git commit -m "fix: ..."
git push origin main
git tag v0.1.19 && git push origin v0.1.19
dsh plugin --profile web add "github:Dis2017/dsh-run-guard#v0.1.19"   # 或 remove + add 升级
```

### 依赖约定(重要)

- DSH 运行时包(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`) → **peerDependencies**(宿主提供单例),绝不能放 `dependencies`
- 独立业务依赖(`@deepseek-ai/schemastery` 等) → `dependencies`
- 测试用的 DSH 依赖 → `devDependencies`(镜像 peer 版本,不随插件安装)

违反此约定会导致上述 `prepare` 错误。

---

## 📄 许可证

[MIT](LICENSE) © 2026 Dis2017
