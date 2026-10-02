/**
 * dsh-run-guard client half: contributes a "Run guard" section to the DSH
 * Settings shell (settings.section slot) that edits the plugin's settings
 * namespace through the plugin-owned /run-guard/api routes.
 *
 * Dark developer-tool styling consistent with the DSH shell: card groups,
 * switch toggles, visible focus rings, helper text, and save feedback
 * (loading -> success/error). Hand-written client-bundle format consumed by
 * window.__ModuleLoader__.load, same as dsh-better-sidebar.
 * @module dsh-run-guard/client
 */
window.__ModuleLoader__.load({
  id: "dsh-run-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    const h = React.createElement;

    const NS = "run-guard";
    /** Client services required before activation (provided by the client runtime). */
    const inject = ["slots"];

    /** Call the plugin's own settings API (bypasses the host apiproxy allow-list). */
    const call = async (method, payload) => {
      const resp = await fetch(`/run-guard/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });
      const parsed = await resp.json().catch(() => null);
      if (!resp.ok || parsed === null || parsed.ok !== true) {
        throw new Error(parsed?.error?.message ?? `HTTP ${resp.status}`);
      }
      return parsed.value;
    };

    /* ── Design tokens (dark developer-tool theme, consistent with the DSH shell) ── */
    const T = {
      // Follow the host design tokens so the section stays readable in both
      // light and dark DSH themes.
      textPrimary: "var(--dsw-alias-label-primary, #1f2937)",
      textSecondary: "var(--dsw-alias-label-secondary, #4b5563)",
      textTertiary: "var(--dsw-alias-label-tertiary, #6b7280)",
      surface: "var(--dsw-alias-bg-layer-2, #f8fafc)",
      border: "var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))",
      borderHover: "var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.2))",
      accent: "var(--dsw-alias-state-business-primary, #3b82f6)",
      accentHover: "var(--dsw-alias-state-business-primary-hover, #2563eb)",
      success: "var(--dsw-alias-state-success-primary, #16a34a)",
      danger: "var(--dsw-alias-state-error-primary, #dc2626)",
      inputBg: "var(--dsw-alias-bg-layer-3, #ffffff)",
      focusRing: "var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6))",
      radius: 8,
    };

    /** Field catalogue mirroring the host Config schema (label + helper text). */
    const FIELDS = [
      { group: "通用", path: ["enabled"], label: "启用插件", type: "boolean", desc: "总开关,关闭后两个能力都不生效" },
      { group: "Guard · 死循环拦截", path: ["guard", "enabled"], label: "死循环拦截", type: "boolean", desc: "检测推理流中的重复空转并中断" },
      { group: "Guard · 死循环拦截", path: ["guard", "windowChars"], label: "滑动窗口(字符)", type: "number", min: 64, desc: "重复率检测的窗口大小" },
      { group: "Guard · 死循环拦截", path: ["guard", "substrLen"], label: "重复检测子串长度", type: "number", min: 8, max: 128, desc: "窗口内切片比较的粒度" },
      { group: "Guard · 死循环拦截", path: ["guard", "repeatRatio"], label: "窗口重复率阈值", type: "number", step: 0.01, min: 0, max: 1, desc: "重复占比 ≥ 该值触发中断(0.7 = 70%)" },
      { group: "Guard · 死循环拦截", path: ["guard", "checkEvery"], label: "检测频率(每 N 块)", type: "number", min: 1, desc: "每 N 个推理块做一次检测,越大越省开销" },
      { group: "Guard · 死循环拦截", path: ["guard", "maxBlocks"], label: "硬闸:推理块数上限", type: "number", min: 100, desc: "单次调用推理块数超过即中断" },
      { group: "Guard · 死循环拦截", path: ["guard", "maxChars"], label: "硬闸:推理字符数上限", type: "number", min: 1000, desc: "单次调用推理字符数超过即中断" },
      { group: "Guard · 死循环拦截", path: ["guard", "maxGuardRetries"], label: "中断后自动重试上限", type: "number", min: 0, max: 10, desc: "每个 turn 最多自动重试次数,0 表示不重试" },
      { group: "Guard · 死循环拦截", path: ["guard", "autoRetryErrors"], label: "额外重试错误码", type: "csv", desc: "逗号分隔;这些错误码也自动重试(REASONING_GUARD 恒重试)" },
      { group: "Continue · 自动继续", path: ["continue", "enabled"], label: "自动继续", type: "boolean", desc: "turn 结束后按需自动续跑" },
      { group: "Continue · 自动继续", path: ["continue", "maxAutoFollowups"], label: "有 todo 续跑上限", type: "number", min: 1, max: 20, desc: "有未完成 todo 时,连续无产出续跑的上限" },
    ];

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const setPath = (obj, path, value) => {
      const copy = JSON.parse(JSON.stringify(obj ?? {}));
      let cur = copy;
      for (let i = 0; i < path.length - 1; i++) {
        if (typeof cur[path[i]] !== "object" || cur[path[i]] === null) cur[path[i]] = {};
        cur = cur[path[i]];
      }
      cur[path[path.length - 1]] = value;
      return copy;
    };

    /* ── Switch toggle (role=switch, visible focus ring, 150ms motion) ── */
    function Toggle({ checked, onChange, label }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        onClick: () => onChange(!checked),
        style: {
          width: 38,
          height: 22,
          borderRadius: 11,
          padding: 0,
          border: `1px solid ${checked ? "transparent" : T.borderHover}`,
          background: checked ? T.accent : T.inputBg,
          cursor: "pointer",
          position: "relative",
          flexShrink: 0,
          transition: "background 150ms ease, border-color 150ms ease",
          outline: "none",
        },
        onFocus: (e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${T.focusRing}`; },
        onBlur: (e) => { e.currentTarget.style.boxShadow = "none"; },
      }, h("span", {
        style: {
          display: "block",
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#fff",
          transform: checked ? "translateX(18px)" : "translateX(2px)",
          transition: "transform 150ms ease",
        },
      }));
    }

    /** Number / csv input control with dark styling and visible focus. */
    function FieldControl({ field, value, onChange }) {
      const base = {
        background: T.inputBg,
        border: `1px solid ${T.border}`,
        borderRadius: 6,
        color: T.textPrimary,
        padding: "5px 8px",
        fontSize: 13,
        fontFamily: "inherit",
        transition: "border-color 150ms ease, box-shadow 150ms ease",
        outline: "none",
      };
      const focusStyle = { borderColor: T.accent, boxShadow: `0 0 0 2px ${T.focusRing}` };
      if (field.type === "boolean") return null;
      const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
      if (field.type === "csv") {
        return h("input", {
          type: "text",
          style: { ...base, ...mono, width: 220 },
          value: Array.isArray(value) ? value.join(", ") : "",
          spellCheck: false,
          onChange: (e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean)),
          onFocus: (e) => Object.assign(e.currentTarget.style, focusStyle),
          onBlur: (e) => Object.assign(e.currentTarget.style, { borderColor: T.border, boxShadow: "none" }),
        });
      }
      return h("input", {
        type: "number",
        style: { ...base, ...mono, width: 130 },
        value: value ?? "",
        step: field.step,
        min: field.min,
        max: field.max,
        onChange: (e) => onChange(e.target.value === "" ? undefined : Number(e.target.value)),
        onFocus: (e) => Object.assign(e.currentTarget.style, focusStyle),
        onBlur: (e) => Object.assign(e.currentTarget.style, { borderColor: T.border, boxShadow: "none" }),
      });
    }

    /** Settings section rendered inside the DSH Settings shell. */
    function RunGuardSection() {
      const [view, setView] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState(null); // {kind:'saving'|'ok'|'error', text}
      const [loaded, setLoaded] = React.useState(false);

      React.useEffect(() => {
        let cancelled = false;
        call("settings.get", {}).then((v) => {
          if (cancelled || !v) return;
          setView(v);
          setDraft(JSON.parse(JSON.stringify(v.value ?? {})));
          setLoaded(true);
        }).catch(() => setLoaded(true));
        return () => { cancelled = true; };
      }, []);

      const refresh = async () => {
        const v = await call("settings.get", {});
        if (v) {
          setView(v);
          setDraft(JSON.parse(JSON.stringify(v.value ?? {})));
        }
      };

      const commit = async () => {
        if (!view || !draft) return;
        const ops = [];
        for (const f of FIELDS) {
          const next = getPath(draft, f.path);
          const prev = getPath(view.value, f.path);
          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            ops.push({ op: "set", path: f.path, value: next });
          }
        }
        if (ops.length === 0) {
          setStatus({ kind: "ok", text: "没有变更" });
          return;
        }
        setStatus({ kind: "saving", text: "保存中…" });
        try {
          await call("settings.update", { ops, expectedRevision: view.revision });
          await refresh();
          setStatus({ kind: "ok", text: "已保存,立即生效" });
        } catch (e) {
          setStatus({ kind: "error", text: "保存失败: " + (e?.message ?? String(e)) });
        }
      };

      const groups = [];
      for (const f of FIELDS) {
        const g = groups.find((x) => x.name === f.group);
        if (g) g.fields.push(f);
        else groups.push({ name: f.group, fields: [f] });
      }

      const card = (g) => h("section", {
        key: g.name,
        style: {
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius,
          marginBottom: 12,
          overflow: "hidden",
        },
      },
        h("header", {
          style: {
            padding: "10px 14px",
            borderBottom: `1px solid ${T.border}`,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: T.textSecondary,
          },
        }, g.name),
        h("div", { style: { padding: "4px 14px 10px" } },
          g.fields.map((f) => {
            const value = getPath(draft, f.path);
            return h("div", {
              key: f.path.join("."),
              style: {
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 0",
                borderBottom: "1px solid rgba(255,255,255,0.045)",
              },
            },
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: 13, color: T.textPrimary, lineHeight: 1.4 } }, f.label),
                f.desc ? h("div", { style: { fontSize: 11.5, color: T.textTertiary, marginTop: 1, lineHeight: 1.45 } }, f.desc) : null),
              f.type === "boolean"
                ? h(Toggle, { checked: !!value, onChange: (v) => setDraft(setPath(draft, f.path, v)), label: f.label })
                : h(FieldControl, { field: f, value, onChange: (v) => setDraft(setPath(draft, f.path, v)) }));
          })));

      const statusColor = status === null ? undefined
        : status.kind === "ok" ? T.success
          : status.kind === "error" ? T.danger
            : T.textSecondary;

      return h("div", { style: { padding: "2px 0 8px" } },
        loaded ? groups.map(card)
          : h("div", { style: { color: T.textTertiary, fontSize: 13, padding: "24px 0", textAlign: "center" } }, "加载中…"),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, paddingTop: 4 } },
          h("button", {
            type: "button",
            onClick: commit,
            disabled: !view || status?.kind === "saving",
            style: {
              padding: "7px 22px",
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 6,
              border: "none",
              background: T.accent,
              color: "#fff",
              cursor: status?.kind === "saving" ? "wait" : "pointer",
              opacity: !view ? 0.45 : 1,
              transition: "background 150ms ease, opacity 150ms ease",
              outline: "none",
            },
            onMouseEnter: (e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = T.accentHover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = T.accent; },
            onFocus: (e) => { e.currentTarget.style.boxShadow = `0 0 0 2px ${T.focusRing}`; },
            onBlur: (e) => { e.currentTarget.style.boxShadow = "none"; },
          }, status?.kind === "saving" ? "保存中…" : "保存"),
          status ? h("span", {
            role: "status",
            style: { color: statusColor, fontSize: 12, transition: "color 150ms ease" },
          }, status.text) : null));
    }

    /** Client plugin body. */
    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "run-guard",
        order: 100,
        label: () => "Run guard"
      }, RunGuardSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
