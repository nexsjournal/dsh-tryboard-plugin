/**
 * dsh-tryboard-plugin — server (host) half.
 *
 * Registers the `tryboard` settings section so the web 看板 page can persist
 * its board data (a single JSON document in the `data` field) through the
 * settings transport, and idempotently self-patches the host api-proxy
 * whitelist so the namespace is reachable from the Web client (takes effect
 * at the next host boot).
 *
 * All board state lives in the client bundle (lib/client.js); the server only
 * owns durable storage and wire exposure.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const name = "dsh-tryboard-plugin";
const inject = [];

// ---- Host-package resolution -------------------------------------------------
// DSH resolves bundle modules two-anchor (installation → profile), and the
// flat fallback $DSH_HOME/profiles/node_modules only helps modules whose REAL
// path lives inside a profile tree. A `link:` (symlinked) dev install keeps
// the real path in the user's checkout, where a plain `import` of the
// @deepseek-ai/* peers fails. So the peer packages are required lazily through
// an anchor that can reach the SAME installation the host runs from:
//   0) this module's own resolution (file:/npm/github installs land inside
//      the installation or profile tree and resolve normally);
//   1) the running installation, derived from the dsh entry (argv[1]);
//   2) the maintained flat fallback under $DSH_HOME/profiles.
// Each anchor is verified by actually resolving `@deepseek-ai/schemastery`
// before it is trusted, so a plugin loaded by installation A never picks up
// installation B's package copies (instance identity matters across the
// settings seam).

function hostRequire() {
  const anchors = [import.meta.url];
  try {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (entry) {
      let dir = dirname(entry);
      for (let i = 0; i < 8 && dir !== dirname(dir); i += 1) {
        if (existsSync(join(dir, "node_modules"))) {
          anchors.push(join(dir, "node_modules", ".dsh-tryboard-anchor.js"));
          break;
        }
        dir = dirname(dir);
      }
    }
  } catch {
    /* best effort */
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  anchors.push(join(dshHome, "profiles", ".dsh-tryboard-anchor.js"));
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      req.resolve("@deepseek-ai/schemastery");
      return req;
    } catch {
      /* try the next anchor */
    }
  }
  throw new Error(
    "dsh-tryboard-plugin: 无法解析宿主依赖 @deepseek-ai/*（找不到 @deepseek-ai/schemastery）。" +
      "请确认插件随 DSH 宿主进程加载，而不是独立运行。",
  );
}

let cachedDeps;
function loadDeps() {
  if (!cachedDeps) {
    const req = hostRequire();
    cachedDeps = {
      z: req("@deepseek-ai/schemastery"),
      settings: req("@deepseek-ai/dsh-settings"),
    };
  }
  return cachedDeps;
}

/**
 * The `tryboard` settings schema (also the wire schema for the web page).
 *
 * Board data is one JSON document in `data` (string): the client owns the
 * document shape and migrates it, so the host schema stays stable. The cap
 * matches what the settings transport comfortably carries (personal boards
 * are far below it).
 */
function configSchema(z) {
  return z.object({
    /** 全部看板数据（JSON 字符串：{v, boards, activeBoardId}）。 */
    data: z.string().max(2_000_000).default(""),
  });
}

// ---- apiproxy whitelist self-patch (so the namespace is exposed to the Web) --
// The Web settings transport answers `settings-not-exposed` for any namespace
// absent from dsh-host-apiproxy's WEB_SETTINGS_NAMESPACES — a host-side
// whitelist a third-party bundle cannot extend at runtime, so we patch the
// file idempotently; it takes effect at the next host boot.

const APIPROXY_PKG = "@deepseek-ai/dsh-host-apiproxy";
// The whitelist is a tab-indented const array; its declaration is unique in
// the file. Idempotency = the entry exists ANYWHERE in the list block, and the
// insertion point is right after the opening bracket. (The earlier
// before-last-entry anchor with an adjacency marker breaks whenever ANOTHER
// plugin inserts between our entry and the closer, which re-patches — and
// re-grows the list — on every boot.)
const APIPROXY_LIST_DECL = "const WEB_SETTINGS_NAMESPACES = [\n";
const APIPROXY_ENTRY = "\t\"tryboard\",\n";
const APIPROXY_ENTRY_RE = /"tryboard"/;

