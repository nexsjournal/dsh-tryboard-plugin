/**
 * dsh-tryboard-plugin — browser half (client bundle).
 *
 * A Trello-style kanban board inside the DSH web GUI, entirely in the
 * existing shell (no new window, no new app):
 *
 *   - 侧边栏入口: one row in `sidebar.footer.action` (above Settings) —
 *     a checklist icon + 看板 label (icon-only in the 56px rail).
 *   - 看板页: a frame-wide surface registered in `shell.overlay`; open it
 *     from the sidebar and it covers the whole app with its own header
 *     (back / board title / board switcher / stats / close) and a
 *     horizontally scrolling column area.
 *
 * Board model (persisted as one JSON document in the `tryboard` settings
 * namespace — the server half lib/index.js owns the namespace and the
 * api-proxy exposure):
 *
 *   { v: 1,
 *     boards: [{ id, name, createdAt, columns: [
 *        { id, title, status: "todo"|"doing"|"done"|"review"|"custom",
 *          builtin: bool, cards: [{ id, title, createdAt }] } ] }],
 *     activeBoardId }
 *
 * Every board starts with the four default status columns (待办 / 进行中 /
 * 完成 / 待确认); a card's status is its column, so dragging a card to
 * another column switches its status automatically. Extra columns can be
 * appended (status "custom"). All styling rides DSH design tokens
 * (`--dsw-*` / `--ds-*`), so the board follows the active light/dark theme.
 *
 * Module format: the web shell's module loader register shape
 * (window.__ModuleLoader__.load({ id, factory })). `require` inside the
 * factory resolves the shell's module table (react, client packages).
 */
