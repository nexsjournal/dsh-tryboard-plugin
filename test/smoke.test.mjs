/**
 * Headless smoke test for dsh-tryboard-plugin (no DSH host needed).
 *
 *  - server half: runs apply() against a fake cordis ctx with the REAL
 *    schemastery + dsh-settings from the running DSH installation, and
 *    validates the `tryboard` settings schema;
 *  - client half: loads lib/client.js through a fake module loader with the
 *    REAL react/react-dom, renders the sidebar entry and the board page
 *    (closed + open, default board + adopted persisted board) and checks the
 *    visible structure.
 *
 * Usage: node test/smoke.test.mjs   (exit code 0 = pass)
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

let failures = 0;
function check(label, ok, extra) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---- Locate the running DSH installation's node_modules ---------------------
const candidates = [
  "/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules",
  "/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules",
];
const appNM = candidates.find((p) => existsSync(p));
if (!appNM) {
  console.log("skip: no DSH installation node_modules found (headless CI?)");
  process.exit(0);
}
const appRequire = createRequire(`${appNM}/.smoke-anchor.js`);

// ============================ server half =====================================
console.log("\n# server half (lib/index.js)");
{
  const plugin = await import("../lib/index.js");
  check("exports name/inject/apply", plugin.name === "dsh-tryboard-plugin" && Array.isArray(plugin.inject) && typeof plugin.apply === "function");

  const registrations = [];
  const fakeCtx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    inject: (names, cb) => {
      cb({
        settings: {
          register: (ns, schema, opts) => {
            registrations.push({ ns, schema, opts });
            return { get: () => ({}), watch: () => {} };
          }
        },
        effect: (fn) => {
          try {
            fn();
          } catch {
            /* cleanup-only effect */
          }
        }
      });
    }
  };
  plugin.apply(fakeCtx, {});
  check("registers exactly one settings section", registrations.length === 1, JSON.stringify(registrations.map((r) => r.ns)));
  const reg = registrations[0];
  const nsName = String(reg.ns);
  check("namespace is tryboard", nsName === "tryboard" || nsName.includes("tryboard"), nsName);

  // Validate the schema via the Standard Schema interface (~standard).
  try {
    const validate = reg.schema["~standard"].validate;
    const emptyRes = validate({});
    check("schema validates empty input", emptyRes && emptyRes.issues === void 0, JSON.stringify(emptyRes).slice(0, 120));
    const filledRes = validate({ data: '{"v":1}' });
    check("schema accepts data string", filledRes && filledRes.issues === void 0 && (filledRes.value?.data ?? '{"v":1}') === '{"v":1}', JSON.stringify(filledRes).slice(0, 120));
    const tooBigRes = validate({ data: "x".repeat(2_000_001) });
    check("schema rejects >2MB data", !!tooBigRes && Array.isArray(tooBigRes.issues) && tooBigRes.issues.length > 0, JSON.stringify(tooBigRes).slice(0, 120));
  } catch (error) {
    check("schema validation", false, String(error && error.message));
  }
}