function apiproxyFileCandidates() {
  const out = [];
  // 1) The installation THIS host process runs from: walk up from the dsh
  //    entry (argv[1]) to the nearest node_modules carrying the package.
  try {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (entry) {
      let dir = dirname(entry);
      for (let i = 0; i < 8 && dir !== dirname(dir); i += 1) {
        const candidate = join(dir, "node_modules", APIPROXY_PKG, "lib", "index.js");
        if (existsSync(candidate)) {
          out.push(candidate);
          break;
        }
        dir = dirname(dir);
      }
      // macOS .app bundle host (DSH Desktop / DeepSeek Harness): the in-box
      // node_modules live under Contents/Resources, not on the argv path.
      const appMatch = entry.match(/^(.*\.app)\/Contents\//);
      if (appMatch) {
        for (const resources of [
          "Contents/Resources/app.asar.unpacked/node_modules",
          "Contents/Resources/host/node_modules",
        ]) {
          const candidate = join(appMatch[1], resources, APIPROXY_PKG, "lib", "index.js");
          if (existsSync(candidate)) out.push(candidate);
        }
      }
    }
  } catch {
    /* best effort */
  }
  // 2) Resolvable from this module (the pnpm graph / flat fallback the plugin
  //    lives in — may point at the desktop app's in-box copy).
  try {
    const req = createRequire(import.meta.url);
    out.push(req.resolve(`${APIPROXY_PKG}/lib/index.js`));
  } catch {
    /* not resolvable here — the fixed paths below still cover it */
  }
  // 3) Desktop app host (its own in-box copy).
  out.push(join("/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules", APIPROXY_PKG, "lib", "index.js"));
  // 3b) Current DSH Desktop bundle layout (renamed app, asar-unpacked node_modules).
  out.push(join("/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules", APIPROXY_PKG, "lib", "index.js"));
  out.push(join("/Applications/DSH Desktop.app/Contents/Resources/host/node_modules", APIPROXY_PKG, "lib", "index.js"));
  // 4) Every npx-cached dsh installation.
  try {
    for (const hash of readdirSync(join(homedir(), ".npm", "_npx"))) {
      out.push(join(homedir(), ".npm", "_npx", hash, "node_modules", APIPROXY_PKG, "lib", "index.js"));
    }
  } catch {
    /* no npx cache */
  }
  // 5) Profile pnpm stores (DSH_HOME/profiles/*/node_modules/.pnpm).
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    const profiles = join(dshHome, "profiles");
    for (const profile of readdirSync(profiles)) {
      const pnpm = join(profiles, profile, "node_modules", ".pnpm");
      try {
        for (const dir of readdirSync(pnpm)) {
          if (dir.startsWith("@deepseek-ai+dsh-host-apiproxy@")) {
            out.push(join(pnpm, dir, "node_modules", APIPROXY_PKG, "lib", "index.js"));
          }
        }
      } catch {
        /* profile without a pnpm store */
      }
    }
  } catch {
    /* no profiles */
  }
  return out;
}

/**
 * Idempotently add `tryboard` to WEB_SETTINGS_NAMESPACES in every known
 * api-proxy file. Returns a summary. Never throws.
 */
function ensureApiproxyExposure(log) {
  const summary = { targets: 0, patched: 0, alreadyPatched: 0, skipped: 0 };
  const seen = new Set();
  for (const path of apiproxyFileCandidates()) {
    let real;
    try {
      real = realpathSync(path);
    } catch {
      continue; // candidate does not exist
    }
    if (seen.has(real)) continue;
    seen.add(real);
    summary.targets += 1;
    let source;
    try {
      source = readFileSync(real, "utf8");
    } catch {
      summary.skipped += 1;
      continue;
    }
    const declAt = source.indexOf(APIPROXY_LIST_DECL);
    if (declAt === -1) {
      summary.skipped += 1;
      log("api-proxy 补丁跳过 " + real + "：未找到 WEB_SETTINGS_NAMESPACES 声明（结构已变化）");
      continue;
    }
    if (source.indexOf(APIPROXY_LIST_DECL, declAt + 1) !== -1) {
      summary.skipped += 1;
      log("api-proxy 补丁跳过 " + real + "：WEB_SETTINGS_NAMESPACES 声明出现多次");
      continue;
    }
    const closeAt = source.indexOf("\n];", declAt);
    if (closeAt === -1) {
      summary.skipped += 1;
      continue;
    }
    if (APIPROXY_ENTRY_RE.test(source.slice(declAt, closeAt))) {
      summary.alreadyPatched += 1;
      continue;
    }
    try {
      const insertAt = declAt + APIPROXY_LIST_DECL.length;
      source = source.slice(0, insertAt) + APIPROXY_ENTRY + source.slice(insertAt);
      const tmp = real + ".dsh-tryboard-patch";
      writeFileSync(tmp, source);
      renameSync(tmp, real);
      summary.patched += 1;
      log("看板设置命名空间已加入 api-proxy 白名单：" + real);
    } catch (e) {
      summary.skipped += 1;
      try {
        if (existsSync(real + ".dsh-tryboard-patch")) renameSync(real + ".dsh-tryboard-patch", real);
      } catch {
        /* best effort */
      }
      log("api-proxy 补丁跳过 " + real + "：" + String((e && e.message) || e));
    }
  }
  return summary;
}

function apply(ctx, entry) {
  const deps = loadDeps();
  const z = deps.z;
  const { installSettingsSection, settingsNamespace } = deps.settings;
  const NS = settingsNamespace("tryboard");
  const Config = configSchema(z);
  const rc = entry && typeof entry === "object" ? entry : {};

  const log = (msg) => {
    const logger = ctx.logger ? ctx.logger(name) : undefined;
    if (logger && typeof logger.info === "function") logger.info(msg);
  };
  const warn = (msg) => {
    const logger = ctx.logger ? ctx.logger(name) : undefined;
    if (logger && typeof logger.warn === "function") logger.warn(msg);
  };

  // Boot side effect — isolated so a patch failure never blocks the section.
  let apiproxyPatch;
  try {
    apiproxyPatch = ensureApiproxyExposure(log);
  } catch (e) {
    warn("api-proxy 补丁失败：" + String((e && e.message) || e));
    apiproxyPatch = { targets: 0, patched: 0, alreadyPatched: 0, skipped: 0, error: String((e && e.message) || e) };
  }
  if (apiproxyPatch.patched > 0) {
    warn("「看板」设置将在宿主下次启动后对网页端生效（api-proxy 白名单补丁已写入）。");
  }

  // Settings wiring: register the `tryboard` section; `current` always returns
  // the live resolved section (hot updates on save / external edit).
  let current = () => rc;
  installSettingsSection(ctx, NS, Config, rc, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {},
  });
}

export { name, inject, apply };
