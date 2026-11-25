// 育碧库存导出脚本的自测台。
//
// 目的：不依赖浏览器，把用户脚本丢进 vm 沙箱，用假的 localStorage + fetch 跑完整导出流程，
// 覆盖真实会遇到的几种情况（401 换票、重复 spaceId、标题接口失败降级、未登录）。
//
// 用法：node tools/selftest.cjs
// 退出码 0 表示全部通过。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'ubisoft-library-export.user.js');

let pass = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        pass += 1;
    } catch (err) {
        failures.push({ name, err });
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        pass += 1;
    } catch (err) {
        failures.push({ name, err });
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(label + '：期望 ' + e + '，实际 ' + a);
}

// ── DOM 桩 ──────────────────────────────────────────────────────────────────
// 导出主流程不碰 DOM，但界面那一路（面板、按钮、日志）是最容易改坏又最难自查的部分：
// 手滑把 addEventListener 写掉、把 logBlock 写成逐行 log，导出照跑、面板却悄悄坏了。
// 所以给 mountUi 场景提供一个够真的桩，让 boot() 真的挂上去、按钮真的点得到。
function makeDom() {
    const byId = new Map();

    function makeEl(tag) {
        const el = {
            tagName: tag,
            style: {},
            textContent: '',
            innerHTML: '',
            disabled: false,
            children: [],
            _listeners: {},
            addEventListener: function (type, fn) {
                (this._listeners[type] = this._listeners[type] || []).push(fn);
            },
            appendChild: function (c) { this.children.push(c); return c; },
            remove: function () {},
            click: function () {
                const fns = this._listeners.click || [];
                fns.forEach(function (f) { f.call(el, { target: el }); });
            }
        };
        // 脚本是先 createElement 再 el.id = 'xxx'，靠 setter 自动登记，
        // 这样 document.getElementById 才能找到真实建出来的节点。
        let _id = '';
        Object.defineProperty(el, 'id', {
            get: function () { return _id; },
            set: function (v) { _id = v; if (v) byId.set(v, el); },
            configurable: true,
            enumerable: true
        });
        // innerHTML 不解析；脚本随后用 querySelector('#id') 逐个取，按 id 造占位节点。
        el.querySelector = function (sel) {
            if (sel.charAt(0) !== '#') return null;
            const id = sel.slice(1);
            if (!byId.has(id)) {
                const dummy = makeEl('div');
                dummy.id = id;
            }
            return byId.get(id);
        };
        el.querySelectorAll = function () { return []; };
        return el;
    }

    const body = makeEl('body');
    return {
        body: body,
        byId: byId,
        document: {
            readyState: 'complete',
            body: body,
            getElementById: function (id) { return byId.has(id) ? byId.get(id) : null; },
            addEventListener: function () {},
            querySelector: function () { return null; },
            createElement: function (tag) { return makeEl(tag); }
        }
    };
}

// ── 沙箱 ────────────────────────────────────────────────────────────────────
// route 三种写法：
//   { status, body }                   每次返回同一结果
//   { responses: [{status,body}, …] }  按顺序消费，用完后重复最后一条
//   { networkError: '…' }              抛错，模拟断网
function makeSandbox(options) {
    const opts = options || {};
    const store = Object.assign({}, opts.store);
    const calls = [];
    const routes = opts.routes || [];
    const cursors = new Map();

    function matchRoute(url, method) {
        for (let i = 0; i < routes.length; i += 1) {
            const r = routes[i];
            if (r.url && url.indexOf(r.url) === -1) continue;
            if (r.method && String(method).toUpperCase() !== String(r.method).toUpperCase()) continue;
            return r;
        }
        return null;
    }

    async function fakeFetch(url, init) {
        const method = (init && init.method) || 'GET';
        calls.push({ url, method, headers: (init && init.headers) || null, body: (init && init.body) || null });
        const route = matchRoute(url, method);
        if (!route) throw new Error('未配置的请求：' + method + ' ' + url);
        if (route.networkError) throw new Error(route.networkError);

        let step = route;
        if (Array.isArray(route.responses)) {
            const idx = cursors.get(route) || 0;
            step = route.responses[Math.min(idx, route.responses.length - 1)];
            cursors.set(route, idx + 1);
        }

        const body = typeof step.body === 'function' ? step.body(calls.length) : step.body;
        const status = step.status || 200;
        const text = body === undefined || body === null ? '' : JSON.stringify(body);
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async function () { return text; }
        };
    }

    const dom = opts.mountUi ? makeDom() : null;

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Date,
        JSON,
        Math,
        Promise,
        Map,
        Set,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Error,
        encodeURIComponent,
        decodeURIComponent,
        localStorage: {
            getItem: function (k) {
                return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
            },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; }
        },
        fetch: fakeFetch,
        // 会话按 origin 隔离，自检的第一件事就是比对当前域，所以沙箱必须能指定 location。
        location: {
            origin: opts.origin || 'https://zh-cn.ubisoft.com',
            protocol: 'https:',
            host: (opts.origin || 'https://zh-cn.ubisoft.com').replace(/^https?:\/\//, '')
        },
        Blob: function Blob(parts) { this.parts = parts; },
        URL: {
            createObjectURL: function () { return 'blob:fake'; },
            revokeObjectURL: function () {}
        },
        document: opts.mountUi ? dom.document : {
            // 默认不挂界面：getElementById 返回真值让 boot() 直接早退，
            // 导出主流程根本用不到 DOM。要测界面就传 mountUi:true。
            readyState: 'complete',
            getElementById: function () { return {}; },
            addEventListener: function () {},
            createElement: function () {
                return { style: {}, appendChild: function () {}, click: function () {}, remove: function () {} };
            },
            body: { appendChild: function () {} }
        }
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'ubisoft-library-export.user.js' });

    return { sandbox, api: sandbox.__ubisoftExport, calls, store, dom: opts.mountUi ? dom : null };
}

