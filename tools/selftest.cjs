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
        Blob: function Blob(parts) { this.parts = parts; },
        URL: {
            createObjectURL: function () { return 'blob:fake'; },
            revokeObjectURL: function () {}
        },
        document: {
            // 导出主流程不碰 DOM；这里只满足模块顶层的存在性判断。
            // getElementById 返回真值让 boot() 直接早退，避免在沙箱里真的去挂界面。
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

    return { sandbox, api: sandbox.__ubisoftExport, calls, store };
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
        assert(result.summary.titleError && result.summary.titleError.indexOf('500') !== -1, '记录标题错误');
        assertEqual(result.games[0].spaceId, 'A', '按 spaceId 排序');
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

// ── 主入口 ──────────────────────────────────────────────────────────────────
(async function main() {
    if (!fs.existsSync(SCRIPT)) {
        console.error('找不到用户脚本：' + SCRIPT);
        process.exit(2);
    }
    testPureFunctions();
    await testRunExport();

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
