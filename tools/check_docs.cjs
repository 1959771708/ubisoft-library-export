/**
 * 文档体检（通用模板）—— 独立重测事实、比对 docs/FACTS.md、抓手写文档的失真与死链。
 *
 * 用法：node tools/check_docs.cjs
 * 退出码 0 = 全部通过；1 = 有问题（收尾与发布前必须修完）。
 *
 * 与 gen_facts.cjs 的分工：
 *   gen_facts  = 采集并写事实清单（会跑构建、查远端，较慢）
 *   check_docs = 独立重测 + 校验文档（不跑构建、不查远端，秒级，可随时跑）
 * **两者刻意不共用测量代码**：同一份实现写错了，共用会一起错，独立重测才能互相抓。
 *
 * 所有项目相关信息都在项目根的 facts.config.json 里，本文件不含任何项目专有值。
 * 接入后务必做一次「故意改错一个数字」的演示，确认它真的会 FAIL —— 恒返回 PASS 的体检脚本比没有更糟。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => !!rel && fs.existsSync(path.join(ROOT, rel));
const size = (rel) => (exists(rel) ? fs.statSync(path.join(ROOT, rel)).size : null);

const CONFIG_PATH = 'facts.config.json';
if (!exists(CONFIG_PATH)) {
  console.error(`缺少 ${CONFIG_PATH}。从技能 project-contract 的 templates/ 复制并按项目填写。`);
  process.exit(1);
}
const cfg = JSON.parse(read(CONFIG_PATH));
const docCfg = cfg.docs || {};
const dig = (obj, dotted) => String(dotted || '').split('.').filter(Boolean)
  .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

// glob 展开：与生成器各写一份，故意不共用。
function expandGlob(pattern) {
  if (!/[*?]/.test(pattern)) return [pattern];
  const segs = pattern.replace(/\\/g, '/').split('/');
  const walkSeg = (dir, i) => {
    if (i >= segs.length) return [dir];
    const seg = segs[i];
    const join = (name) => (dir ? `${dir}/${name}` : name);
    if (seg === '**') {
      const out = walkSeg(dir, i + 1);
      const abs = path.join(ROOT, dir);
      if (fs.existsSync(abs)) {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (e.isDirectory()) out.push(...walkSeg(join(e.name), i));
        }
      }
      return out;
    }
    if (!/[*?]/.test(seg)) return walkSeg(join(seg), i + 1);
    const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (re.test(e.name)) out.push(...walkSeg(join(e.name), i + 1));
    }
    return out;
  };
  const hits = walkSeg('', 0);
  return hits.length ? hits : [pattern];
}

async function loadData(rel, format, exportName) {
  if (format === 'esm' || /\.(mjs|js|cjs)$/i.test(rel)) {
    const mod = await import(pathToFileURL(path.join(ROOT, rel)).href);
    return exportName ? mod[exportName] : (mod.default ?? mod);
  }
  return JSON.parse(read(rel));
}

async function main() {
  // ---------- 独立重测（不复用 gen_facts 的任何函数） ----------
  const pkgFile = cfg.project?.packageJson || 'package.json';
  const pkg = JSON.parse(read(pkgFile));
  const live = {
    version: pkg.version,
    displayName: dig(pkg, cfg.project?.displayNamePath) || pkg.name,
    fields: {},
    collections: {},
    groups: {},
    flags: {},
  };
  for (const field of cfg.project?.fields || []) {
    const value = dig(pkg, field.path);
    live.fields[field.label] = Array.isArray(value) ? value.join(' / ')
      : (value && typeof value === 'object' ? Object.keys(value).join(' / ') : value);
  }
  for (const dep of cfg.project?.dependencies || []) {
    live.fields[dep.label] = dig(pkg, `${dep.section}.${dep.name}`) ?? null;
  }

  const dataCfg = cfg.data || {};
  const sources = Array.isArray(dataCfg.sources) && dataCfg.sources.length
    ? dataCfg.sources
    : (dataCfg.file ? [{ file: dataCfg.file, format: dataCfg.format, collections: dataCfg.collections, primary: dataCfg.primary, flags: dataCfg.flags }] : []);

  let primaryItems = [];
  let primaryDone = false;
  for (const src of sources) {
    if (!src.file) continue;
    if (!exists(src.file)) {
      check(`数据文件存在: ${src.file}`, false, '缺失');
      continue;
    }
    let data;
    try {
      data = await loadData(src.file, src.format, src.export);
    } catch (err) {
      check(`数据文件可解析: ${src.file}`, false, err.message);
      continue;
    }
    for (const col of src.collections || []) {
      const list = dig(data, col.key);
      if (col.as === 'object') {
        live.collections[col.label] = list && typeof list === 'object' ? Object.keys(list).length : null;
        if (live.collections[col.label] == null) check(`数据集合是对象: ${col.key}`, false, src.file);
      } else {
        live.collections[col.label] = Array.isArray(list) ? list.length : null;
        if (!Array.isArray(list)) check(`数据集合是数组: ${col.key}`, false, src.file);
      }
    }
    if (src.primary && !primaryDone) {
      primaryDone = true;
      primaryItems = dig(data, src.primary.collection) || [];
      live.primaryCount = primaryItems.length;
      for (const g of src.primary.groupBy || []) {
        live.groups[g.label] = new Set(primaryItems.map((i) => i[g.field])).size;
      }
      if (src.primary.coords) {
        const { x, y } = src.primary.coords;
        let gap = Infinity;
        for (let i = 0; i < primaryItems.length; i += 1) {
          for (let j = i + 1; j < primaryItems.length; j += 1) {
            const dx = Number(primaryItems[i][x]) - Number(primaryItems[j][x]);
            const dy = Number(primaryItems[i][y]) - Number(primaryItems[j][y]);
            gap = Math.min(gap, Math.sqrt(dx * dx + dy * dy));
          }
        }
        live.minGap = Number.isFinite(gap) ? Number(gap.toFixed(2)) : null;
      }
    }
    for (const flag of src.flags || []) {
      const list = dig(data, flag.collection) || [];
      live.flags[flag.label] = list.filter((i) => i[flag.field]).length;
    }
  }

  function runVerify(v) {
    const opts = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: ROOT };
    if (v.env) opts.env = { ...process.env, ...v.env };
    try {
      if (v.command) {
        const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(v.command);
        const cmdArgs = (v.args || []).flatMap((a) => expandGlob(a));
        const exe = isWinBatch ? process.env.ComSpec || 'cmd.exe' : v.command;
        const finalArgs = isWinBatch
          ? ['/d', '/s', '/c', `"${v.command} ${cmdArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}"`]
          : cmdArgs;
        return execFileSync(exe, finalArgs, { ...opts, windowsVerbatimArguments: isWinBatch });
      }
      return execFileSync(process.execPath, [path.join(ROOT, v.script)], opts);
    } catch (err) {
      return `${err.stdout || ''}${err.stderr || ''}`;
    }
  }
  const verifyLive = (cfg.verify || []).map((v) => {
    const out = runVerify(v);
    const values = {};
    for (const [key, pattern] of Object.entries(v.patterns || {})) {
      const m = out.match(new RegExp(pattern));
      values[key] = m ? (/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]) : null;
    }
    const failKeys = v.failKeys || ['fail'];
    const green = failKeys.every((k) => values[k] === 0)
      && (!v.okPattern || new RegExp(v.okPattern).test(out));
    return { ...v, values, green };
  });

  // ---------- 1. 事实清单存在且与实测一致 ----------
  const factsPath = 'docs/FACTS.md';
  const factsJsonPath = `${cfg.snapshotDir || '.scratch'}/facts.json`;
  check('事实清单已生成', exists(factsPath), factsPath);
  check('事实快照已生成', exists(factsJsonPath), `${factsJsonPath}（gen_facts 产出）`);

  const facts = exists(factsPath) ? read(factsPath) : '';
  if (facts) {
    const must = [
      ['本地版本', `\`${live.version}\``],
      ['对外名称', live.displayName],
    ];
    for (const [label, value] of Object.entries(live.fields)) must.push([label, `| ${label} | ${value ?? '—'} |`]);
    for (const [label, count] of Object.entries(live.collections)) must.push([`${label}数`, `| ${label} | ${count} |`]);
    for (const [label, count] of Object.entries(live.groups)) must.push([`${label}种类`, `| ${label}种类 | ${count} |`]);
    for (const [label, count] of Object.entries(live.flags)) must.push([label, `- ${label}：${count}`]);
    if (live.minGap != null) must.push(['最小间距', `**${live.minGap}**`]);
    for (const v of verifyLive) {
      const token = Object.entries(v.values).map(([k, n]) => `${k.toUpperCase()}=**${n}**`).join(' ');
      must.push([`${v.label || v.script} 读数`, token]);
    }
    for (const [label, token] of must) {
      check(`FACTS ${label} 与实测一致`, token != null && facts.includes(token), `期望包含 ${token}`);
    }
    check('FACTS 标注机器生成', facts.includes('机器生成') && facts.includes('请勿手改'));
    check('FACTS 声明唯一来源', facts.includes('唯一来源'));
    check('FACTS 无采集异常', facts.includes('无。所有事实均当场实测成功。'), '有异常先修采集');
  }

  // ---------- 2. 校验脚本当前必须全绿 ----------
  for (const v of verifyLive) {
    const detail = Object.entries(v.values).map(([k, n]) => `${k.toUpperCase()}=${n}`).join(' ');
    check(`${v.label || v.script || v.command} 全绿`, v.green, detail);
  }

  // ---------- 3. 产物与素材：FACTS 记录必须与磁盘一致 ----------
  function walk(rel, acc = []) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return acc;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child, acc);
      else acc.push(child);
    }
    return acc;
  }
  const distDir = cfg.build?.distDir || 'dist';
  const distFiles = walk(distDir).sort();
  check(`${distDir} 已构建`, distFiles.length > 0, `先跑构建或 node tools/gen_facts.cjs`);
  if (distFiles.length && facts) {
    // gen_facts 会用 build.fileListCap 只逐个列出体积最大的若干个文件，其余按目录汇总，
    // 总数与总量写在合计行。因此这里不再要求「每个文件都出现」，改为分层核对：
    //   有合计行 → 合计的文件数/字节必须等于磁盘实测；逐个列出的行仍要字节一致；
    //   目录汇总行加起来 + 逐个列出的行 必须等于合计；未被任何行覆盖的文件即为缺口。
    //   无合计行（小项目，文件少）→ 退回「每个文件都必须逐个列出」。
    const totalRow = facts.match(/\| \*\*合计 (\d+) 个文件\*\* \| \*\*(\d+)\*\* \|/);
    const listed = [...facts.matchAll(/\| `([^`]+)` \| (\d+) \|/g)]
      .filter(([, f]) => f.startsWith(`${distDir}/`))
      .map(([, f, bytes]) => ({ path: f, bytes: Number(bytes) }));
    const listedSet = new Set(listed.map((f) => f.path));
    const stale = listed.filter((f) => size(f.path) !== f.bytes);
    check('FACTS 产物字节与磁盘一致', stale.length === 0, stale.map((f) => f.path).join(', '));

    if (totalRow) {
      const [, nRow, bytesRow] = totalRow;
      const actualBytes = distFiles.reduce((s, f) => s + size(f), 0);
      check('FACTS 产物总数与磁盘一致', Number(nRow) === distFiles.length, `FACTS=${nRow} 磁盘=${distFiles.length}`);
      check('FACTS 产物总量与磁盘一致', Number(bytesRow) === actualBytes, `FACTS=${bytesRow} 磁盘=${actualBytes}`);
      const summary = [...facts.matchAll(/\| `([^`]+)\/` × (\d+) \| (\d+) \|/g)]
        .filter(([, dir]) => dir === distDir || dir.startsWith(`${distDir}/`))
        .map(([, dir, n, bytes]) => ({ dir, n: Number(n), bytes: Number(bytes) }));
      for (const s of summary) {
        // 汇总行按「目录的直接子文件」统计：`dist/` 只算 dist 根下那些没被逐个列出的文件，
        // `dist/covers/` 才算 covers 里的。所以这里用 dirname 精确对齐，不用前缀。
        const dirNorm = s.dir === distDir ? distDir : s.dir;
        const under = distFiles.filter((f) => (path.posix.dirname(f) || '.') === dirNorm && !listedSet.has(f));
        const underBytes = under.reduce((a, f) => a + size(f), 0);
        check(
          `FACTS 目录汇总 ${s.dir}/ 与磁盘一致`,
          under.length === s.n && underBytes === s.bytes,
          `FACTS=${s.n} 个/${s.bytes} 字节 磁盘=${under.length} 个/${underBytes} 字节`,
        );
      }
      const covered = new Set(listedSet);
      const coveredDirs = new Set(summary.map((x) => (x.dir === distDir ? distDir : x.dir)));
      for (const f of distFiles) {
        if (!covered.has(f) && coveredDirs.has(path.posix.dirname(f) || '.')) covered.add(f);
      }
      const missing = distFiles.filter((f) => !covered.has(f));
      check('FACTS 覆盖全部产物', missing.length === 0, `未被任何行覆盖：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` …共 ${missing.length} 个` : ''}`);
    } else {
      const missing = distFiles.filter((f) => !listedSet.has(f));
      check('FACTS 覆盖全部产物', missing.length === 0, missing.join(', '));
    }
    const manifestRel = cfg.build?.manifest;
    if (manifestRel && exists(manifestRel)) {
      const manifest = JSON.parse(read(manifestRel));
      const mv = dig(manifest, cfg.build?.manifestVersionKey || 'version');
      check('产物版本与 package 一致', mv === pkg.version, `manifest=${mv} package=${pkg.version}`);
    }
  }

  // 素材尺寸：独立实现，PNG/WebP/JPEG 三种都支持
  function measureImage(rel) {
    if (!exists(rel)) return null;
    const buf = fs.readFileSync(path.join(ROOT, rel));
    if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
    }
    if (buf.length > 30 && buf.toString('ascii', 8, 12) === 'WEBP') {
      const cc = buf.toString('ascii', 12, 16);
      if (cc === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1, bytes: buf.length };
      if (cc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, bytes: buf.length };
      if (cc === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, bytes: buf.length }; }
      return null;
    }
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < buf.length - 9;) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), bytes: buf.length };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    return null;
  }
  for (const a of cfg.assets || []) {
    const rel = a.pathFrom ? dig(pkg, a.pathFrom) : a.path;
    for (const one of (Array.isArray(rel) ? rel : [rel])) {
      // 路径写错时尺寸会是「缺失」，单独判存在性让报错直指路径本身。
      check(`素材文件存在: ${one}`, exists(one), `${a.label}（${one}）`);
      const info = measureImage(one);
      if (a.expect) {
        check(`${a.label} 尺寸为 ${a.expect[0]}×${a.expect[1]}`,
          info && info.w === a.expect[0] && info.h === a.expect[1],
          `${one} ${info ? `${info.w}×${info.h}` : '缺失或格式不支持'}`);
      }
      if (facts && info) {
        check(`FACTS ${a.label} 尺寸与实测一致`, facts.includes(`${info.w}×${info.h}`), `${info.w}×${info.h}`);
        check(`FACTS ${a.label} 字节与磁盘一致`, facts.includes(`| ${info.bytes} |`), `${info.bytes}`);
      }
    }
  }
  for (const rule of docCfg.assetRules || []) {
    const rels = rule.pathsFrom.map((p) => dig(pkg, p)).filter(Boolean);
    if (rule.distinct) check(rule.label, new Set(rels).size === rels.length, rels.join(' / '));
    if (rule.notMatch) {
      const re = new RegExp(rule.notMatch);
      check(`${rule.label}（命名）`, !rels.some((r) => re.test(r)), rels.join(' / '));
    }
  }

  // ---------- 4. 手写文档：不得抄写实测数字、不得留废弃说法 ----------
  const HANDWRITTEN = docCfg.handwritten || ['README.md'];
  const LEGACY = (docCfg.legacy || []).map((r) => [r.label, new RegExp(r.pattern, r.flags || '')]);
  const COPIED = (docCfg.copied || []).map((r) => [r.label, new RegExp(r.pattern, r.flags || '')]);
  const SPEC_OK = docCfg.specOk || {};

  // 烧进素材/对外文案的数字必须与实测一致：像素与平台展示不会随数据自动更新，
  // 所以做正向校验（不是放行），不一致就要求重新合成素材或改文案。
  const bakedHits = {};
  for (const baked of docCfg.bakedNumbers || []) {
    const text = baked.file ? (exists(baked.file) ? read(baked.file) : '') : String(dig(pkg, baked.packageField) || '');
    const found = [...text.matchAll(new RegExp(baked.pattern, 'g'))].map((m) => Number(m[1]));
    if (!found.length) continue;
    bakedHits[baked.label] = found;
    const expect = baked.expectKey === 'primary' ? live.primaryCount : dig(live, baked.expectKey);
    const bad = found.filter((n) => n !== expect);
    check(`${baked.label} 与实测一致`, bad.length === 0,
      bad.length ? `${baked.file || baked.packageField} 写着 ${bad.join('/')}，实际 ${expect}，需同步更新` : `${found.join('/')} == ${expect}`);
  }

  for (const rel of HANDWRITTEN) {
    if (!exists(rel)) { check(`文档存在: ${rel}`, false, '缺失'); continue; }
    const text = read(rel);
    for (const [label, re] of LEGACY) {
      const m = text.match(re);
      check(`${rel} 无废弃说法「${label}」`, !m, m ? `命中 ${m[0]}` : '');
    }
    for (const [label, re] of COPIED) {
      const allow = SPEC_OK[rel] || [];
      if (allow.includes(label)) continue;
      // 已由正向校验负责的数字（烧进素材/简介）不在此重复判错。
      const bakedLabel = (docCfg.bakedNumbers || []).find((b) => b.coversLabel === label && bakedHits[b.label]);
      if (bakedLabel) continue;
      const m = text.match(re);
      check(`${rel} 未抄写「${label}」`, !m, m ? `命中 ${m[0]}（应引用 docs/FACTS.md）` : '');
    }
  }

  // ---------- 5. 死链与死路径 ----------
  const pathPrefixes = docCfg.pathPrefixes || ['src', 'tools', 'docs', 'public', 'assets', 'dist'];
  const pathRe = new RegExp(`\`((?:${pathPrefixes.join('|')})\\/[A-Za-z0-9_./-]+)\``, 'g');
  for (const rel of HANDWRITTEN) {
    if (!exists(rel)) continue;
    const text = read(rel);
    const base = path.dirname(path.join(ROOT, rel));
    const deadLinks = [...text.matchAll(/\[[^\]]*\]\(([^)#]+?)(?:#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((href) => !/^(https?:|mailto:)/.test(href))
      .filter((href) => !fs.existsSync(path.resolve(base, href)));
    check(`${rel} 无死链`, deadLinks.length === 0, deadLinks.join(', '));

    const deadPaths = [...text.matchAll(pathRe)]
      .map((m) => m[1])
      .filter((p) => !/[*<>]/.test(p))
      .filter((p) => !exists(p));
    check(`${rel} 引用的项目路径都存在`, deadPaths.length === 0, deadPaths.join(', '));
  }

  // ---------- 6. 文档声明与代码实现必须对得上 ----------
  const readme = exists('README.md') ? read('README.md') : '';
  for (const token of docCfg.requireInReadme || ['docs/FACTS.md', 'docs/DOC-CONTRACT.md', '只描述当前状态']) {
    check(`README 含「${token}」`, readme.includes(token));
  }
  for (const a of docCfg.codeAssertions || []) {
    const src = exists(a.file) ? read(a.file) : null;
    if (src == null) { check(`${a.label}（源文件存在）`, false, a.file); continue; }
    if (a.match) check(a.label, new RegExp(a.match).test(src), `${a.file} 应匹配 ${a.match}`);
    if (a.notMatch) check(`${a.label}（反向）`, !new RegExp(a.notMatch).test(src), `${a.file} 不应匹配 ${a.notMatch}`);
    if (a.docIncludes) {
      const docRel = a.doc || 'README.md';
      const docText = exists(docRel) ? read(docRel) : '';
      check(`${a.label}（文档已说明）`, docText.includes(a.docIncludes), `${docRel} 应提到 ${a.docIncludes}`);
    }
  }

  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail += 1;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(`\nDOC_CHECK TOTAL=${results.length} FAIL=${fail}`);
  if (fail) console.log('文档体检未通过：修完再收尾/发布。数字类问题请先跑 node tools/gen_facts.cjs。');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`体检器异常: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