// ── 语料 ────────────────────────────────────────────────────────────────────
const SESSION = JSON.stringify({
    ticket: 'T1-OLD',
    sessionId: 'S1',
    userId: 'u-1234',
    nameOnPlatform: 'TestPlayer',
    email: 'test@example.com',
    expirationDate: 1900000000000
});

// 八条权益：A 出现两次（同 spaceId）、一条 DLC、一条过期、一条非 owned、一条 null。
const ENTITLEMENTS = [
    { spaceId: 'A', productId: 'p1', accessLevel: 'owned', type: 'game', availability: 'owned' },
    { spaceId: 'A', productId: 'p2', accessLevel: 'owned', type: 'game', availability: 'owned' },
    { spaceId: 'B', productId: 'p3', accessLevel: 'owned', type: 'dlc', availability: 'owned' },
    { spaceId: 'C', productId: 'p4', accessLevel: 'owned', type: 'game', availability: 'expired' },
    { spaceId: 'D', productId: 'p5', accessLevel: 'locked', type: 'game', availability: 'owned' },
    null,
    { spaceId: 'E', productId: 'p6', accessLevel: 'owned', type: 'game' },
    { spaceId: 'F', productId: 'p7', accessLevel: 'owned', type: 'game', availability: 'owned' }
];

function graphqlBody(spaceIds) {
    const titles = { A: 'Anno 1800', E: 'The Settlers' };
    return {
        data: {
            games: spaceIds
                .filter(function (id) { return titles[id]; })
                .map(function (id) {
                    return {
                        id: 'gid-' + id,
                        spaceId: id,
                        name: titles[id],
                        platform: { id: 'p-' + id, name: 'PC', type: 'uplay' },
                        availablePlatformGroups: [
                            { id: 'g1', name: 'PC', type: 'uplay' },
                            { id: 'g2', name: 'PC', type: 'uplay' }
                        ],
                        availablePlatforms: { nodes: [{ id: 'a1', name: 'PC' }] }
                    };
                })
        }
    };
}

