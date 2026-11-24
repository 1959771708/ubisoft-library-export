/**
 * 事实清单生成器（通用模板）—— 文档里所有「会随代码变化的数字」的唯一来源。
 *
 * 用法：
 *   node tools/gen_facts.cjs             # 实测并写 docs/FACTS.md
 *   node tools/gen_facts.cjs --json      # 只输出 JSON，不写文件
 *   node tools/gen_facts.cjs --no-remote # 跳过远端查询（离线时用）
 *   node tools/gen_facts.cjs --no-build  # 跳过构建（沿用现有 dist）
 *
 * 所有项目相关信息都在项目根的 facts.config.json 里，本文件不含任何项目专有值。
 *
 * 设计原则：
 * 1. 只采集「机器能验证」的事实。设计取舍、踩坑教训手写在 README，不在此列。
 * 2. 每一项都能追到来源，便于人工复核。
 * 3. 采集失败必须显式报错，绝不静默填 0 或沿用旧值 —— 那正是文档失真的根源。
 * 4. 与 check_docs.cjs 刻意不共用测量代码：同一份实现写错会一起错，独立重测才能互相抓。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const JSON_ONLY = args.includes('--json');
const NO_REMOTE = args.includes('--no-remote');
const NO_BUILD = args.includes('--no-build');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => !!rel && fs.existsSync(path.join(ROOT, rel));
const size = (rel) => (exists(rel) ? fs.statSync(path.join(ROOT, rel)).size : null);
const errors = [];

const CONFIG_PATH = 'facts.config.json';
if (!exists(CONFIG_PATH)) {
  console.error(`缺少 ${CONFIG_PATH}。从技能 project-contract 的 templates/ 复制并按项目填写。`);
  process.exit(1);
}
const cfg = JSON.parse(read(CONFIG_PATH));

/** 按点号路径取值，例如 "heybox.name"。 */
const dig = (obj, dotted) => String(dotted || '').split('.').filter(Boolean)
  .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

// 参数里的简单通配展开（支持 * 与 ** 两段），让 verify 能直接写 "tests/**/*.test.js"。
// 自己展开而不交给 shell：Windows 的 cmd 不展开 glob。
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