window.__ModuleLoader__.load({
	id: "dsh-tryboard-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		let { jsx, jsxs } = require("react/jsx-runtime");
		const { useState, useEffect, useLayoutEffect, useRef, useCallback } = react;
		const useSyncExternalStore = react.useSyncExternalStore;
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const {
			Tooltip,
			IconChecklistOutline14,
			IconChevronLeftOutline14,
			IconChevronDownOutline14,
			IconCloseFill14,
			IconPlusOutline16,
			IconEllipsisOutline16,
			IconTrashOutline16,
			IconCheckOutline14
		} = primitives;

		/** Locale dictionary namespace owned by this plugin. */
		const LOCALE_NS = "dsh-tryboard-plugin";
		/** Host settings namespace holding the board document. */
		const SETTINGS_NS = "tryboard";
		const STYLE_ID = "dsh-tryboard-style";

		// ---- Locale dictionaries (zh is the key-set source of truth) ----------
		const zh = {
			nav: "看板",
			"hint.loading": "加载看板中…",
			"hint.unavailable": "设置服务不可用，修改暂不保存",
			"hint.rename": "点击重命名",
			"board.default": "每日工作",
			"board.new": "新建看板",
			"board.newName": "工作看板",
			"board.switch": "切换看板",
			"board.delete.title": "删除看板",
			"board.delete.msg": "将删除「{name}」及其全部卡片，此操作不可撤销。",
			"stat.cards": "共 {total} 张 · 已完成 {done}",
			"col.add": "添加列",
			"col.placeholder": "列名称",
			"col.rename": "重命名列",
			"col.delete": "删除列",
			"col.delete.title": "删除列",
			"col.delete.msg": "将删除「{title}」列及其中的 {count} 张卡片。",
			"card.add": "添加卡片",
			"card.placeholder": "卡片内容",
			"card.delete.title": "删除卡片",
			"card.delete.msg": "确定删除这张卡片吗？",
			"action.cancel": "取消",
			"action.delete": "删除",
			"action.back": "返回",
			"action.close": "关闭"
		};
		const en = {
			nav: "Board",
			"hint.loading": "Loading board…",
			"hint.unavailable": "Settings unavailable — changes won't persist",
			"hint.rename": "Click to rename",
			"board.default": "Daily Work",
			"board.new": "New board",
			"board.newName": "Work board",
			"board.switch": "Switch board",
			"board.delete.title": "Delete board",
			"board.delete.msg": "This deletes “{name}” and all of its cards. This cannot be undone.",
			"stat.cards": "{total} cards · {done} done",
			"col.add": "Add column",
			"col.placeholder": "Column name",
			"col.rename": "Rename column",
			"col.delete": "Delete column",
			"col.delete.title": "Delete column",
			"col.delete.msg": "This deletes the “{title}” column and its {count} card(s).",
			"card.add": "Add card",
			"card.placeholder": "Card content",
			"card.delete.title": "Delete card",
			"card.delete.msg": "Delete this card?",
			"action.cancel": "Cancel",
			"action.delete": "Delete",
			"action.back": "Back",
			"action.close": "Close"
		};

		// ---- Status vocabulary ---------------------------------------------------
		const STATUS_ORDER = ["todo", "doing", "done", "review"];
		const STATUS_META = {
			todo: { zh: "待办", en: "To Do" },
			doing: { zh: "进行中", en: "In Progress" },
			done: { zh: "完成", en: "Done" },
			review: { zh: "待确认", en: "Pending" }
		};
		const STATUS_COLORS = {
			todo: "#AFB9D0",
			doing: "#73C760",
			done: "#4498F1",
			review: "#FFBC3F",
			custom: "var(--dsw-alias-border-l3)"
		};

		// ---- Styles (DSH design tokens only — no fixed colors) ------------------
		const cssText = `
.dsh-tb-sb{width:calc(100% + 8px);height:34px;margin:4px -4px 2px;display:flex;align-items:center;gap:8px;padding:6px 2px 6px 10px;border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-family:inherit;cursor:pointer;overflow:hidden;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dsh-tb-sb:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-sb[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-sb-rail{width:36px;height:36px;margin:4px 0 2px;padding:0;justify-content:center;gap:0;border-radius:50%}
.dsh-tb-sb-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tb-page{position:absolute;top:0;right:0;bottom:0;left:0;z-index:20;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;animation:dsh-tb-in .18s var(--ds-ease-in-out)}
@keyframes dsh-tb-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.dsh-tb-page{animation:none}}
.dsh-tb-header{height:52px;flex:none;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-tb-icon-btn{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-tb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tb-icon-btn.sm{width:22px;height:22px;border-radius:6px}
.dsh-tb-title{flex:none;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600;line-height:22px;padding:2px 6px;border-radius:6px}
.dsh-tb-title:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-switcher{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;font-family:inherit;cursor:pointer}
.dsh-tb-switcher:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-tb-chevron{transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dsh-tb-chevron.rot{transform:rotate(180deg)}
.dsh-tb-stats{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dsh-tb-hint-chip{flex:none;margin-left:10px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.dsh-tb-board{flex:1;min-height:0;display:flex;align-items:flex-start;gap:12px;padding:16px;overflow-x:auto;overflow-y:hidden}
.dsh-tb-col{width:272px;flex:none;max-height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.dsh-tb-col-head{position:relative;flex:none;display:flex;align-items:center;gap:7px;padding:10px 8px 6px 12px}
.dsh-tb-dot{width:8px;height:8px;flex:none;border-radius:50%}
.dsh-tb-col-title{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 4px;margin-left:-4px;border-radius:5px;cursor:default}
.dsh-tb-col-title:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.dsh-tb-cards{flex:1;min-height:28px;display:flex;flex-direction:column;gap:8px;padding:4px 10px 6px;overflow-y:auto;overflow-x:hidden}
.dsh-tb-cards:empty{min-height:0;padding-top:0;padding-bottom:2px}
.dsh-tb-card{position:relative;display:flex;align-items:flex-start;gap:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:grab;transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dsh-tb-card:hover{border-color:var(--dsw-alias-border-l3)}
.dsh-tb-card:active{cursor:grabbing}
.dsh-tb-card.dragging{opacity:.45}
.dsh-tb-card-dot{width:6px;height:6px;flex:none;border-radius:50%;margin-top:6px}
.dsh-tb-card-title{flex:1;min-width:0;font-size:13px;line-height:20px;word-break:break-word}
.dsh-tb-card-del{width:24px;height:24px;flex:none;margin:-3px -3px 0 0;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transition:opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out),background var(--ds-transition-duration-fast) var(--ds-ease-in-out),color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.dsh-tb-card:hover .dsh-tb-card-del,.dsh-tb-card-del:focus-visible{opacity:1}
.dsh-tb-card-del:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tb-drop-line{height:2px;flex:none;margin:0 2px;border-radius:1px;background:var(--dsw-alias-brand-primary)}
.dsh-tb-add-card{flex:none;display:flex;align-items:center;gap:6px;margin:0 10px 10px;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;font-family:inherit;cursor:pointer;text-align:left}
.dsh-tb-add-card-edit{flex:none;padding:0 10px 10px}
.dsh-tb-add-card:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-tb-add-column{width:272px;flex:none;height:40px;display:flex;align-items:center;gap:6px;padding:0 12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;font-family:inherit;cursor:pointer}
.dsh-tb-add-column:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-tb-add-column-edit{padding:8px;gap:8px}
.dsh-tb-input{width:100%;height:30px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit;outline:none}
.dsh-tb-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-tb-input-sm{height:26px}
.dsh-tb-menu{position:absolute;z-index:50;min-width:168px;padding:4px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:2px}
.dsh-tb-menu-col{top:calc(100% + 2px);right:0}
.dsh-tb-menu-boards{top:calc(100% + 4px);left:0;min-width:200px}
.dsh-tb-menu-item{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-family:inherit;cursor:pointer;text-align:left}
.dsh-tb-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-menu-item.grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tb-menu-item.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-tb-menu-item.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-tb-menu-row{display:flex;align-items:center;gap:2px;border-radius:7px}
.dsh-tb-menu-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-menu-row .grow{pointer-events:auto}
.dsh-tb-menu-check{width:14px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}
.dsh-tb-menu-icon{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-tb-menu-icon:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dsh-tb-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.dsh-tb-mask{position:absolute;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}
.dsh-tb-dialog{width:340px;max-width:calc(100% - 48px);padding:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22)}
.dsh-tb-dialog-title{font-size:14px;font-weight:600;line-height:22px}
.dsh-tb-dialog-msg{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;word-break:break-word}
.dsh-tb-dialog-actions{margin-top:16px;display:flex;justify-content:flex-end;gap:8px}
.dsh-tb-btn{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-family:inherit;cursor:pointer}
.dsh-tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tb-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-tb-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dsh-tb-loading{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
`;
		function adoptStyles() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = cssText;
			document.head.appendChild(style);
		}

		// ---- Data model ----------------------------------------------------------
		function uid() {
			return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		}
		function statusTitle(status, lang) {
			const meta = STATUS_META[status];
			return meta ? (lang === "en" ? meta.en : meta.zh) : "";
		}
		function makeColumn(status, title, builtin) {
			return { id: uid(), title: title || statusTitle(status, "zh"), status: STATUS_META[status] ? status : "custom", builtin: !!builtin, cards: [] };
		}
		function makeBoard(name, lang) {
			return {
				id: uid(),
				name,
				createdAt: Date.now(),
				columns: STATUS_ORDER.map((s) => makeColumn(s, statusTitle(s, lang), true))
			};
		}
		function defaultData(lang) {
			const board = makeBoard(lang === "en" ? en["board.default"] : zh["board.default"], lang);
			return { v: 1, boards: [board], activeBoardId: board.id };
		}
		function isStr(value, maxLen) {
			return typeof value === "string" && value.length > 0 && value.length <= (maxLen || 200);
		}
		/** Defensive re-shaping of persisted JSON; returns null when unusable. */
		function parseData(raw, lang) {
			if (typeof raw !== "string" || raw.trim() === "") return null;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return null;
			}
			if (!parsed || !Array.isArray(parsed.boards)) return null;
			const boards = [];
			for (const b of parsed.boards) {
				if (!b || !Array.isArray(b.columns) || !isStr(b.name, 100)) continue;
				const columns = [];
				for (const c of b.columns) {
					if (!c || !isStr(c.title, 100)) continue;
					const status = STATUS_META[c.status] ? c.status : "custom";
					const cards = [];
					for (const card of Array.isArray(c.cards) ? c.cards : []) {
						if (card && isStr(card.title, 1000)) cards.push({ id: isStr(card.id, 64) ? card.id : uid(), title: card.title, createdAt: Number(card.createdAt) || Date.now() });
					}
					columns.push({ id: isStr(c.id, 64) ? c.id : uid(), title: c.title, status, builtin: c.builtin === true, cards });
				}
				if (columns.length === 0) columns.push(makeColumn("custom", lang === "en" ? "General" : "其他", false));
				boards.push({ id: isStr(b.id, 64) ? b.id : uid(), name: b.name, createdAt: Number(b.createdAt) || Date.now(), columns });
			}
			if (boards.length === 0) return null;
			const activeBoardId = boards.some((b) => b.id === parsed.activeBoardId) ? parsed.activeBoardId : boards[0].id;
			return { v: 1, boards, activeBoardId };
		}
		function activeBoard(data) {
			return data.boards.find((b) => b.id === data.activeBoardId) || data.boards[0];
		}
		function findCol(data, colId) {
			return activeBoard(data).columns.find((c) => c.id === colId);
		}
		/** Move a card to (toColId, toIndex). toIndex is a DOM index taken while the dragged card is hidden from the hit list, so it is an index in the array AFTER removal — no adjustment. */
		function moveCard(data, fromColId, cardId, toColId, toIndex) {
			const from = findCol(data, fromColId);
			const to = findCol(data, toColId);
			if (!from || !to) return;
			const i = from.cards.findIndex((c) => c.id === cardId);
			if (i === -1) return;
			const card = from.cards.splice(i, 1)[0];
			const at = Math.max(0, Math.min(toIndex, to.cards.length));
			to.cards.splice(at, 0, card);
		}

		// ---- Module-level store (shared by the sidebar entry and the page) -------
		function createStore(initial) {
			let state = initial;
			const listeners = new Set();
			return {
				get: () => state,
				set: (patch) => {
					state = { ...state, ...patch };
					for (const l of [...listeners]) {
						try { l(); } catch { /* listener hygiene */ }
					}
				},
				subscribe: (l) => {
					listeners.add(l);
					return () => listeners.delete(l);
				}
			};
		}
		const store = createStore({
			open: false,
			persistence: "loading", // "loading" | "ready" | "unavailable"
			data: null
		});
		function useTryboard() {
			return useSyncExternalStore(store.subscribe, store.get, store.get);
		}
		let persistHook = null; // wired by the settings effect in apply()
		/** Live language for default names; re-set in apply() from the locale face. */
		const langRef = { get: () => "zh" };
		/** Apply one transformation to a working copy of the board document. */
		function mutate(fn) {
			const s = store.get();
			const base = s.data || defaultData(langRef.get());
			const next = JSON.parse(JSON.stringify(base));
			fn(next);
			store.set({ data: next });
			if (persistHook) {
				try { persistHook(); } catch { /* best effort */ }
			}
		}

		// ---- Small shared components ----------------------------------------------
		/** Inline-edit text: click to edit, Enter/blur to commit, Esc to cancel. */
		function Editable({ value, placeholder, className, inputClass, inputStyle, onCommit, t, autoEditSignal }) {
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState("");
			const inputRef = useRef(null);
			const doneRef = useRef(false);
			const lastSignalRef = useRef(0);
			const begin = useCallback(() => {
				setDraft(String(value ?? ""));
				doneRef.current = false;
				setEditing(true);
			}, [value]);
			useEffect(() => {
				// Only a NEW signal re-enters edit mode (begin's identity changes
				// with value, so the raw effect would re-trigger after every commit).
				if (autoEditSignal && autoEditSignal !== lastSignalRef.current) {
					lastSignalRef.current = autoEditSignal;
					begin();
				}
			}, [autoEditSignal, begin]);
			useEffect(() => {
				if (editing && inputRef.current) {
					inputRef.current.focus();
					inputRef.current.select();
				}
			}, [editing]);
			const commit = useCallback(() => {
				const v = String(draft).trim();
				setEditing(false);
				if (v && v !== String(value ?? "")) onCommit(v);
			}, [draft, value, onCommit]);
			if (!editing) {
				return jsx("span", {
					className,
					title: t ? t("hint.rename") : undefined,
					onClick: (e) => {
						e.stopPropagation();
						begin();
					},
					children: String(value ?? "")
				});
			}
			return jsx("input", {
				ref: inputRef,
				type: "text",
				className: inputClass || "dsh-tb-input",
				style: inputStyle,
				value: draft,
				placeholder,
				onChange: (e) => setDraft(e.target.value),
				onClick: (e) => e.stopPropagation(),
				onKeyDown: (e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						doneRef.current = true;
						commit();
					} else if (e.key === "Escape") {
						doneRef.current = true;
						setEditing(false);
					}
				},
				onBlur: () => {
					if (doneRef.current) return;
					commit();
				}
			});
		}

		/** Close `open` on outside mousedown / Escape (capture, so it wins over the page Esc). */
		function useDismiss(open, onClose) {
			const closeRef = useRef(onClose);
			closeRef.current = onClose;
			useEffect(() => {
				if (!open) return;
				const onDown = (e) => {
					const el = e.target;
					if (el && el.closest && el.closest("[data-tb-menu]")) return;
					closeRef.current();
				};
				const onKey = (e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						closeRef.current();
					}
				};
				document.addEventListener("mousedown", onDown);
				window.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("mousedown", onDown);
					window.removeEventListener("keydown", onKey, true);
				};
			}, [open]);
		}

		/**
		 * Width (px) of the frame's sidebar column, so the board page can sit
		 * in the main content area instead of covering the whole window.
		 * The overlay layer lives in the frame grid; its parent's first child
		 * is the sidebar column. A ResizeObserver tracks expand/collapse/drag.
		 * Falls back to 0 (full-frame) if the layout cannot be found.
		 */
		function useMainAreaLeft() {
			const [left, setLeft] = useState(0);
			useLayoutEffect(() => {
				if (typeof document === "undefined" || typeof ResizeObserver === "undefined") return;
				const layer = document.querySelector("[data-shell-overlay]");
				const frame = layer && layer.parentElement;
				const sidebar = frame && frame.firstElementChild;
				if (!sidebar) return;
				const measure = () => {
					const w = sidebar.getBoundingClientRect().width;
					setLeft((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
				};
				measure();
				const ro = new ResizeObserver(measure);
				ro.observe(sidebar);
				return () => ro.disconnect();
			}, []);
			return left;
		}

		// ---- Card -------------------------------------------------------------------
		function Card({ card, dotColor, dragging, onDragStart, onDragEnd, onEdit, onDelete, t }) {
			return jsxs("article", {
				className: "dsh-tb-card" + (dragging ? " dragging" : ""),
				draggable: true,
				onDragStart,
				onDragEnd,
				children: [
					jsx("span", { className: "dsh-tb-card-dot", style: { background: dotColor } }),
					jsx(Editable, {
						value: card.title,
						className: "dsh-tb-card-title",
						inputClass: "dsh-tb-input dsh-tb-input-sm",
						placeholder: t("card.placeholder"),
						onCommit: onEdit,
						t
					}),
					jsx("button", {
						type: "button",
						className: "dsh-tb-card-del",
						"aria-label": t("card.delete.title"),
						onDragStart: (e) => e.preventDefault(),
						onClick: (e) => {
							e.stopPropagation();
							onDelete();
						},
						children: jsx(IconCloseFill14, { size: 14 })
					})
				]
			});
		}

		// ---- Column -------------------------------------------------------------------
		function Column({ col, dropIndex, draggingId, t, onDragStartCard, onDragEndCard, onDragOverCol, onDropCol, onDragLeaveCol, onRenameCol, onAskDeleteCol, onEditCard, onAskDeleteCard, onAddCard }) {
			const [menuOpen, setMenuOpen] = useState(false);
			const [renameSignal, setRenameSignal] = useState(0);
			const [adding, setAdding] = useState(false);
			const [draft, setDraft] = useState("");
			useDismiss(menuOpen, () => setMenuOpen(false));
			const dotColor = STATUS_COLORS[col.status] || STATUS_COLORS.custom;
			const commitAdd = useCallback(() => {
				const v = draft.trim();
				setAdding(false);
				setDraft("");
				if (v) onAddCard(v);
			}, [draft, onAddCard]);

			const kids = [];
			for (let i = 0; i <= col.cards.length; i += 1) {
				if (dropIndex === i) kids.push(jsx("div", { className: "dsh-tb-drop-line" }, "line-" + i));
				if (i < col.cards.length) {
					const c = col.cards[i];
					kids.push(jsx(Card, {
						card: c,
						dotColor,
						dragging: draggingId === c.id,
						t,
						onDragStart: (e) => onDragStartCard(e, col.id, c.id),
						onDragEnd: onDragEndCard,
						onEdit: (title) => onEditCard(c.id, title),
						onDelete: () => onAskDeleteCard(c)
					}, c.id));
				}
			}

			return jsxs("section", {
				className: "dsh-tb-col",
				onDragOver: (e) => onDragOverCol(e, col),
				onDrop: (e) => onDropCol(e, col),
				onDragLeave: (e) => onDragLeaveCol(e, col),
				children: [
					jsxs("header", {
						className: "dsh-tb-col-head",
						children: [
							jsx("span", { className: "dsh-tb-dot", style: { background: dotColor } }),
							jsx(Editable, {
								value: col.title,
								className: "dsh-tb-col-title",
								inputClass: "dsh-tb-input dsh-tb-input-sm",
								placeholder: t("col.placeholder"),
								onCommit: onRenameCol,
								t,
								autoEditSignal: renameSignal
							}),
							jsx("span", { className: "dsh-tb-count", children: String(col.cards.length) }),
							jsx("button", {
								type: "button",
								className: "dsh-tb-icon-btn sm",
								"aria-label": t("col.rename"),
								"data-tb-menu": true,
								onClick: (e) => {
									e.stopPropagation();
									setMenuOpen((v) => !v);
								},
								children: jsx(IconEllipsisOutline16, { size: 14 })
							}),
							menuOpen && jsxs("div", {
								className: "dsh-tb-menu dsh-tb-menu-col",
								"data-tb-menu": true,
								onClick: (e) => e.stopPropagation(),
								children: [
									jsx("button", {
										type: "button",
										className: "dsh-tb-menu-item",
										onClick: () => {
											setMenuOpen(false);
											setRenameSignal((n) => n + 1);
										},
										children: t("col.rename")
									}),
									jsx("button", {
										type: "button",
										className: "dsh-tb-menu-item danger",
										onClick: () => {
											setMenuOpen(false);
											onAskDeleteCol(col);
										},
										children: t("col.delete")
									})
								]
							})
						]
					}),
					jsx("div", { className: "dsh-tb-cards", children: kids }),
					adding
						? jsx("div", {
							className: "dsh-tb-add-card-edit",
							children: jsx("input", {
								autoFocus: true,
								className: "dsh-tb-input",
								value: draft,
								placeholder: t("card.placeholder"),
								onChange: (e) => setDraft(e.target.value),
								onKeyDown: (e) => {
									e.stopPropagation();
									if (e.key === "Enter") commitAdd();
									else if (e.key === "Escape") {
										setAdding(false);
										setDraft("");
									}
								},
								onBlur: commitAdd
							})
						})
						: jsxs("button", {
							type: "button",
							className: "dsh-tb-add-card",
							onClick: () => {
								setDraft("");
								setAdding(true);
							},
							children: [jsx(IconPlusOutline16, { size: 14 }), t("card.add")]
						})
				]
			});
		}

		// ---- Add column (ghost) ---------------------------------------------------------
		function AddColumn({ t, onAdd }) {
			const [adding, setAdding] = useState(false);
			const [draft, setDraft] = useState("");
			const commit = useCallback(() => {
				const v = draft.trim();
				setAdding(false);
				setDraft("");
				if (v) onAdd(v);
			}, [draft, onAdd]);
			if (!adding) {
				return jsxs("button", {
					type: "button",
					className: "dsh-tb-add-column",
					onClick: () => {
						setDraft("");
						setAdding(true);
					},
					children: [jsx(IconPlusOutline16, { size: 14 }), t("col.add")]
				});
			}
			return jsx("div", {
				className: "dsh-tb-add-column dsh-tb-add-column-edit",
				children: jsx("input", {
					autoFocus: true,
					className: "dsh-tb-input",
					value: draft,
					placeholder: t("col.placeholder"),
					onChange: (e) => setDraft(e.target.value),
					onKeyDown: (e) => {
						e.stopPropagation();
						if (e.key === "Enter") commit();
						else if (e.key === "Escape") {
							setAdding(false);
							setDraft("");
						}
					},
					onBlur: commit
				})
			});
		}

		// ---- Board switcher ---------------------------------------------------------------
		function BoardsMenu({ boards, activeId, t, onSwitch, onNew, onAskDelete }) {
			const [open, setOpen] = useState(false);
			useDismiss(open, () => setOpen(false));
			return jsxs("div", {
				style: { position: "relative" },
				children: [
					jsxs("button", {
						type: "button",
						className: "dsh-tb-switcher",
						"data-tb-menu": true,
						"aria-expanded": open,
						onClick: () => setOpen((v) => !v),
						children: [t("board.switch"), jsx(IconChevronDownOutline14, { size: 12, className: "dsh-tb-chevron" + (open ? " rot" : "") })]
					}),
					open && jsxs("div", {
						className: "dsh-tb-menu dsh-tb-menu-boards",
						"data-tb-menu": true,
						onClick: (e) => e.stopPropagation(),
						children: [
							boards.map((b) => jsxs("div", {
								className: "dsh-tb-menu-row",
								children: [
									jsx("span", { className: "dsh-tb-menu-check", children: b.id === activeId ? jsx(IconCheckOutline14, { size: 12 }) : null }),
									jsx("button", {
										type: "button",
										className: "dsh-tb-menu-item grow",
										onClick: () => {
											setOpen(false);
											if (b.id !== activeId) onSwitch(b.id);
										},
										children: b.name
									}),
									jsx("button", {
										type: "button",
										className: "dsh-tb-menu-icon",
										"aria-label": t("board.delete.title"),
										onClick: (e) => {
											e.stopPropagation();
											setOpen(false);
											onAskDelete(b);
										},
										children: jsx(IconTrashOutline16, { size: 13 })
									})
								]
							}, b.id)),
							jsx("div", { className: "dsh-tb-menu-sep" }),
							jsxs("button", {
								type: "button",
								className: "dsh-tb-menu-item",
								onClick: () => {
									setOpen(false);
									onNew();
								},
								children: [jsx(IconPlusOutline16, { size: 13 }), t("board.new")]
							})
						]
					})
				]
			});
		}

		// ---- Confirm dialog -----------------------------------------------------------------
		function ConfirmDialog({ req, t, onCancel }) {
			return jsxs("div", {
				className: "dsh-tb-mask",
				children: jsxs("div", {
					className: "dsh-tb-dialog",
					role: "alertdialog",
					"aria-modal": true,
					children: [
						jsx("div", { className: "dsh-tb-dialog-title", children: req.title }),
						jsx("div", { className: "dsh-tb-dialog-msg", children: req.message }),
						jsxs("div", {
							className: "dsh-tb-dialog-actions",
							children: [
								jsx("button", { type: "button", className: "dsh-tb-btn", onClick: onCancel, children: t("action.cancel") }),
								jsx("button", {
									type: "button",
									className: "dsh-tb-btn dsh-tb-btn-danger",
									onClick: () => {
										const run = req.onConfirm;
										onCancel();
										run();
									},
									children: t("action.delete")
								})
							]
						})
					]
				})
			});
		}

		// ---- The board page (shell.overlay entry) ------------------------------------------------
		function TryboardPage({ close, t }) {
			const s = useTryboard();
			const [dropAt, setDropAt] = useState(null);
			const [draggingId, setDraggingId] = useState(null);
			const [confirmReq, setConfirmReq] = useState(null);
			const dragMeta = useRef(null);
			const mainLeft = useMainAreaLeft();

			// Close on Escape (inputs and menus handle their own Esc first).
			// NOTE: every hook in this component (this effect + the five drag
			// handlers below) must run BEFORE the `if (!s.open) return null`
			// early exit — React requires a stable hook count on each render.
			useEffect(() => {
				if (!s.open) return;
				const onKey = (e) => {
					if (e.key !== "Escape") return;
					const target = e.target;
					if (target && target.closest && target.closest("input, textarea, [contenteditable]")) return;
					close();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [close, s.open]);

			const onDragStartCard = useCallback((e, colId, cardId) => {
				const target = e.target;
				if (target && target.closest && target.closest("input, textarea")) {
					e.preventDefault();
					return;
				}
				dragMeta.current = { fromCol: colId, cardId };
				e.dataTransfer.effectAllowed = "move";
				try {
					e.dataTransfer.setData("text/plain", cardId);
				} catch {
					/* some browsers throw on setData for exotic types — harmless */
				}
				// Defer the visual state so the drag image is the undimmed card.
				requestAnimationFrame(() => setDraggingId(cardId));
			}, []);
			const onDragEndCard = useCallback(() => {
				dragMeta.current = null;
				setDraggingId(null);
				setDropAt(null);
			}, []);
			const onDragOverCol = useCallback((e, col) => {
				if (!dragMeta.current) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				const nodes = e.currentTarget.querySelectorAll(".tb-card:not(.dragging)");
				let index = nodes.length;
				for (let i = 0; i < nodes.length; i += 1) {
					const r = nodes[i].getBoundingClientRect();
					if (e.clientY < r.top + r.height / 2) {
						index = i;
						break;
					}
				}
				setDropAt((prev) => (prev && prev.colId === col.id && prev.index === index ? prev : { colId: col.id, index }));
			}, []);
			const onDropCol = useCallback((e, col) => {
				e.preventDefault();
				const meta = dragMeta.current;
				if (!meta) return;
				const nodes = e.currentTarget.querySelectorAll(".tb-card:not(.dragging)");
				let index = nodes.length;
				for (let i = 0; i < nodes.length; i += 1) {
					const r = nodes[i].getBoundingClientRect();
					if (e.clientY < r.top + r.height / 2) {
						index = i;
						break;
					}
				}
				mutate((d) => moveCard(d, meta.fromCol, meta.cardId, col.id, index));
				dragMeta.current = null;
				setDraggingId(null);
				setDropAt(null);
			}, []);
			const onDragLeaveCol = useCallback((e, col) => {
				const to = e.relatedTarget;
				if (to && e.currentTarget.contains(to)) return;
				setDropAt((prev) => (prev && prev.colId === col.id ? null : prev));
			}, []);

			if (!s.open) return null;

			const data = s.data || defaultData(langRef.get());
			const board = activeBoard(data);
			const total = board.columns.reduce((n, c) => n + c.cards.length, 0);
			const done = board.columns.filter((c) => c.status === "done").reduce((n, c) => n + c.cards.length, 0);

			// Board-level operations.
			const renameBoard = (name) => mutate((d) => { activeBoard(d).name = name; });
			const switchBoard = (id) => mutate((d) => { d.activeBoardId = id; });
			const newBoard = () => mutate((d) => {
				const lang = langRef.get();
				const base = lang === "en" ? en["board.newName"] : zh["board.newName"];
				let name = base;
				let n = 2;
				while (d.boards.some((b) => b.name === name)) {
					name = `${base} ${n}`;
					n += 1;
				}
				const b = makeBoard(name, lang);
				d.boards.push(b);
				d.activeBoardId = b.id;
			});
			const askDeleteBoard = (b) => setConfirmReq({
				title: t("board.delete.title"),
				message: t("board.delete.msg", { name: b.name }),
				onConfirm: () => mutate((d) => {
					d.boards = d.boards.filter((x) => x.id !== b.id);
					if (d.boards.length === 0) {
						const lang = langRef.get();
						const fresh = makeBoard(lang === "en" ? en["board.default"] : zh["board.default"], lang);
						d.boards.push(fresh);
					}
					d.activeBoardId = d.boards.some((x) => x.id === d.activeBoardId) ? d.activeBoardId : d.boards[0].id;
				})
			});
			const addColumn = (title) => mutate((d) => { activeBoard(d).columns.push(makeColumn("custom", title, false)); });
			const renameColumn = (colId, title) => mutate((d) => { const c = findCol(d, colId); if (c) c.title = title; });
			const askDeleteColumn = (col) => setConfirmReq({
				title: t("col.delete.title"),
				message: t("col.delete.msg", { title: col.title, count: col.cards.length }),
				onConfirm: () => mutate((d) => { activeBoard(d).columns = activeBoard(d).columns.filter((c) => c.id !== col.id); })
			});
			const editCard = (cardId, title) => mutate((d) => {
				for (const c of activeBoard(d).columns) {
					const card = c.cards.find((x) => x.id === cardId);
					if (card) {
						card.title = title;
						return;
					}
				}
			});
			const askDeleteCard = (card) => setConfirmReq({
				title: t("card.delete.title"),
				message: t("card.delete.msg"),
				onConfirm: () => mutate((d) => {
					for (const c of activeBoard(d).columns) c.cards = c.cards.filter((x) => x.id !== card.id);
				})
			});
			const addCard = (colId, title) => mutate((d) => {
				const c = findCol(d, colId);
				if (c) c.cards.push({ id: uid(), title, createdAt: Date.now() });
			});

			return jsxs("div", {
				className: "dsh-tb-page",
				style: { left: mainLeft },
				children: [
					jsxs("header", {
						className: "dsh-tb-header",
						children: [
							jsx("button", {
								type: "button",
								className: "dsh-tb-icon-btn",
								"aria-label": t("action.back"),
								onClick: close,
								children: jsx(IconChevronLeftOutline14, {})
							}),
							jsx(Editable, {
								value: board.name,
								className: "dsh-tb-title",
								inputClass: "dsh-tb-input dsh-tb-input-sm",
								inputStyle: { width: 220 },
								placeholder: t("board.newName"),
								onCommit: renameBoard,
								t
							}),
							jsx(BoardsMenu, {
								boards: data.boards,
								activeId: board.id,
								t,
								onSwitch: switchBoard,
								onNew: newBoard,
								onAskDelete: askDeleteBoard
							}),
							s.persistence === "unavailable" && jsx("span", { className: "dsh-tb-hint-chip", title: t("hint.unavailable"), children: t("hint.unavailable") }),
							total > 0 && jsx("span", { className: "dsh-tb-stats", children: t("stat.cards", { total, done }) }),
							jsx("button", {
								type: "button",
								className: "dsh-tb-icon-btn",
								"aria-label": t("action.close"),
								onClick: close,
								children: jsx(IconCloseFill14, {})
							})
						]
					}),
					jsxs("div", {
						className: "dsh-tb-board",
						children: [
							board.columns.map((col) => jsx(Column, {
								col,
								t,
								dropIndex: dropAt && dropAt.colId === col.id ? dropAt.index : -1,
								draggingId,
								onDragStartCard,
								onDragEndCard,
								onDragOverCol,
								onDropCol,
								onDragLeaveCol,
								onRenameCol: (title) => renameColumn(col.id, title),
								onAskDeleteCol: askDeleteColumn,
								onEditCard: editCard,
								onAskDeleteCard: askDeleteCard,
								onAddCard: (title) => addCard(col.id, title)
							}, col.id)),
							jsx(AddColumn, { t, onAdd: addColumn })
						]
					}),
					confirmReq && jsx(ConfirmDialog, { req: confirmReq, t, onCancel: () => setConfirmReq(null) })
				]
			});
		}

		// ---- Sidebar entry (sidebar.footer.action entry) ---------------------------------------------
		function SidebarEntry({ wide, t, onOpen }) {
			const s = useTryboard();
			return jsx(Tooltip, {
				label: t("nav"),
				delayMs: 500,
				disabled: wide,
				children: jsxs("button", {
					type: "button",
					className: "dsh-tb-sb" + (wide ? "" : " dsh-tb-sb-rail"),
					"data-active": s.open || undefined,
					"aria-label": t("nav"),
					onClick: onOpen,
					children: [
						jsx(IconChecklistOutline14, { size: 16 }),
						wide ? jsx("span", { className: "dsh-tb-sb-label", children: t("nav") }) : null
					]
				})
			});
		}

		// ---- Module face -----------------------------------------------------------------------------
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "connection", "settingsScope"];

		function apply(ctx) {
			adoptStyles();
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-tryboard-plugin: dictionaries");
			const t = ctx.locale.bind(LOCALE_NS);

			// Live language for default names (re-read at each creation).
			langRef.get = () => {
				try {
					return ctx.locale.getLocale().active === "en" ? "en" : "zh";
				} catch {
					return "zh";
				}
			};

			// Settings persistence: adopt the host document, debounce writes back.
			const controller = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			ctx.effect(() => {
				let writeTimer = 0;
				const schedulePersist = () => {
					if (writeTimer) clearTimeout(writeTimer);
					writeTimer = setTimeout(() => {
						writeTimer = 0;
						const s = store.get();
						if (!s.data) return;
						try {
							controller.set("data", JSON.stringify(s.data));
						} catch (error) {
							if (typeof console !== "undefined") console.warn("[dsh-tryboard-plugin] persist failed:", error);
						}
					}, 400);
				};
				const adopt = () => {
					const snap = controller.getSnapshot();
					const s = store.get();
					if (snap.status === "unavailable") {
						if (s.persistence !== "unavailable") store.set({ persistence: "unavailable", data: s.data || defaultData(langRef.get()) });
						return;
					}
					if (snap.status !== "ready") return;
					const raw = snap.value && typeof snap.value.data === "string" ? snap.value.data : "";
					const cur = s.data ? JSON.stringify(s.data) : "";
					if (raw === cur && s.persistence === "ready") return;
					const parsed = parseData(raw, langRef.get());
					store.set({
						persistence: "ready",
						data: parsed || s.data || defaultData(langRef.get())
					});
				};
				adopt();
				const unsub = controller.subscribe(adopt);
				persistHook = schedulePersist;
				return () => {
					if (writeTimer) clearTimeout(writeTimer);
					unsub();
					persistHook = null;
				};
			}, "dsh-tryboard-plugin: settings");

			// Sidebar entry, above Settings.
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "tryboard",
						order: 0,
						locale: LOCALE_NS,
						label: () => t("nav"),
						inject: () => ({
							onOpen: () => store.set({ open: true })
						})
					},
					SidebarEntry
				)
			);

			// The board page as a frame-wide overlay surface.
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "tryboard-page",
						order: 0,
						locale: LOCALE_NS,
						label: () => t("nav"),
						inject: () => ({
							close: () => store.set({ open: false })
						})
					},
					TryboardPage
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