function happyRoutes() {
    return [
        {
            url: '/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
            method: 'GET',
            status: 200,
            body: { entitlements: ENTITLEMENTS }
        },
        {
            url: '/v2/profiles/sessions',
            method: 'POST',
            status: 200,
            body: { ticket: 'T2-NEW', sessionId: 'S2', userId: 'u-1234' }
        },
        {
            url: '/v1/profiles/me/uplay/graphql',
            method: 'POST',
            status: 200,
            body: function () { return graphqlBody(['A', 'E']); }
        }
    ];
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────
function testPureFunctions() {
    const { api } = makeSandbox({ store: { PRODloginData: SESSION } });

    check('pickEntitlements 支持四种载荷形态', function () {
        assertEqual(api.pickEntitlements([{ a: 1 }]).length, 1, '裸数组');
        assertEqual(api.pickEntitlements({ entitlements: [{ a: 1 }, { a: 2 }] }).length, 2, 'entitlements 数组');
        assertEqual(api.pickEntitlements({ entitlements: { nodes: [{ a: 1 }] } }).length, 1, 'entitlements.nodes');
        assertEqual(api.pickEntitlements({ nodes: [{ a: 1 }, { a: 2 }, { a: 3 }] }).length, 3, '顶层 nodes');
        assertEqual(api.pickEntitlements(null).length, 0, 'null 降级为空数组');
        assertEqual(api.pickEntitlements({}).length, 0, '空对象降级为空数组');
    });

    check('classifyEntitlements 过滤口径与计数', function () {
        const r = api.classifyEntitlements(ENTITLEMENTS);
        assertEqual(r.kept.length, 4, 'kept 条数（A 两条 + E + F）');
        assertEqual(r.stats.total, 8, 'total');
        assertEqual(r.stats.notGame, 1, 'notGame');
        assertEqual(r.stats.expired, 1, 'expired');
        assertEqual(r.stats.notOwned, 1, 'notOwned');
        assertEqual(r.stats.malformed, 1, 'malformed');
    });

    check('collapseBySpaceId 按 spaceId 去重并保留 productId', function () {
        const kept = api.classifyEntitlements(ENTITLEMENTS).kept;
        const r = api.collapseBySpaceId(kept);
        assertEqual(r.items.length, 3, '去重后条数');
        assertEqual(r.duplicates, 1, '重复条数');
        assertEqual(r.items.map(function (x) { return x.spaceId; }), ['A', 'E', 'F'], '保留顺序');
        assertEqual(r.items[0].productId, 'p1', '重复项保留首个 productId');
    });

    check('collectPlatforms 四处来源取并集且去重', function () {
        const platforms = api.collectPlatforms({
            platform: { name: 'PC' },
            availablePlatformGroups: [{ name: 'PC' }, { name: 'PS5' }],
            availablePlatforms: { nodes: [{ name: 'XSX' }] },
            viewer: { meta: { ownedCrossplayPlatforms: { nodes: [{ name: 'PC' }, { name: 'PS5' }] } } }
        });
        assertEqual(platforms, ['PC', 'PS5', 'XSX'], '并集去重');
    });

    check('readStoredSession 缺字段时不误判为已登录', function () {
        const empty = makeSandbox({ store: {} });
        assertEqual(empty.api.readStoredSession().ticket, null, '无 ticket');
        const broken = makeSandbox({ store: { PRODloginData: '{not json' } });
        assertEqual(broken.api.readStoredSession().ticket, null, '坏 JSON 不抛错');
        const ok = makeSandbox({ store: { PRODloginData: SESSION } });
        assertEqual(ok.api.readStoredSession().nameOnPlatform, 'TestPlayer', '正常读取');
    });

    // 回归：connect.ubisoft.com 根路径会 301 到官网营销页；登录页必须带 appId，
    // 且绝不能带 genomeId（实测两者都会让 SPA 自己 navigate('/error')）。
    check('登录 URL 带 appId、不带 genomeId、不是裸根路径', function () {
        const url = new URL(api.LOGIN_URL);
        assertEqual(url.pathname, '/login', '路径必须是 /login');
        assertEqual(url.searchParams.get('appId'), api.LOGIN_APP_ID, '带 appId');
        assertEqual(url.searchParams.get('genomeId'), null, '不能带 genomeId');
        assertEqual(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(api.LOGIN_APP_ID), true, 'appId 是合法 GUID');
    });

    // 回归：默认 nexturl 是 https://ubisoft.com，那个域名按 IP 落到区域站（美国代理 → 美区）。
    // 实测 nexturl 只保得住一次跳转（我们设的 nexturl 自身不带 nexturl 参数，落地后再登录就回落默认值），
    // 所以策略改成「让脚本覆盖区域站」，登录 URL 不再塞 nexturl —— 塞了反而让人以为能钉住落点。
    check('登录 URL 不再试图用 nexturl 钉住落点', function () {
        const url = new URL(api.LOGIN_URL);
        assertEqual(url.searchParams.get('nexturl'), null, '不再设置 nexturl（它只保一次跳转，是假保护）');
        assertEqual(url.origin, 'https://connect.ubisoft.com', '登录页仍在 connect 域');
    });

    check('脚本覆盖区域站，不再只匹配 connect 域', function () {
        const head = fs.readFileSync(SCRIPT, 'utf8');
        assert(head.indexOf('@match        https://*.ubisoft.com/*') !== -1, '@match 必须覆盖 ubisoft.com 子域（区域站）');
        assert(head.indexOf('@match        https://connect.ubisoft.com/*') !== -1, '@match 仍要覆盖 connect 域');
        assertEqual(api.SESSION_KEYS.indexOf('PRODOverlayConnectLoginData') !== -1, true, '必须读区域站的 overlay 会话键');
    });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function testRunExport() {
    await checkAsync('runExport 正常路径：口径、排序、未解析计数', async function () {
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes: happyRoutes() });
        const result = await env.api.runExport();
        assertEqual(result.schemaVersion, 1, 'schemaVersion');
        assertEqual(result.source, 'ubisoft-ubiconnect-entitlements', 'source');
        assertEqual(result.account.nameOnPlatform, 'TestPlayer', '账号名');
        assertEqual(result.summary.gameCount, 3, '游戏数');
        assertEqual(result.summary.entitlementCount, 8, '权益总数');
        assertEqual(result.summary.ownedGameEntitlementCount, 4, 'owned game 条数');
        assertEqual(result.summary.duplicateSpaceIds, 1, '重复 spaceId');
        assertEqual(result.summary.unresolvedCount, 1, '未解析 1 款（F）');
        assertEqual(result.summary.titleError, null, '无标题错误');
        assertEqual(result.games.map(function (g) { return g.spaceId; }), ['A', 'F', 'E'], '按名称排序');
        assertEqual(result.games[0].name, 'Anno 1800', 'A 的名称');
        assertEqual(result.games[0].platforms, ['PC'], '平台并集（PC 去重）');
        assertEqual(result.games[1].name, null, 'F 无标题');
        assertEqual(result.games[1].resolved, false, 'F unresolved');
        // 权益 1 次 + 标题 1 次（3 个 spaceId 不足一块）
        assertEqual(env.calls.length, 2, '正常路径请求次数');
    });

    await checkAsync('runExport 按 TITLE_CHUNK 分块请求标题', async function () {
        const total = 300;
        const many = [];
        for (let i = 0; i < total; i += 1) {
            many.push({ spaceId: 'S' + i, productId: 'p' + i, accessLevel: 'owned', type: 'game' });
        }
        let chunkCalls = 0;
        const routes = [
            { url: '/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements', method: 'GET', status: 200, body: { entitlements: many } },
            { url: '/v2/profiles/sessions', method: 'POST', status: 200, body: { ticket: 'T2' } },
            {
                url: '/v1/profiles/me/uplay/graphql',
                method: 'POST',
                status: 200,
                body: function () {
                    chunkCalls += 1;
                    return { data: { games: [] } };
                }
            }
        ];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const result = await env.api.runExport();
        assertEqual(chunkCalls, 3, '300 条 / 120 每块 = 3 块');
        assertEqual(result.summary.gameCount, 300, '库存条数不受分块影响');
        const gqlCalls = env.calls.filter(function (c) { return c.url.indexOf('graphql') !== -1; });
        const firstChunk = JSON.parse(gqlCalls[0].body).variables.spaceIds;
        assertEqual(firstChunk.length, 120, '每块 120 个 spaceId');
    });

    await checkAsync('runExport 遇 401 自动换票后重试成功', async function () {
        const routes = [
            {
                url: '/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
                method: 'GET',
                responses: [
                    { status: 401, body: { error: 'unauthorized' } },
                    { status: 200, body: { entitlements: ENTITLEMENTS } }
                ]
            },
            { url: '/v2/profiles/sessions', method: 'POST', status: 200, body: { ticket: 'T2-NEW', sessionId: 'S2' } },
            { url: '/v1/profiles/me/uplay/graphql', method: 'POST', status: 200, body: function () { return graphqlBody(['A', 'E']); } }
        ];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const result = await env.api.runExport();

        assertEqual(result.summary.gameCount, 3, '换票后成功拿到库');
        assertEqual(env.calls.length, 4, '权益2次 + 换票1次 + 标题1次');

        const sessionCall = env.calls[1];
        assertEqual(sessionCall.method, 'POST', '第二次请求是换票');
        assert(sessionCall.url.indexOf('/v2/profiles/sessions') !== -1, '请求落在 sessions 接口');
        assertEqual(sessionCall.headers.Authorization, 'Ubi_v1 t=T1-OLD', '换票用旧 ticket');

        const retryCall = env.calls[2];
        assert(retryCall.url.indexOf('entitlement') !== -1, '重试的是权益接口');
        assertEqual(retryCall.headers.Authorization, 'Ubi_v1 t=T2-NEW', '重试用新 ticket');
        assertEqual(retryCall.headers['Ubi-SessionId'], 'S2', '重试用新 sessionId');
    });

    await checkAsync('runExport 换票后仍 401 时报错而不是静默产出空库', async function () {
        const routes = [
            {
                url: '/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
                method: 'GET',
                status: 401,
                body: { error: 'unauthorized' }
            },
            { url: '/v2/profiles/sessions', method: 'POST', status: 200, body: { ticket: 'T2-NEW', sessionId: 'S2' } },
            { url: '/v1/profiles/me/uplay/graphql', method: 'POST', status: 200, body: function () { return graphqlBody([]); } }
        ];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        let message = '';
        try {
            await env.api.runExport();
        } catch (err) {
            message = err.message;
        }
        assert(message.indexOf('401') !== -1, '错误信息应包含状态码，实际：' + message);
        assertEqual(env.api.state.result, null, '失败时不留下半成品结果');
    });

    await checkAsync('runExport 标题接口失败时降级但仍产出完整库存', async function () {
        const routes = happyRoutes();
        routes[2] = { url: '/v1/profiles/me/uplay/graphql', method: 'POST', status: 500, body: { error: 'boom' } };
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const result = await env.api.runExport();
        assertEqual(result.summary.gameCount, 3, '游戏数不受影响');
        assertEqual(result.summary.unresolvedCount, 3, '全部未解析');
        assert(result.summary.titleError && result.summary.titleError === 'HTTP_500', 'titleError 是英文错误码，实际：' + result.summary.titleError);
        assertEqual(result.games[0].spaceId, 'A', '按 spaceId 排序');
    });

    await checkAsync('导出的 JSON 全部英文（含降级路径）', async function () {
        const routes = happyRoutes();
        routes[2] = { url: '/v1/profiles/me/uplay/graphql', method: 'POST', status: 500, body: { error: 'boom' } };
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const result = await env.api.runExport();
        const text = JSON.stringify(result);
        const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
        assertEqual(cjk, null, 'JSON 里不能有中文，实际出现：' + (cjk ? cjk.join('') : ''));
        assertEqual(result.summary.titleError, 'HTTP_500', '英文错误码');
    });

    // 英文标题不是巧合：育碧按 Ubi-LocaleCode 返回译名（实测 zh-CN 下 WATCH_DOGS™ 会变成「看门狗」）。
    // 所以每一个出站请求都必须带 en-US，少一个就可能出现中文。
    await checkAsync('每个出站请求都带 Ubi-LocaleCode: en-US', async function () {
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes: happyRoutes() });
        const result = await env.api.runExport();
        assert(env.calls.length > 0, '应该至少发出一个请求');
        env.calls.forEach(function (c, i) {
            const headers = c.headers || {};
            assertEqual(headers['Ubi-LocaleCode'], 'en-US', '第 ' + (i + 1) + ' 个请求（' + c.url + '）的 Ubi-LocaleCode');
        });
        assertEqual(env.api.JSON_LANG, 'en-US', '导出的 JSON_LANG 常量');
        const cjk = JSON.stringify(result).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
        assertEqual(cjk, null, '成功路径的 JSON 也不能有中文');
    });

    // 浏览器里残留的旧票会让人以为"已登录"，实测中我也被它骗过一次。
    // 过期必须明确拒绝，不能拿它去抓库。
    await checkAsync('残留的过期票据必须拒绝导出，不发任何请求', async function () {
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes: happyRoutes() });
        const expiredSession = Object.assign(JSON.parse(SESSION), { expirationDate: Date.now() - 60000 });
        let message = '';
        try {
            await env.api.runExport(expiredSession);
        } catch (err) {
            message = err.message;
        }
        assert(message.indexOf('过期') !== -1, '提示应说明会话已过期，实际：' + message);
        assert(message.indexOf('connect.ubisoft.com') !== -1, '提示应给出重新登录地址');
        assertEqual(env.calls.length, 0, '过期票据不发任何请求');
        assertEqual(env.api.state.result, null, '不产出结果');
    });

    await checkAsync('isSessionExpired 的边界', async function () {
        const api = makeSandbox({ store: {}, routes: [] }).api;
        assertEqual(api.isSessionExpired({ expirationDate: Date.now() - 1000 }), true, '刚过期');
        assertEqual(api.isSessionExpired({ expirationDate: Date.now() + 60000 }), false, '还有效');
        assertEqual(api.isSessionExpired({ expirationDate: null }), false, '缺字段不断言');
        assertEqual(api.isSessionExpired({}), false, '无字段不断言');
        assertEqual(api.isSessionExpired({ expirationDate: 'not-a-date' }), false, '非法值不断言');
        // 区域站给的是 ISO 字符串（实测 PRODOverlayConnectLoginData.expiration = "2026-11-25T09:41:00.8258425Z"）
        assertEqual(api.isSessionExpired({ expirationDate: '2999-01-01T00:00:00Z' }), false, 'ISO 未来时间不算过期');
        assertEqual(api.isSessionExpired({ expirationDate: '2000-01-01T00:00:00Z' }), true, 'ISO 过去时间算过期');
    });

    // 区域站（代理/海外场景）实测的 localStorage 形状，原样搬进来：
    //   PRODOverlayConnectLoginData = {opId, ticket, user_id, sessionId, expiration(ISO)}
    //   PRODloginData = {opId:"GetTicket", status:"ok", payload:{ticket,userId,sessionId,expiration}}
    // 两者的票都属于别的 appId，直接调库存接口 401，必须换票后才能用。
    const OVERLAY = JSON.stringify({
        opId: 'GetTicket',
        ticket: 'OV-TICKET',
        user_id: 'u-overlay',
        sessionId: 'S-overlay',
        expiration: '2999-01-01T00:00:00.0000000Z'
    });

    const WRAPPED = JSON.stringify({
        opId: 'GetTicket',
        status: 'ok',
        payload: {
            ticket: 'WRAP-TICKET',
            userId: 'u-wrapped',
            sessionId: 'S-wrapped',
            expiration: '2000-01-01T00:00:00.0000000Z'
        }
    });

    check('readStoredSession 能读区域站两种形状，并跳过已过期的', function () {
        const overlayOnly = makeSandbox({ store: { PRODOverlayConnectLoginData: OVERLAY } });
        const a = overlayOnly.api.readStoredSession();
        assertEqual(a.ticket, 'OV-TICKET', '读 overlay 的票');
        assertEqual(a.userId, 'u-overlay', 'user_id 映射成 userId');
        assertEqual(a.key, 'PRODOverlayConnectLoginData', '记录来源键');
        assert(a.expirationDate > Date.now(), 'ISO 过期时间被解析成毫秒');

        const wrapped = makeSandbox({ store: { PRODloginData: WRAPPED } });
        const b = wrapped.api.readStoredSession();
        assertEqual(b.ticket, 'WRAP-TICKET', '能钻进 payload 里取票');
        assertEqual(b.userId, 'u-wrapped', 'payload 里的 userId');
    });

    check('区域站两份会话并存时，优先选没过期的那张', function () {
        // PRODloginData 排在 SESSION_KEYS 前面，但它里面是过期票；必须跳到 overlay 那张。
        const env = makeSandbox({ store: { PRODloginData: WRAPPED, PRODOverlayConnectLoginData: OVERLAY } });
        const s = env.api.readStoredSession();
        assertEqual(s.ticket, 'OV-TICKET', '不能因为顺序靠前就选过期票');
        assertEqual(s.key, 'PRODOverlayConnectLoginData', '来源键是 overlay');
    });

    await checkAsync('区域站的票直接 401 时，换票后能正常导出', async function () {
        const routes = [
            {
                url: '/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements',
                method: 'GET',
                responses: [
                    { status: 401, body: { errorCode: '2000', message: 'Unauthorized' } },
                    { status: 200, body: { entitlements: ENTITLEMENTS } }
                ]
            },
            {
                url: '/v2/profiles/sessions',
                method: 'POST',
                status: 200,
                body: {
                    ticket: 'T2-EXCHANGED',
                    sessionId: 'S2',
                    userId: 'u-overlay',
                    nameOnPlatform: 'RealPlayer',
                    expiration: '2999-01-01T00:00:00.0000000Z'
                }
            },
            { url: '/v1/profiles/me/uplay/graphql', method: 'POST', status: 200, body: function () { return graphqlBody(['A', 'E']); } }
        ];
        const env = makeSandbox({ store: { PRODOverlayConnectLoginData: OVERLAY }, routes });
        const result = await env.api.runExport();

        assertEqual(result.summary.gameCount, 3, '换票后拿到完整库存');
        assertEqual(result.account.userId, 'u-overlay', '账号来自 localStorage');
        assertEqual(result.account.nameOnPlatform, 'RealPlayer', '换票响应里的 nameOnPlatform 被采纳');
        const sessionCall = env.calls[1];
        assertEqual(sessionCall.headers.Authorization, 'Ubi_v1 t=OV-TICKET', '换票用的是区域站的票');
        const retry = env.calls[2];
        assertEqual(retry.headers.Authorization, 'Ubi_v1 t=T2-EXCHANGED', '重试用换来的票');
    });

    await checkAsync('toMillis 能同时吃毫秒数与 ISO 字符串', async function () {
        const api = makeSandbox({ store: {} }).api;
        assertEqual(api.toMillis(1900000000000), 1900000000000, '毫秒数原样返回');
        assertEqual(api.toMillis('2999-01-01T00:00:00Z'), Date.parse('2999-01-01T00:00:00Z'), 'ISO 解析');
        assertEqual(api.toMillis(null), null, 'null');
        assertEqual(api.toMillis(''), null, '空串');
        assertEqual(api.toMillis('乱码'), null, '非法串');
    });

    await checkAsync('runExport 未登录时给出可操作提示且不发请求', async function () {
        const env = makeSandbox({ store: {}, routes: happyRoutes() });
        let message = '';
        try {
            await env.api.runExport();
        } catch (err) {
            message = err.message;
        }
        assert(message.indexOf('connect.ubisoft.com') !== -1, '提示应包含登录地址');
        assert(message.indexOf('PRODloginData') !== -1, '提示应包含 localStorage 键名');
        assertEqual(env.calls.length, 0, '未登录时不发任何请求');
    });

    await checkAsync('runExport 名义上无权益时产出空库而不是报错', async function () {
        const routes = happyRoutes();
        routes[0] = { url: '/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements', method: 'GET', status: 200, body: [] };
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const result = await env.api.runExport();
        assertEqual(result.summary.gameCount, 0, '空库');
        assertEqual(result.games.length, 0, 'games 为空数组');
        assertEqual(env.calls.length, 1, '没有 spaceId 时不请求标题接口');
    });
}