// ============================ client half =====================================
console.log("\n# client half (lib/client.js)");
{
  let loaded = null;
  globalThis.window = {
    __ModuleLoader__: { load: (spec) => (loaded = spec) }
  };
  await import("../lib/client.js");
  check("registers a module loader entry", loaded !== null && loaded.id === "dsh-tryboard-plugin");
  check("factory is a function", loaded && typeof loaded.factory === "function");

  const react = appRequire("react");
  const jsxRuntime = appRequire("react/jsx-runtime");
  const { renderToString } = appRequire("react-dom/server");
  const icon = () => react.createElement("i", { className: "stub-icon" });
  const primitivesStub = {
    Tooltip: ({ children }) => children,
    IconChecklistOutline14: icon,
    IconChevronLeftOutline14: icon,
    IconChevronDownOutline14: icon,
    IconCloseFill14: icon,
    IconPlusOutline16: icon,
    IconEllipsisOutline16: icon,
    IconTrashOutline16: icon,
    IconCheckOutline14: icon
  };
  const fakeRequire = (id) => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return jsxRuntime;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
    throw new Error(`unexpected require in client bundle: ${id}`);
  };

  const mod = loaded.factory(fakeRequire);
  check("client exports apply + inject", typeof mod.apply === "function" && Array.isArray(mod.inject));
  check(
    "inject lists slots/locale/connection/settingsScope",
    ["slots", "locale", "connection", "settingsScope"].every((s) => mod.inject.includes(s)),
    JSON.stringify(mod.inject)
  );

  // ---- fake host context ----
  const registrations = [];
  const localeRegs = [];
  const settingsSubs = [];
  const settingsWrites = [];
  let snapshot = { status: "loading", value: void 0, revision: void 0, writable: true };
  let boundNs = null;
  const zhDict = {};
  const t = (key, params) => {
    let text = zhDict[key] ?? key;
    if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    return text;
  };
  const fakeCtx = {
    effect: (fn, label) => {
      const dispose = fn();
      if (typeof dispose === "function") fakeCtx._effects ??= [];
      return dispose;
    },
    locale: {
      register: (ns, dicts) => {
        localeRegs.push({ ns, dicts });
        Object.assign(zhDict, dicts.zh);
        return () => {};
      },
      bind: () => t,
      getLocale: () => ({ active: "zh" })
    },
    settingsScope: {
      bind: (spec) => {
        boundNs = spec.namespace;
        return {
          getSnapshot: () => snapshot,
          subscribe: (fn) => {
            settingsSubs.push(fn);
            return () => {};
          },
          set: (field, value) => {
            settingsWrites.push({ field, value });
            snapshot = { ...snapshot, value: { ...(snapshot.value ?? {}), [field]: value } };
          },
          load: () => {}
        };
      }
    },
    slots: {
      inject: (slotName, fn) => fn(),
      register: (opts, Comp) => {
        registrations.push({ slot: opts.name, opts, Comp });
        return () => {};
      }
    }
  };
  mod.apply(fakeCtx);

  check("locale registered once with zh+en", localeRegs.length === 1 && localeRegs[0].ns === "dsh-tryboard-plugin" && !!localeRegs[0].dicts.zh && !!localeRegs[0].dicts.en);
  check("binds tryboard settings namespace", boundNs === "tryboard", String(boundNs));
  check("subscribes to settings changes", settingsSubs.length >= 1);

  const sidebarReg = registrations.find((r) => r.slot === "sidebar.footer.action");
  const overlayReg = registrations.find((r) => r.slot === "shell.overlay");
  check("registers sidebar.footer.action entry", !!sidebarReg, JSON.stringify(registrations.map((r) => `${r.slot}#${r.opts.id}`)));
  check("sidebar entry id/locale", sidebarReg && sidebarReg.opts.id === "tryboard" && sidebarReg.opts.locale === "dsh-tryboard-plugin");
  check("registers shell.overlay entry", !!overlayReg && overlayReg.opts.id === "tryboard-page");

  // ---- render: sidebar entry (wide + rail) ----
  const { jsx } = jsxRuntime;
  const render = (Comp, props) => renderToString(jsx(Comp, props));
  const openFn = sidebarReg.opts.inject().onOpen;
  const closedWide = render(sidebarReg.Comp, { wide: true, t, onOpen: () => {} });
  const closedRail = render(sidebarReg.Comp, { wide: false, t, onOpen: () => {} });
  check("sidebar entry renders label when wide", closedWide.includes("dsh-tb-sb-label") && closedWide.includes("看板"), closedWide.slice(0, 120));
  check("sidebar entry renders icon-only in rail", closedRail.includes("stub-icon") && !closedRail.includes("dsh-tb-sb-label"), closedRail.slice(0, 120));

  // ---- render: page closed ----
  const pageClosed = render(overlayReg.Comp, { close: () => {}, t });
  check("page renders nothing while closed", pageClosed === "", pageClosed.slice(0, 120));

  // ---- open the board (via the sidebar inject), render page ----
  openFn();
  const pageOpen = render(overlayReg.Comp, { close: () => {}, t });
  check("page renders board shell when open", pageOpen.includes("dsh-tb-page"), pageOpen.slice(0, 120));
  for (const colTitle of ["待办", "进行中", "完成", "待确认"]) {
    check(`default column present: ${colTitle}`, pageOpen.includes(colTitle));
  }
  check("default board title present", pageOpen.includes("每日工作"));
  check("add-card affordance present", pageOpen.includes("添加卡片"));
  check("add-column affordance present", pageOpen.includes("添加列"));
  check("board switcher present", pageOpen.includes("切换看板"));

  // ---- adopt a persisted board document ----
  const persisted = {
    v: 1,
    activeBoardId: "board-b",
    boards: [
      {
        id: "board-b",
        name: "我的项目",
        createdAt: 1,
        columns: [
          { id: "c1", title: "待办", status: "todo", builtin: true, cards: [{ id: "k1", title: "写周报", createdAt: 1 }] },
          { id: "c2", title: "自定义区", status: "custom", builtin: false, cards: [] }
        ]
      }
    ]
  };
  snapshot = { status: "ready", value: { data: JSON.stringify(persisted) }, revision: 1, writable: true };
  for (const fn of settingsSubs) fn();
  const pageAdopted = render(overlayReg.Comp, { close: () => {}, t });
  check("adopts persisted board name", pageAdopted.includes("我的项目"), pageAdopted.slice(0, 160));
  check("adopts persisted custom column", pageAdopted.includes("自定义区"));
  check("adopts persisted card title", pageAdopted.includes("写周报"));
  check("stats line shows counts", pageAdopted.includes("共 1 张 · 已完成 0"));

  // ---- corrupt persisted data falls back to defaults ----
  snapshot = { status: "ready", value: { data: "not-json{{" }, revision: 2, writable: true };
  for (const fn of settingsSubs) fn();
  const pageCorrupt = render(overlayReg.Comp, { close: () => {}, t });
  check("corrupt data falls back to a usable board", pageCorrupt.includes("dsh-tb-page") && pageCorrupt.includes("待办"), pageCorrupt.slice(0, 120));

  // ---- unavailable settings still renders (memory-only mode) ----
  snapshot = { status: "unavailable", value: void 0, revision: void 0, writable: false };
  for (const fn of settingsSubs) fn();
  const pageUnavail = render(overlayReg.Comp, { close: () => {}, t });
  check("unavailable persistence shows hint chip", pageUnavail.includes("设置服务不可用"), pageUnavail.slice(0, 160));
}

// ================== static regression: conditional hooks =====================
console.log("\n# static: no hook after a top-level return (rules of hooks)");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const components = ["Editable", "Card", "Column", "AddColumn", "BoardsMenu", "ConfirmDialog", "TryboardPage", "SidebarEntry"];
  for (const name of components) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{`));
    if (!m) {
      check(`component ${name} present`, false, "not found");
      continue;
    }
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const lines = src.slice(start, end).split("\n");
    let fnDepth = 1;
    let returned = false;
    const bad = [];
    for (const line of lines) {
      const atTop = fnDepth === 1;
      if (atTop && !returned && /^\s*return\b/.test(line) && !/=>/.test(line)) returned = true;
      if (atTop && returned && /(^|[^.\w$])use[A-Z]\w*\s*\(/.test(line)) bad.push(line.trim());
      fnDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    }
    check(`${name}: no hook after early return`, bad.length === 0, bad.join(" | "));
  }
}

console.log(failures === 0 ? "\n# smoke: ALL PASS" : `\n# smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