// Windows 上 npm/npx 是 .cmd 批处理，execFileSync 直接执行会 ENOENT。
// 统一经 cmd.exe 转发；含空格的参数加引号，避免被拆开。
function run(cmd, cmdArgs, label, extraEnv) {
  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const exe = isWinBatch ? process.env.ComSpec || 'cmd.exe' : cmd;
  const finalArgs = isWinBatch
    ? ['/d', '/s', '/c', `"${cmd} ${cmdArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}"`]
    : cmdArgs;
  try {
    return execFileSync(exe, finalArgs, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: isWinBatch, maxBuffer: 32 * 1024 * 1024,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    // 有些 CLI 把警告写 stderr，成功也可能非零退出。有输出就交给调用方解析。
    if (!out.trim()) errors.push(`${label}: 无输出，exit=${err.status} ${err.code || ''}`);
    return out;
  }
}

// 数据文件可以是 JSON，也可以是 .js/.mjs 之类的 ES 模块（按 export 名取默认导出或具名导出）。
async function loadData(rel, format, exportName) {
  if (format === 'esm' || /\.(mjs|js|cjs)$/i.test(rel)) {
    const mod = await import(pathToFileURL(path.join(ROOT, rel)).href);
    const picked = exportName ? mod[exportName] : (mod.default ?? mod);
    return picked;
  }
  return JSON.parse(read(rel));
}

async function main() {
  // ---------- 1. package ----------
  const pkgFile = cfg.project?.packageJson || 'package.json';
  const pkg = JSON.parse(read(pkgFile));
  const displayName = dig(pkg, cfg.project?.displayNamePath) || pkg.name;
  const packageFacts = {
    file: pkgFile,
    name: pkg.name,
    version: pkg.version,
    displayName,
    fields: {},
  };
  for (const field of cfg.project?.fields || []) {
    const value = dig(pkg, field.path);
    packageFacts.fields[field.label] = {
      path: field.path,
      value: Array.isArray(value) ? value.join(' / ') : (value && typeof value === 'object' ? Object.keys(value).join(' / ') : value),
    };
  }
  for (const dep of cfg.project?.dependencies || []) {
    packageFacts.fields[dep.label] = {
      path: `${dep.section}.${dep.name}`,
      value: dig(pkg, `${dep.section}.${dep.name}`) ?? null,
    };
  }

  // ---------- 2. 数据计数 ----------
  // 支持多份数据文件（sources），每份各有自己的集合与主集合。
  const dataCfg = cfg.data || {};
  const sources = Array.isArray(dataCfg.sources) && dataCfg.sources.length
    ? dataCfg.sources
    : (dataCfg.file ? [{ file: dataCfg.file, format: dataCfg.format, collections: dataCfg.collections, primary: dataCfg.primary, flags: dataCfg.flags }] : []);

  const dataFacts = { files: [], collections: {}, groups: {}, flags: {}, geometry: null };
  let primaryItems = [];
  let primaryDone = false;

  for (const src of sources) {
    if (!src.file) continue;
    if (!exists(src.file)) {
      errors.push(`数据文件不存在: ${src.file}`);
      continue;
    }
    let data;
    try {
      data = await loadData(src.file, src.format, src.export);
    } catch (err) {
      errors.push(`数据文件解析失败: ${src.file} → ${err.message}`);
      continue;
    }
    dataFacts.files.push({ file: src.file, format: src.format || (/\.json$/i.test(src.file) ? 'json' : 'esm') });

    for (const col of src.collections || []) {
      const list = dig(data, col.key);
      if (col.as === 'object') {
        if (!list || typeof list !== 'object') { errors.push(`数据集合不是对象: ${col.key}（${src.file}）`); continue; }
        dataFacts.collections[col.label] = { key: col.key, file: src.file, as: 'object', count: Object.keys(list).length };
      } else if (!Array.isArray(list)) {
        errors.push(`数据集合不是数组: ${col.key}（${src.file}）`);
      } else {
        dataFacts.collections[col.label] = { key: col.key, file: src.file, as: 'array', count: list.length };
      }
    }

    // 主集合只认第一个声明了 primary 的来源，避免同名分组互相覆盖。
    if (src.primary && !primaryDone) {
      primaryDone = true;
      const primary = src.primary;
      primaryItems = dig(data, primary.collection) || [];
      dataFacts.primary = { label: primary.label, key: primary.collection, file: src.file, count: primaryItems.length };
      for (const g of primary.groupBy || []) {
        const tally = {};
        for (const item of primaryItems) tally[item[g.field]] = (tally[item[g.field]] || 0) + 1;
        dataFacts.groups[g.label] = { field: g.field, distinct: Object.keys(tally).length, by: tally };
      }
      if (primary.coords) {
        const pts = primaryItems.map((i) => [Number(i[primary.coords.x]), Number(i[primary.coords.y])]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        let minGap = Infinity;
        for (let i = 0; i < pts.length; i += 1) {
          for (let j = i + 1; j < pts.length; j += 1) {
            minGap = Math.min(minGap, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
          }
        }
        dataFacts.geometry = {
          xField: primary.coords.x, yField: primary.coords.y,
          bounds: { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] },
          minGap: Number.isFinite(minGap) ? Number(minGap.toFixed(2)) : null,
          canvas: primary.canvas || null,
        };
        if (!Number.isFinite(minGap)) errors.push('点位坐标缺失或非数值，无法计算最小间距');
      }
    }

    for (const flag of src.flags || []) {
      const list = dig(data, flag.collection) || [];
      dataFacts.flags[flag.label] = {
        of: flag.collection, field: flag.field, file: src.file,
        count: list.filter((i) => i[flag.field]).length,
      };
    }
  }

  // ---------- 3. 校验脚本 ----------
  const verifyFacts = [];
  for (const v of cfg.verify || []) {
    let out;
    if (v.command) {
      const cmdArgs = (v.args || []).flatMap((a) => expandGlob(a));
      out = run(v.command, cmdArgs, v.label || v.command, v.env);
    } else {
      out = run(process.execPath, [path.join(ROOT, v.script)], v.script, v.env);
    }
    const found = {};
    for (const [key, pattern] of Object.entries(v.patterns || {})) {
      const m = out.match(new RegExp(pattern));
      if (!m) errors.push(`${v.label || v.script}: 未能解析 ${key}`);
      found[key] = m ? m[1] : null;
    }
    const failKeys = v.failKeys || ['fail'];
    const ok = failKeys.every((k) => found[k] === '0' || found[k] === 0)
      && (!v.okPattern || new RegExp(v.okPattern).test(out));
    if (!ok) errors.push(`${v.label || v.script}: 未全绿`);
    verifyFacts.push({ script: v.command ? `${v.command} ${(v.args || []).join(' ')}` : v.script, label: v.label || v.script, values: found, ok });
  }

  // ---------- 4. 构建产物 ----------
  const buildCfg = cfg.build || {};
  const buildFacts = { skipped: NO_BUILD, summary: null, files: [], totalBytes: 0, warnings: [] };
  let buildOut = '';
  if (buildCfg.command && !NO_BUILD) {
    buildOut = run(buildCfg.command, buildCfg.args || [], 'build');
    if (buildCfg.summaryPattern) {
      const m = buildOut.match(new RegExp(buildCfg.summaryPattern));
      if (!m) errors.push('build: 未能解析汇总行');
      else buildFacts.summary = m.slice(1);
    }
    buildFacts.warnings = [...new Set((buildOut.match(/\[([A-Z][A-Z0-9_]{6,})\]/g) || []).map((s) => s.slice(1, -1)))];
    for (const w of buildCfg.expectedWarnings || []) {
      if (!buildFacts.warnings.includes(w)) buildFacts.warnings.push(w);
    }
  }
  const distDir = buildCfg.distDir || 'dist';
  // 只累积一个相对路径，不要再叠一层 prefix（叠了会把 dist/a/b.js 拼成 dist/a/a/b.js，字节数全变成 0）。
  function walk(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else buildFacts.files.push({ path: childRel, bytes: size(childRel) });
    }
  }
  if (exists(distDir)) walk(distDir);
  else if (!NO_BUILD) errors.push(`${distDir} 不存在，构建可能失败`);
  buildFacts.files.sort((a, b) => a.path.localeCompare(b.path));
  buildFacts.totalBytes = buildFacts.files.reduce((s, f) => s + f.bytes, 0);
  if (buildCfg.manifest && exists(buildCfg.manifest)) {
    const manifest = JSON.parse(read(buildCfg.manifest));
    buildFacts.manifestVersion = dig(manifest, buildCfg.manifestVersionKey || 'version');
    if (buildFacts.manifestVersion !== pkg.version) {
      errors.push(`产物版本 ${buildFacts.manifestVersion} 与 package ${pkg.version} 不一致`);
    }
  }

  // ---------- 5. 素材尺寸（直接读文件头，不依赖外部库） ----------
  function imageSize(rel) {
    if (!exists(rel)) return null;
    const buf = fs.readFileSync(path.join(ROOT, rel));
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length, format: 'PNG' };
    }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const cc = buf.toString('ascii', 12, 16);
      if (cc === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1, bytes: buf.length, format: 'WebP' };
      if (cc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, bytes: buf.length, format: 'WebP' };
      if (cc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, bytes: buf.length, format: 'WebP' };
      }
      return { error: `unknown WebP chunk ${cc}`, bytes: buf.length };
    }
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < buf.length - 9;) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), bytes: buf.length, format: 'JPEG' };
        }
        i += 2 + len;
      }
      return { error: 'JPEG SOF not found', bytes: buf.length };
    }
    return { error: 'unsupported image format', bytes: buf.length };
  }
  const assetFacts = [];
  for (const a of cfg.assets || []) {
    const rel = a.pathFrom ? dig(pkg, a.pathFrom) : a.path;
    const list = Array.isArray(rel) ? rel : [rel];
    for (const one of list) {
      const info = imageSize(one);
      const expect = a.expect || null;
      const ok = !!info && !info.error && (!expect || (info.w === expect[0] && info.h === expect[1]));
      if (!ok) errors.push(`素材不合规: ${one} ${info ? JSON.stringify(info) : '缺失'}${expect ? `（要求 ${expect[0]}×${expect[1]}）` : ''}`);
      assetFacts.push({ label: a.label, path: one, expect, ok, ...(info || {}) });
    }
  }

  // ---------- 6. 远端版本 ----------
  let remote = null;
  if (cfg.remote && !NO_REMOTE) {
    const raw = run(cfg.remote.command, cfg.remote.args || [], 'remote');
    const line = raw.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    try {
      const parsed = JSON.parse(line);
      const items = dig(parsed, cfg.remote.itemsKey || 'items') || [];
      remote = items.map((v) => {
        const row = {};
        for (const col of cfg.remote.columns || ['version', 'status']) row[col] = v[col];
        return row;
      });
    } catch {
      errors.push('remote: JSON 解析失败（可能未登录或网络不可用）');
    }
  }

  const facts = {
    generatedAt: new Date().toISOString(),
    config: CONFIG_PATH,
    package: packageFacts,
    data: dataFacts,
    verify: verifyFacts,
    build: buildFacts,
    assets: assetFacts,
    remote,
    errors,
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(facts, null, 2));
    process.exit(errors.length ? 1 : 0);
  }

  // ---------- 渲染 Markdown ----------
  const L = [];
  L.push('# 事实清单（机器生成，请勿手改）');
  L.push('');
  L.push(`> 生成时间：${facts.generatedAt}　生成命令：\`node tools/gen_facts.cjs\``);
  L.push('>');
  L.push('> **本文件是文档中所有数字的唯一来源。** README 与 docs/ 的手写部分不得重复抄写这里的数值，');
  L.push('> 只能引用本文件。改代码后重跑生成器，再跑 `node tools/check_docs.cjs` 体检。');
  L.push('> 规范见 [DOC-CONTRACT.md](DOC-CONTRACT.md)。');
  L.push('');
  L.push('## 版本与标识');
  L.push('');
  L.push('| 项 | 值 | 来源 |');
  L.push('| --- | --- | --- |');
  L.push(`| 本地版本 | \`${facts.package.version}\` | ${pkgFile} |`);
  L.push(`| 对外名称 | ${facts.package.displayName} | ${pkgFile}#${cfg.project?.displayNamePath || 'name'} |`);
  for (const [label, f] of Object.entries(facts.package.fields)) {
    L.push(`| ${label} | ${f.value ?? '—'} | ${pkgFile}#${f.path} |`);
  }
  L.push('');
  if (facts.remote) {
    const cols = cfg.remote.columns || ['version', 'status'];
    L.push('### 远端版本线（实测）');
    L.push('');
    L.push(`| ${cols.join(' | ')} |`);
    L.push(`| ${cols.map(() => '---').join(' | ')} |`);
    for (const row of facts.remote) L.push(`| ${cols.map((c) => row[c] ?? '—').join(' | ')} |`);
    L.push('');
  } else {
    L.push('### 远端版本线');
    L.push('');
    L.push('本次生成跳过了远端查询（`--no-remote`、未配置或查询失败）。需要线上状态时重跑生成器。');
    L.push('');
  }
  if (facts.data.files.length) {
    L.push('## 数据规模');
    L.push('');
    for (const f of facts.data.files) L.push(`来源：\`${f.file}\`（${f.format}）`);
    L.push('');
    L.push('| 项 | 数量 |');
    L.push('| --- | --- |');
    for (const [label, c] of Object.entries(facts.data.collections)) L.push(`| ${label} | ${c.count} |`);
    for (const [label, g] of Object.entries(facts.data.groups)) L.push(`| ${label}种类 | ${g.distinct} |`);
    L.push('');
    for (const [label, g] of Object.entries(facts.data.groups)) {
      L.push(`### 按${label}计数`);
      L.push('');
      L.push(`| ${label} | 数量 |`);
      L.push('| --- | --- |');
      for (const [k, v] of Object.entries(g.by)) L.push(`| ${k} | ${v} |`);
      L.push('');
    }
    for (const [label, f] of Object.entries(facts.data.flags)) {
      L.push(`- ${label}：${f.count}（\`${f.of}.${f.field}\` 为真）`);
    }
    if (facts.data.geometry) {
      const g = facts.data.geometry;
      L.push('');
      L.push(`- 坐标范围：${g.xField} ${g.bounds.x[0]}–${g.bounds.x[1]}，${g.yField} ${g.bounds.y[0]}–${g.bounds.y[1]}${g.canvas ? `（画布 ${g.canvas}）` : ''}`);
      L.push(`- 最近邻最小间距：**${g.minGap}**`);
    }
    L.push('');
  }
  L.push('## 校验脚本（本次实测）');
  L.push('');
  L.push('| 脚本 | 结果 |');
  L.push('| --- | --- |');
  for (const v of facts.verify) {
    const pairs = Object.entries(v.values).map(([k, n]) => `${k.toUpperCase()}=**${n}**`).join(' ');
    L.push(`| \`${v.script}\` | ${pairs} |`);
  }
  L.push('');
  L.push('## 构建产物（本次实测）');
  L.push('');
  if (facts.build.summary) L.push(`汇总：${facts.build.summary.join(' / ')}`);
  if (facts.build.manifestVersion) L.push(`产物版本：${facts.build.manifestVersion}`);
  L.push('');
  L.push('| 文件 | 字节 |');
  L.push('| --- | --- |');
  // 产物文件很多时不逐个列（清单会长到几千行、而且全是哈希文件名）。
  // 只列体积最大的若干个，其余按目录汇总；总数与总量始终写在合计行。
  const fileCap = Number(cfg.build.fileListCap ?? 40);
  const sortedFiles = [...facts.build.files].sort((a, b) => b.bytes - a.bytes);
  const listedFiles = sortedFiles.slice(0, fileCap);
  for (const f of listedFiles) L.push(`| \`${f.path}\` | ${f.bytes} |`);
  if (sortedFiles.length > listedFiles.length) {
    const rest = sortedFiles.slice(listedFiles.length);
    const byDir = {};
    for (const f of rest) {
      const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '.';
      const bucket = byDir[dir] || (byDir[dir] = { n: 0, bytes: 0 });
      bucket.n += 1;
      bucket.bytes += f.bytes;
    }
    L.push(`| （其余 ${rest.length} 个文件，按目录汇总） | |`);
    for (const [dir, b] of Object.entries(byDir).sort((a, b2) => b2[1].bytes - b2[1].bytes)) {
      L.push(`| \`${dir}/\` × ${b.n} | ${b.bytes} |`);
    }
  }
  L.push(`| **合计 ${facts.build.files.length} 个文件** | **${facts.build.totalBytes}** |`);
  L.push('');
  L.push(`构建警告：${facts.build.warnings.length ? facts.build.warnings.map((w) => `\`${w}\``).join('、') : '无'}`);
  L.push('');
  L.push('> 产物文件名可能带内容哈希，每次改代码都会变。**不要在别处抄写哈希文件名**，引用时写通配形式。');
  L.push('');
  if (facts.assets.length) {
    L.push('## 发布素材（实测尺寸）');
    L.push('');
    L.push('| 文件 | 尺寸 | 字节 | 规范要求 |');
    L.push('| --- | --- | --- | --- |');
    for (const a of facts.assets) {
      L.push(`| \`${a.path}\` | ${a.w ?? '?'}×${a.h ?? '?'} | ${a.bytes ?? '?'} | ${a.expect ? `${a.expect[0]}×${a.expect[1]}` : '—'} |`);
    }
    L.push('');
  }
  L.push('## 采集异常');
  L.push('');
  if (facts.errors.length) for (const e of facts.errors) L.push(`- ⚠ ${e}`);
  else L.push('无。所有事实均当场实测成功。');
  L.push('');

  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'FACTS.md'), L.join('\n'), 'utf8');
  const snapshotDir = cfg.snapshotDir || '.scratch';
  fs.mkdirSync(path.join(ROOT, snapshotDir), { recursive: true });
  fs.writeFileSync(path.join(ROOT, snapshotDir, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(`FACTS_WRITTEN docs/FACTS.md (${L.length} lines)`);
  console.log(`version=${facts.package.version} verify=${facts.verify.map((v) => `${v.label}:${Object.values(v.values).join('/')}`).join(' ')} dist=${facts.build.files.length}/${facts.build.totalBytes}`);
  if (facts.errors.length) {
    console.log(`ERRORS=${facts.errors.length}`);
    for (const e of facts.errors) console.log('  ! ' + e);
    process.exit(1);
  }
  console.log('ERRORS=0');
}

main().catch((err) => {
  console.error(`生成器异常: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