// ── 环境自检 ────────────────────────────────────────────────────────────────
// 自检的价值全在「把三种失败分开」：请求没发出去 / 票据被拒 / 服务端 5xx。
// 下面逐个钉住，避免以后改文案时把三种混成一句「失败了」。
async function testEnvCheck() {
    check('每个 SESSION_KEY 都单独报告有没有票据', function () {
        const env = makeSandbox({ store: { PRODloginData: SESSION } });
        const rows = env.api.describeSessionKeys();
        assertEqual(rows.length, 3, '三个键各一行');
        assertEqual(rows.map(function (r) { return r.key; }), env.api.SESSION_KEYS.slice(), '顺序与 SESSION_KEYS 一致');

        const byKey = {};
        rows.forEach(function (r) { byKey[r.key] = r; });
        assertEqual(byKey.PRODloginData.state, 'ok', '有票的键标 ok');
        assertEqual(byKey.loginData.state, 'missing', '没有的键标 missing');
        assertEqual(byKey.PRODOverlayConnectLoginData.state, 'missing', '没读到的键不能算 ok');
    });

    check('坏 JSON 与缺字段要和「没有」区分开', function () {
        const broken = makeSandbox({ store: { PRODloginData: '{not json' } });
        const row = broken.api.describeSessionKeys()[0];
        assertEqual(row.state, 'broken', '坏 JSON 单独一档');
        assert(row.text.indexOf('不是 JSON') !== -1, '文案要说清是格式问题');

        const incomplete = makeSandbox({ store: { PRODloginData: JSON.stringify({ ticket: 'T' }) } });
        const row2 = incomplete.api.describeSessionKeys()[0];
        assertEqual(row2.state, 'incomplete', '缺 sessionId 单独一档');
    });

    await checkAsync('请求没发出去时，结论必须指向本地拦截而不是账号', async function () {
        const routes = [{ url: '/entitlements', method: 'GET', networkError: 'Failed to fetch' }];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const report = await env.api.collectEnvReport();

        assertEqual(report.probe.reached, false, '标成没到达');
        assert(report.probe.message.indexOf('Failed to fetch') !== -1, '保留原始错误原文');
        const line = report.lines[report.lines.length - 1];
        assert(line.indexOf('根本没发出去') !== -1, '结论要说请求没发出去');
        assert(line.indexOf('不是账号问题') !== -1, '要排掉账号方向');
        assert(line.indexOf('拦截') !== -1, '要指出本地拦截');
    });

    await checkAsync('401 时结论指向票据，而不是网络', async function () {
        const routes = [{ url: '/entitlements', method: 'GET', status: 401, body: { message: 'Unauthorized' } }];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const report = await env.api.collectEnvReport();

        assertEqual(report.probe.reached, true, '请求到达了');
        assertEqual(report.probe.status, 401, '状态码原样带出');
        const line = report.lines[report.lines.length - 1];
        assert(line.indexOf('票据') !== -1, '结论要说票据');
        assert(line.indexOf('401') !== -1, '带上状态码');
        assert(line.indexOf('PRODloginData') !== -1, '指出票是从哪个 key 读的');
    });

    await checkAsync('2xx 时结论是链路正常', async function () {
        const routes = [{ url: '/entitlements', method: 'GET', status: 200, body: { entitlements: ENTITLEMENTS } }];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const report = await env.api.collectEnvReport();
        const line = report.lines[report.lines.length - 1];
        assert(line.indexOf('链路正常') !== -1, '2xx 要报正常');
        assert(report.probe.bytes > 0, '带上响应字节数');
    });

    await checkAsync('5xx 时不能说成浏览器问题', async function () {
        const routes = [{ url: '/entitlements', method: 'GET', status: 503, body: { message: 'down' } }];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        const report = await env.api.collectEnvReport();
        const line = report.lines[report.lines.length - 1];
        assert(line.indexOf('503') !== -1, '带上状态码');
        assert(line.indexOf('服务端') !== -1, '要指向服务端');
        assert(line.indexOf('不是浏览器') !== -1, '要明确排除浏览器');
    });

    await checkAsync('自检会明确指出当前域名和抓取页是否一致', async function () {
        const onCapture = makeSandbox({ store: {}, origin: 'https://zh-cn.ubisoft.com', routes: [{ url: '/entitlements', status: 200, body: [] }] });
        const a = await onCapture.api.collectEnvReport();
        assertEqual(a.onCaptureOrigin, true, '抓取页上要标 true');
        assert(a.lines[1].indexOf('就是抓取页') !== -1, '文案点明就是抓取页');

        const elsewhere = makeSandbox({ store: {}, origin: 'https://www.ubisoft.com', routes: [{ url: '/entitlements', status: 200, body: [] }] });
        const b = await elsewhere.api.collectEnvReport();
        assertEqual(b.onCaptureOrigin, false, '别的域要标 false');
        assert(b.lines[1].indexOf('换域读不到') !== -1, '文案解释跨域读不到');
    });

    await checkAsync('没票时自检仍然照发探测请求，不提前放弃', async function () {
        // 没票也要探：能区分「服务端回 401」和「本地就拦了」，这是用户最需要的那条信息。
        const env = makeSandbox({ store: {}, routes: [{ url: '/entitlements', method: 'GET', status: 401, body: {} }] });
        const report = await env.api.collectEnvReport();
        assertEqual(env.calls.length, 1, '仍然发了一次探测');
        assertEqual(report.hasTicket, false, '报告里标明没票');
        const headers = env.calls[0].headers;
        assertEqual(headers.Authorization, undefined, '没票时不能伪造 Authorization 头');
        assertEqual(headers['Ubi-AppId'], 'f68a4bb5-608a-4ff2-8123-be8ef797e0a6', '仍带上 appId');
    });

    check('抓取页常量与 @match 覆盖的域一致', function () {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        assert(src.indexOf('https://zh-cn.ubisoft.com') !== -1, '常量宿主要在 @match 的 *.ubisoft.com 覆盖范围内');
        const env = makeSandbox({ store: {} });
        assertEqual(env.api.CAPTURE_URL, env.api.CAPTURE_ORIGIN + '/', 'CAPTURE_URL 由 origin 拼出');
    });

    await checkAsync('导出遇到网络层失败时，错误带 networkProblem 标记供界面触发自检', async function () {
        const routes = [{ url: '/entitlements', method: 'GET', networkError: 'Failed to fetch' }];
        const env = makeSandbox({ store: { PRODloginData: SESSION }, routes });
        let err = null;
        try {
            await env.api.runExport();
        } catch (e) {
            err = e;
        }
        assert(err, '必须抛错');
        assertEqual(err.networkProblem, true, '网络层失败要打标记');
        assert(err.message.indexOf('Failed to fetch') !== -1, '保留原始错误原文');
    });
}

