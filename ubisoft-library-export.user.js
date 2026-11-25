// ==UserScript==
// @name         育碧库存导出
// @name:en      Ubisoft Library Export
// @namespace    https://github.com/1959771708/ubisoft-library-export
// @version      1.0.4
// @description  导出 Ubisoft Connect 账号的完整游戏库存（权益口径），输出 JSON 供第三方工具导入
// @description:en  Export your complete Ubisoft Connect library, based on owned game entitlements.
// @author       1959771708
// @license      CC-BY-4.0
// @homepageURL  https://github.com/1959771708/ubisoft-library-export
// @supportURL   https://github.com/1959771708/ubisoft-library-export/issues
// @updateURL    https://raw.githubusercontent.com/1959771708/ubisoft-library-export/main/ubisoft-library-export.user.js
// @downloadURL  https://raw.githubusercontent.com/1959771708/ubisoft-library-export/main/ubisoft-library-export.user.js
// @match        https://connect.ubisoft.com/*
// @match        https://*.ubisoft.com/*
// @match        https://ubisoft.com/*
// @match        https://*.ubisoft.com.cn/*
// @match        https://ubisoft.com.cn/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ── 配置 ────────────────────────────────────────────────────────────────
    // Ubisoft Connect 桌面客户端的公开 App ID（GOG Galaxy 插件、ubi-docs 等公开项目用的同一组，
    // 不是私人密钥）。注意：登录页用的 appId 是另一个（1068ef52-…），而 API 侧会拒绝登录 appId，
    // 所以本脚本读网页 localStorage 里的 ticket 后，必要时先换一次票再读库。
    const APP_ID = 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6';

    // 登录页必须带 appId，否则 SPA 会把自己导航到 /error（实测 /v2/webauth/public/config
    // 不带 appId 返回 invalid:true，带 genomeId 也返回 invalid:true）。
    // 根路径 https://connect.ubisoft.com/ 会 301 到官网营销页，也不是登录页。
    //
    // 关于代理/海外：登录成功默认跳 https://ubisoft.com，那个域名按 IP 落到区域站
    // （美国代理时是 www.ubisoft.com/en-us 之类）。实测过的三条路都不通：
    //   ① 显式 nexturl 钉回 connect 域 —— 只保得住**一次**跳转。我们设的 nexturl 自身
    //      不带 nexturl 参数，落地后 query 只剩 appId，页面上再点一次登录就回落
    //      _defaultNextUrl="https://ubisoft.com"，照样被甩到区域站。
    //   ② /auth.html 当落点 —— 那是给客户端/iframe 用的 SDK 页，无 operation 参数时
    //      执行 `window.top.location.href = nextUrl`，默认还是 ubisoft.com。
    //   ③ 把 connect 域的 SSO 拿票接口跨域打 —— 只对 connect.ubisoft.com 回 ACAO。
    // 正解是**不跟它抢落点**：脚本同时覆盖区域站。区域站页面里嵌了 connect 的
    // WebAuth SDK iframe，会把票写进宿主页自己的 localStorage —— 所以代理场景下
    // 直接在区域站上导出即可，localStorage 里的票虽然属于另一个 appId（直接调库存
    // 接口会 401），但换票一次就能拿到本脚本 APP_ID 的票（实测 200）。
    const LOGIN_APP_ID = '1068ef52-dfd2-4e62-8ac9-37a47e6c0b78';
    const LOGIN_PATH = '/login?appId=' + LOGIN_APP_ID;
    const LOGIN_ORIGIN = 'https://connect.ubisoft.com';
    const LOGIN_URL = LOGIN_ORIGIN + LOGIN_PATH;

    const ENT_URL = 'https://api-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements';
    const SESSION_URL = 'https://public-ubiservices.ubi.com/v2/profiles/sessions';
    const GRAPHQL_URL = 'https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql';

    // 网页登录把整份会话写进 localStorage，但**两个域的形状不一样**（都实测过）：
    //   connect.ubisoft.com  → PRODloginData = {ticket, sessionId, userId, nameOnPlatform, email, expirationDate(ms)}
    //   区域站 www.ubisoft.com → PRODOverlayConnectLoginData = {opId, ticket, user_id, sessionId, expiration(ISO 串)}
    //                          另有 PRODloginData = {opId:"GetTicket", status:"ok", payload:{ticket, userId, sessionId, expiration}}
    // 区域站这两份里的票属于 SDK 的 appId，直接调库存接口会 401，靠 withAuthRetry 换票即可。
    const SESSION_KEYS = [
        'PRODloginData',
        'loginData',
        'PRODOverlayConnectLoginData'
    ];

    // 实测：api-ubiservices / public-ubiservices 对 https://connect.ubisoft.com 的预检都回
    // Access-Control-Allow-Origin: https://connect.ubisoft.com，且允许
    // authorization, ubi-appid, ubi-sessionid, content-type, ubi-localeCode
    // —— 所以这里用页面内 fetch 就够了，不需要 GM 请求（Epic 那边是必须 GM 的）。
    const TITLE_CHUNK = 120;
    const SCHEMA_VERSION = 1;

    // 导出的 JSON 一律英文：键名本来就固定英文，标题由接口按 en-US 返回，
    // 唯一曾混进中文的是把界面里的错误文案直接塞进了 summary.titleError，
    // 所以那里改成英文错误码（详细中文原因只进界面日志）。
    const JSON_LANG = 'en-US';

    const state = { running: false, result: null, startedAt: 0, ticker: null, requests: 0 };

    // ── 网络层 ──────────────────────────────────────────────────────────────
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function httpJson(url, opts, what) {
        const started = Date.now();
        state.requests += 1;
        let res;
        try {
            res = await fetch(url, opts);
        } catch (err) {
            const msg = (err && err.message) ? err.message : String(err);
            throw new Error(what + ' 请求失败（网络层）：' + msg);
        }
        const text = await res.text();
        let json = null;
        if (text) {
            try { json = JSON.parse(text); } catch (e) {
                // 某些错误页会是 HTML，保留前 200 字符供排查
                const err = new Error(what + ' 返回了非 JSON 内容（HTTP ' + res.status + '）：' + text.slice(0, 200));
                err.status = res.status;
                throw err;
            }
        }
        if (!res.ok) {
            const err = new Error(what + ' 失败：HTTP ' + res.status + ' ' + text.slice(0, 200));
            err.status = res.status;
            err.body = json;
            throw err;
        }
        return { json: json, ms: Date.now() - started, status: res.status };
    }

    // ── 会话 ────────────────────────────────────────────────────────────────
    // 把过期时间统一成毫秒数：connect 域给的是数字毫秒，区域站给的是 ISO 字符串。
    function toMillis(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        const ms = Number(raw);
        if (isFinite(ms) && ms > 0) return ms;
        const parsed = Date.parse(String(raw));
        return isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function readStoredSession() {
        const empty = {
            key: null, ticket: null, sessionId: null, userId: null,
            nameOnPlatform: null, email: null, expirationDate: null
        };
        const candidates = [];
        for (let i = 0; i < SESSION_KEYS.length; i += 1) {
            const key = SESSION_KEYS[i];
            let raw = null;
            try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
            if (!raw) continue;
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
            if (!parsed || typeof parsed !== 'object') continue;
            // 区域站的 PRODloginData 把真正的内容套在 payload 里
            const src = (parsed.payload && typeof parsed.payload === 'object') ? parsed.payload : parsed;
            const ticket = src.ticket || null;
            const sessionId = src.sessionId || null;
            if (!ticket || !sessionId) continue;
            candidates.push({
                key: key,
                ticket: ticket,
                sessionId: sessionId,
                userId: src.userId || src.user_id || src.profileId || null,
                nameOnPlatform: src.nameOnPlatform || src.username || null,
                email: src.email || src.emailAddress || null,
                expirationDate: toMillis(src.expirationDate) || toMillis(src.expiration)
            });
        }
        if (!candidates.length) return empty;
        // 区域站同时存在两份：PRODloginData.payload 里的那张经常会比 overlay 的旧，
        // 所以优先没用过期的那张；全都过期就返回第一张，让上层报「会话已过期」。
        for (let i = 0; i < candidates.length; i += 1) {
            if (!isSessionExpired(candidates[i])) return candidates[i];
        }
        return candidates[0];
    }

    // 会话是否已过期。expirationDate 可能是毫秒数、ISO 字符串，也可能缺失；
    // 缺失或非法时不做断言（交给服务端 401）。
    function isSessionExpired(session) {
        const ms = toMillis(session && session.expirationDate);
        if (ms === null) return false;
        return ms <= Date.now();
    }

    function authHeaders(session) {
        return {
            'Authorization': 'Ubi_v1 t=' + session.ticket,
            'Ubi-SessionId': session.sessionId,
            'Ubi-AppId': APP_ID,
            'Ubi-LocaleCode': JSON_LANG,
            'Content-Type': 'application/json'
        };
    }

    // 网页拿到的 ticket 属于登录 appId（区域站还是 SDK 的 appId），API 侧不认；
    // 换票一次就拿到本脚本 APP_ID 的票。实测：区域站的票直接调库存接口 401，
    // 换票后 200。
    async function refreshSession(session) {
        const r = await httpJson(SESSION_URL, {
            method: 'POST',
            headers: authHeaders(session),
            body: '{}'
        }, '换票（profiles/sessions）');
        const j = r.json || {};
        if (j.ticket) session.ticket = j.ticket;
        if (j.sessionId) session.sessionId = j.sessionId;
        if (j.userId) session.userId = j.userId;
        if (j.nameOnPlatform) session.nameOnPlatform = j.nameOnPlatform;
        const exp = toMillis(j.expirationDate) || toMillis(j.expiration);
        if (exp) session.expirationDate = exp;
        if (!j.ticket) throw new Error('换票没有返回 ticket，无法继续');
        return r;
    }

    // 任何一次调用遇到 401/403 就换票重试一次；再失败就明确报「登录过期」。
    async function withAuthRetry(session, fn) {
        try {
            return await fn();
        } catch (err) {
            if (err && (err.status === 401 || err.status === 403)) {
                await refreshSession(session);
                return await fn();
            }
            throw err;
        }
    }

    // ── 数据整形 ────────────────────────────────────────────────────────────
    // 权益接口的载荷有三种可能形态：裸数组 / {entitlements:[…]} / {entitlements:{nodes:[…]}}
    function pickEntitlements(payload) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== 'object') return [];
        const e = payload.entitlements;
        if (Array.isArray(e)) return e;
        if (e && Array.isArray(e.nodes)) return e.nodes;
        if (Array.isArray(payload.nodes)) return payload.nodes;
        return [];
    }

    function lower(v) {
        return String(v === undefined || v === null ? '' : v).toLowerCase();
    }

    // 只保留「已拥有 / 是游戏 / 没过期」的权益，并记下每类被排除掉多少条。
    function classifyEntitlements(list) {
        const stats = { total: list.length, kept: 0, notOwned: 0, notGame: 0, expired: 0, malformed: 0 };
        const kept = [];
        for (let i = 0; i < list.length; i += 1) {
            const item = list[i];
            if (!item || typeof item !== 'object') { stats.malformed += 1; continue; }
            const accessLevel = lower(item.accessLevel);
            const type = lower(item.type);
            const availability = lower(item.availability);
            if (accessLevel && accessLevel !== 'owned') { stats.notOwned += 1; continue; }
            if (type && type !== 'game') { stats.notGame += 1; continue; }
            if (availability === 'expired') { stats.expired += 1; continue; }
            stats.kept += 1;
            kept.push(item);
        }
        return { stats: stats, kept: kept };
    }

    // 同一个 spaceId 可能有多条权益（不同 productId / 平台），按 spaceId 收敛成一条。
    function collapseBySpaceId(items) {
        const bySpace = new Map();
        let duplicates = 0;
        for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            const spaceId = String(item.spaceId || '').trim();
            if (!spaceId) continue;
            if (bySpace.has(spaceId)) {
                duplicates += 1;
                const prev = bySpace.get(spaceId);
                if (!prev.productId && item.productId) prev.productId = item.productId;
                if (!prev.availability && item.availability) prev.availability = item.availability;
                continue;
            }
            bySpace.set(spaceId, {
                spaceId: spaceId,
                productId: item.productId || null,
                accessLevel: item.accessLevel || null,
                availability: item.availability || null
            });
        }
        return { items: Array.from(bySpace.values()), duplicates: duplicates };
    }

    // GraphQL 的 Platform 片段可能有四处来源，取并集去重。
    function collectPlatforms(node) {
        const out = [];
        function push(p) {
            if (!p) return;
            if (typeof p === 'string') { push({ name: p }); return; }
            const name = p.name || p.platformName || p.type || p.id;
            if (name && out.indexOf(String(name)) === -1) out.push(String(name));
        }
        push(node.platform);
        const groups = node.availablePlatformGroups;
        if (Array.isArray(groups)) groups.forEach(push);
        const avail = node.availablePlatforms;
        if (avail && Array.isArray(avail.nodes)) avail.nodes.forEach(push);
        const meta = node.viewer && node.viewer.meta;
        if (meta && meta.ownedCrossplayPlatforms && Array.isArray(meta.ownedCrossplayPlatforms.nodes)) {
            meta.ownedCrossplayPlatforms.nodes.forEach(push);
        }
        return out;
    }

    // ── 育碧接口 ────────────────────────────────────────────────────────────
    async function fetchEntitlements(session, onNote) {
        const r = await withAuthRetry(session, function () {
            return httpJson(ENT_URL, {
                method: 'GET',
                headers: authHeaders(session)
            }, '读取权益（entitlements）');
        });
        const list = pickEntitlements(r.json);
        const c = classifyEntitlements(list);
        const collapsed = collapseBySpaceId(c.kept);
        if (onNote) {
            onNote('权益 ' + c.stats.total + ' 条：owned game ' + c.stats.kept
                + '，排除非游戏 ' + c.stats.notGame + ' / 未拥有 ' + c.stats.notOwned
                + ' / 已过期 ' + c.stats.expired + '，合并重复 ' + collapsed.duplicates);
        }
        return {
            stats: c.stats,
            duplicates: collapsed.duplicates,
            games: collapsed.items,
            ms: r.ms
        };
    }

    async function fetchTitles(session, spaceIds, onProgress) {
        const titles = new Map();
        const chunks = [];
        for (let i = 0; i < spaceIds.length; i += TITLE_CHUNK) {
            chunks.push(spaceIds.slice(i, i + TITLE_CHUNK));
        }

        for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            const payload = {
                operationName: 'GetOwnedGames',
                variables: { spaceIds: chunk },
                query: 'query GetOwnedGames($spaceIds: [String!]) {'
                    + ' games(spaceIds: $spaceIds) {'
                    + '  id spaceId name'
                    + '  platform { id name type applicationId }'
                    + '  availablePlatformGroups { id name type }'
                    + '  availablePlatforms { nodes { id name type } }'
                    + ' }'
                    + '}'
            };
            const r = await withAuthRetry(session, function () {
                return httpJson(GRAPHQL_URL, {
                    method: 'POST',
                    headers: authHeaders(session),
                    body: JSON.stringify(payload)
                }, '读取标题（graphql）');
            });
            const data = (r.json && r.json.data) || {};
            const nodes = Array.isArray(data.games) ? data.games : [];
            for (let k = 0; k < nodes.length; k += 1) {
                const node = nodes[k];
                const spaceId = String(node.spaceId || '').trim();
                if (!spaceId) continue;
                titles.set(spaceId, {
                    name: node.name || null,
                    platforms: collectPlatforms(node)
                });
            }
            if (onProgress) onProgress(i + 1, chunks.length, titles.size);
        }
        return titles;
    }

    // JSON 里要放英文，所以把错误翻译成稳定英文码；完整中文原因只进界面日志。
    function titleErrorCodeOf(err) {
        if (!err) return 'UNKNOWN';
        if (err.status) return 'HTTP_' + err.status;
        if (err.name === 'TypeError') return 'NETWORK_ERROR';
        return 'UNKNOWN';
    }

    async function runExport(session) {
        state.startedAt = Date.now();
        state.requests = 0;
        const stages = [];
        const notes = [];

        const s = session || readStoredSession();
        if (!s.ticket || !s.sessionId) {
            throw new Error('没有找到登录会话。请先在本页登录（' + LOGIN_URL + '），登录后再点导出。'
                + '（读取的 localStorage 键：' + SESSION_KEYS.join(' / ') + '）');
        }
        // 残留的旧票也能"看起来有会话"，必须先失效判定，否则会拿过期票去导出。
        const expired = isSessionExpired(s);
        if (expired) {
            throw new Error('登录会话已过期（expirationDate ' + new Date(s.expirationDate).toISOString()
                + '）。请在本页重新登录（' + LOGIN_URL + '），登录完成后再点导出。');
        }

        ui.progress(5, '读取权益');
        const host = (typeof location !== 'undefined' && location && location.host) ? location.host : '(未知域)';
        ui.log('会话来源：localStorage["' + s.key + '"]（' + host + '），用户 '
            + (s.nameOnPlatform || s.userId || '未知'));

        const t0 = Date.now();
        const ent = await fetchEntitlements(s, function (line) { ui.log('  ' + line); notes.push(line); });
        stages.push({ name: '权益', ms: Date.now() - t0 });
        ui.progress(45, '权益 ' + ent.games.length + ' 款');

        const spaceIds = ent.games.map(function (g) { return g.spaceId; });
        let titles = new Map();
        let titleError = null;
        let titleErrorCode = null;
        if (spaceIds.length) {
            ui.progress(55, '读取标题');
            const t1 = Date.now();
            try {
                titles = await fetchTitles(s, spaceIds, function (done, total) {
                    ui.progress(55 + Math.round(40 * done / total), '标题 ' + done + '/' + total);
                });
            } catch (err) {
                // 标题拿不到不该让整次导出失败：spaceId 本身仍是稳定主键
                titleError = (err && err.message) ? err.message : String(err);
                // JSON 里只放英文错误码，中文原因留在界面日志里
                titleErrorCode = titleErrorCodeOf(err);
                ui.log('  ! 标题读取失败，将只输出 spaceId：' + titleError);
            }
            stages.push({ name: '标题', ms: Date.now() - t1 });
        }

        const games = ent.games.map(function (g) {
            const title = titles.get(g.spaceId) || null;
            return {
                name: title && title.name ? title.name : null,
                spaceId: g.spaceId,
                productId: g.productId || null,
                platforms: title && Array.isArray(title.platforms) ? title.platforms : [],
                accessLevel: g.accessLevel || null,
                availability: g.availability || null,
                resolved: !!(title && title.name)
            };
        });

        games.sort(function (a, b) {
            return String(a.name || a.spaceId).localeCompare(String(b.name || b.spaceId), 'en-US');
        });

        const unresolved = games.filter(function (g) { return !g.resolved; }).length;
        state.result = {
            schemaVersion: SCHEMA_VERSION,
            source: 'ubisoft-ubiconnect-entitlements',
            generatedAt: new Date().toISOString(),
            account: {
                userId: s.userId || null,
                nameOnPlatform: s.nameOnPlatform || null,
                email: s.email || null
            },
            summary: {
                gameCount: games.length,
                entitlementCount: ent.stats.total,
                ownedGameEntitlementCount: ent.stats.kept,
                duplicateSpaceIds: ent.duplicates,
                excludedNotGame: ent.stats.notGame,
                excludedNotOwned: ent.stats.notOwned,
                excludedExpired: ent.stats.expired,
                unresolvedCount: unresolved,
                titleError: titleErrorCode
            },
            games: games
        };

        const totalSec = ((Date.now() - state.startedAt) / 1000).toFixed(1);
        ui.progress(100, '完成');
        ui.elapsed(Number(totalSec));
        ui.log('✓ 导出完成：' + games.length + ' 款游戏，共 ' + totalSec + 's，请求 ' + state.requests + ' 次');
        ui.log('  分段：' + stages.map(function (x) {
            return x.name + ' ' + (x.ms / 1000).toFixed(1) + 's';
        }).join(' / '));
        if (unresolved) ui.log('  未解析标题 ' + unresolved + ' 款（spaceId 仍可用）');
        enableDownloads(true);
        return state.result;
    }

    // ── 输出 ────────────────────────────────────────────────────────────────
    function download(filename, text, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function baseName() {
        const r = state.result;
        const who = (r && r.account && (r.account.nameOnPlatform || r.account.userId))
            ? (r.account.nameOnPlatform || r.account.userId) : 'ubisoft';
        const day = new Date().toISOString().slice(0, 10);
        return 'ubisoft-library-' + String(who).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') + '-' + day;
    }

    function exportJson() {
        if (!state.result) return;
        download(baseName() + '.json', JSON.stringify(state.result, null, 2), 'application/json');
    }

    // ── 界面 ────────────────────────────────────────────────────────────────
    const ui = (function () {
        let root, panel, statusEl, elapsedEl, barEl, logEl, btnRun, btnJson, btnLogin;

        function inject() {
            root = document.createElement('div');
            root.id = 'ubi-export-root';
            root.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483647;';

            root.innerHTML = ''
                + '<style>'
                + '#ubi-export-root *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}'
                + '#ubi-export-fab{position:fixed;right:18px;bottom:18px;padding:10px 16px;border:0;border-radius:22px;'
                + 'background:#1a7ff0;color:#fff;font-size:13px;font-weight:600;cursor:pointer;'
                + 'box-shadow:0 4px 16px rgba(0,0,0,.35);transition:transform .12s}'
                + '#ubi-export-fab:hover{transform:translateY(-1px)}'
                + '#ubi-export-panel{position:fixed;right:18px;bottom:68px;width:340px;display:none;'
                + 'background:#12161c;color:#e6e9ee;border-radius:12px;padding:16px;'
                + 'box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid #232a33}'
                + '#ubi-export-panel h3{margin:0 0 4px;font-size:15px;font-weight:700}'
                + '#ubi-export-panel .sub{font-size:11px;color:#7d8896;margin-bottom:12px;line-height:1.5}'
                + '#ubi-export-statusrow{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}'
                + '#ubi-export-status{font-size:12px;color:#9aa5b1;flex:1;min-height:16px;'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
                + '#ubi-export-elapsed{font-size:12px;color:#5d6875;font-variant-numeric:tabular-nums;'
                + 'min-width:46px;text-align:right}'
                + '#ubi-export-track{height:4px;background:#232a33;border-radius:2px;overflow:hidden;margin-bottom:12px}'
                + '#ubi-export-bar{height:100%;width:0;background:#1a7ff0;transition:width .25s}'
                + '#ubi-export-log{font-size:11px;color:#6f7b89;line-height:1.6;max-height:96px;overflow:auto;'
                + 'margin-bottom:12px;white-space:pre-wrap;word-break:break-all}'
                + '#ubi-export-root button.act{width:100%;padding:9px;border:0;border-radius:7px;'
                + 'font-size:13px;font-weight:600;cursor:pointer;margin-bottom:8px}'
                + '#ubi-export-run{background:#1a7ff0;color:#fff}'
                + '#ubi-export-run:disabled{background:#2a3340;color:#5d6875;cursor:not-allowed}'
                + '#ubi-export-json{width:100%;padding:9px;border:1px solid #2f3945;border-radius:7px;'
                + 'background:#1a212a;color:#cfd6df;font-size:12px;font-weight:600;cursor:pointer}'
                + '#ubi-export-json:disabled{opacity:.35;cursor:not-allowed}'
                + '#ubi-export-login{width:100%;padding:9px;border:0;border-radius:7px;'
                + 'background:#1f6feb;color:#fff;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:8px;display:none}'
                + '</style>'
                + '<button id="ubi-export-fab">育碧库存导出</button>'
                + '<div id="ubi-export-panel">'
                + '  <h3>育碧库存导出</h3>'
                + '  <div class="sub">读取 Ubisoft Connect 的真实权益库存（owned game 口径），不上传任何数据。</div>'
                + '  <button id="ubi-export-login">去登录育碧账号（新标签页）</button>'
                + '  <div id="ubi-export-statusrow">'
                + '    <div id="ubi-export-status">就绪</div>'
                + '    <div id="ubi-export-elapsed"></div>'
                + '  </div>'
                + '  <div id="ubi-export-track"><div id="ubi-export-bar"></div></div>'
                + '  <div id="ubi-export-log"></div>'
                + '  <button id="ubi-export-run" class="act">开始导出</button>'
                + '  <button id="ubi-export-json" disabled>下载 JSON</button>'
                + '</div>';

            document.body.appendChild(root);

            panel = root.querySelector('#ubi-export-panel');
            statusEl = root.querySelector('#ubi-export-status');
            elapsedEl = root.querySelector('#ubi-export-elapsed');
            barEl = root.querySelector('#ubi-export-bar');
            logEl = root.querySelector('#ubi-export-log');
            btnRun = root.querySelector('#ubi-export-run');
            btnJson = root.querySelector('#ubi-export-json');
            btnLogin = root.querySelector('#ubi-export-login');

            root.querySelector('#ubi-export-fab').addEventListener('click', function () {
                panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
            });
            btnRun.addEventListener('click', function () {
                if (state.running) return;
                state.running = true;
                btnRun.disabled = true;
                startTicker();
                runExport().catch(function (err) {
                    const msg = (err && err.message) ? err.message : String(err);
                    stopTicker();
                    ui.log('✗ 失败：' + msg);
                    ui.progress(0, '失败');
                }).then(function () {
                    state.running = false;
                    btnRun.disabled = false;
                    stopTicker();
                });
            });
            btnJson.addEventListener('click', exportJson);
            if (btnLogin) {
                btnLogin.addEventListener('click', function () {
                    window.open(LOGIN_URL, '_blank', 'noopener');
                });
            }
        }

        return {
            mount: inject,
            hasRoot: function () { return !!root; },
            progress: function (pct, label) {
                if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
                if (statusEl && label) statusEl.textContent = label;
            },
            elapsed: function (sec) {
                if (elapsedEl) elapsedEl.textContent = sec >= 0 ? sec.toFixed(1) + 's' : '';
            },
            log: function (line) {
                if (!logEl) return;
                logEl.textContent = line + '\n' + logEl.textContent;
                logEl.scrollTop = 0;
            },
            setDownloads: function (on) {
                if (btnJson) btnJson.disabled = !on;
            },
            setLoginHint: function (on) {
                if (btnLogin) btnLogin.style.display = on ? 'block' : 'none';
            }
        };
    })();

    function enableDownloads(on) { ui.setDownloads(on); }

    // 计时器：每 100ms 刷新已用秒数，让用户看到界面在动（网络慢时秒数仍在走）。
    function startTicker() {
        stopTicker();
        state.startedAt = Date.now();
        ui.elapsed(0);
        state.ticker = setInterval(function () {
            ui.elapsed((Date.now() - state.startedAt) / 1000);
        }, 100);
    }

    function stopTicker() {
        if (state.ticker) {
            clearInterval(state.ticker);
            state.ticker = null;
        }
    }

    // ── 启动 ────────────────────────────────────────────────────────────────
    function boot() {
        if (document.getElementById('ubi-export-root')) return;
        ui.mount();
        ui.progress(0, '就绪');
        const s = readStoredSession();
        if (s.ticket) {
            ui.setLoginHint(false);
            ui.log('已检测到登录会话（' + (s.nameOnPlatform || s.userId || '已登录') + '）。点「开始导出」。');
        } else {
            ui.setLoginHint(true);
            ui.log('还没登录。点上面的按钮在新标签页登录（本页留着），登录完关掉那个标签页回来点「开始导出」。');
        }
    }

    // 供 Node 侧测试直接驱动主流程（不依赖 DOM）。
    if (typeof window !== 'undefined') {
        window.__ubisoftExport = {
            readStoredSession: readStoredSession,
            pickEntitlements: pickEntitlements,
            classifyEntitlements: classifyEntitlements,
            collapseBySpaceId: collapseBySpaceId,
            collectPlatforms: collectPlatforms,
            titleErrorCodeOf: titleErrorCodeOf,
            isSessionExpired: isSessionExpired,
            toMillis: toMillis,
            runExport: runExport,
            SESSION_KEYS: SESSION_KEYS,
            LOGIN_URL: LOGIN_URL,
            LOGIN_PATH: LOGIN_PATH,
            LOGIN_ORIGIN: LOGIN_ORIGIN,
            LOGIN_APP_ID: LOGIN_APP_ID,
            JSON_LANG: JSON_LANG,
            state: state
        };
    }

    if (typeof document === 'undefined') return;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