// ── 界面 ────────────────────────────────────────────────────────────────────
// 默认沙箱让 boot() 早退，面板那一路从没被执行过。这里用真 DOM 桩挂上去，
// 把「提示按钮该不该露」「自检报告顺序」「失败自动自检」这些肉眼才看得出的问题钉住。
async function testUi() {
    // 抓取页 + 有会话 → 挂上、两个提示按钮都不露
    await checkAsync('界面 抓取页且已登录：挂载并收起两个提示按钮', function () {
        const env = makeSandbox({
            mountUi: true,
            store: { PRODloginData: SESSION },
            origin: 'https://zh-cn.ubisoft.com',
            routes: [{ url: '/entitlements', status: 200, body: { entitlements: [] } }]
        });
        assert(env.dom.byId.get('ubi-export-root'), 'boot() 必须挂上根节点');
        assert(env.dom.body.children.length > 0, '根节点必须 append 到 body');

        const logEl = env.dom.byId.get('ubi-export-log');
        assert(logEl && logEl.textContent.indexOf('已检测到登录会话') !== -1, '有会话时要提示已检出');
        assertEqual(env.dom.byId.get('ubi-export-login').style.display, 'none', '有会话时不显示登录按钮');
        assertEqual(env.dom.byId.get('ubi-export-capture').style.display, 'none', '已在抓取页时不显示前往抓取按钮');
    });

    // 别的域 + 没会话 → 两个按钮都要露，且文案点明跨域读不到
    await checkAsync('界面 别的域且未登录：给出登录与前往抓取两个入口', function () {
        const env = makeSandbox({ mountUi: true, store: {}, origin: 'https://www.ubisoft.com', routes: [] });
        assertEqual(env.dom.byId.get('ubi-export-login').style.display, 'block', '没会话时必须给出登录入口');
        assertEqual(env.dom.byId.get('ubi-export-capture').style.display, 'block', '不在抓取页时必须给出去抓取页的入口');
        const logEl = env.dom.byId.get('ubi-export-log');
        assert(logEl.textContent.indexOf('会话只存在登录过的那个域') !== -1, '文案要解释会话按域隔离');
    });

    // 抓取页 + 没会话 → 已经在抓取页了，不该再劝跳转，只劝登录
    await checkAsync('界面 抓取页但未登录：不再劝跳转，改为劝登录', function () {
        const env = makeSandbox({ mountUi: true, store: {}, origin: 'https://zh-cn.ubisoft.com', routes: [] });
        assert(env.dom.byId.get('ubi-export-capture').style.display !== 'block', '已在抓取页时不该再劝跳转');
        const logEl = env.dom.byId.get('ubi-export-log');
        assert(logEl.textContent.indexOf('这一页就是抓取页') !== -1, '文案要点明当前就是抓取页');
    });

    // 点「环境自检」→ 报告整块写进日志，标题在结论之前（防止退回逐行前插）
    await checkAsync('界面 点自检：报告成块写入且顺序正确', async function () {
        const env = makeSandbox({
            mountUi: true,
            store: { PRODloginData: SESSION },
            origin: 'https://zh-cn.ubisoft.com',
            routes: [{ url: '/entitlements', method: 'GET', status: 401, body: { message: 'no' } }]
        });
        const btnDiag = env.dom.byId.get('ubi-export-diag');
        assert(btnDiag, '自检按钮必须存在');
        btnDiag.click();
        await new Promise(function (r) { setTimeout(r, 30); });

        const txt = env.dom.byId.get('ubi-export-log').textContent;
        assert(txt.indexOf('── 环境自检 ──') !== -1, '日志里要有自检标题');
        assert(txt.indexOf('401') !== -1, '日志里要有状态码');
        assert(txt.indexOf('票据') !== -1, '401 时结论要指向票据');
        const headIdx = txt.indexOf('── 环境自检 ──');
        const tailIdx = txt.indexOf('结论：');
        assert(headIdx !== -1 && tailIdx !== -1 && headIdx < tailIdx, '标题必须在结论之前，顺序不能被前插打乱');
        assertEqual(btnDiag.disabled, false, '自检完成后按钮要恢复可用');
    });

    // 导出遇网络层失败 → 自动跑自检，并把结论写进面板
    await checkAsync('界面 导出遇网络层失败：自动跑自检并给出结论', async function () {
        const env = makeSandbox({
            mountUi: true,
            store: { PRODloginData: SESSION },
            origin: 'https://zh-cn.ubisoft.com',
            routes: [{ url: '/entitlements', method: 'GET', networkError: 'Failed to fetch' }]
        });
        const btnRun = env.dom.byId.get('ubi-export-run');
        btnRun.click();
        await new Promise(function (r) { setTimeout(r, 60); });

        const txt = env.dom.byId.get('ubi-export-log').textContent;
        assert(txt.indexOf('✗ 失败') !== -1, '要记录失败');
        assert(txt.indexOf('── 环境自检 ──') !== -1, '网络层失败后要自动跑自检');
        assert(txt.indexOf('根本没发出去') !== -1, '自检结论要指出请求没发出去');
        assertEqual(btnRun.disabled, false, '跑完后开始导出按钮要恢复');
    });
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
(async function main() {
    if (!fs.existsSync(SCRIPT)) {
        console.error('找不到用户脚本：' + SCRIPT);
        process.exit(2);
    }
    testPureFunctions();
    await testRunExport();
    await testEnvCheck();
    await testUi();

    const total = pass + failures.length;
    // 机器可读汇总行：gen_facts / check_docs 靠这两个数字判定，不要改格式。
    console.log('TOTAL=' + total + ' FAIL=' + failures.length);

    if (failures.length) {
        console.error('\n失败 ' + failures.length + ' 项：');
        failures.forEach(function (f) {
            console.error('  ✗ ' + f.name);
            console.error('    ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n    ') : f.err));
        });
        console.error('\n通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
        process.exit(1);
    }
    console.log('全部通过：' + pass + ' 项');
    process.exit(0);
}());
