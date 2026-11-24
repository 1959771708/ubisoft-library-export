// 构建：把用户脚本落到 dist/，并校验 @version 与 package.json 一致。
//
// 本项目没有转译/打包环节，脚本本身就是产物。这个构建的唯一职责是：
//   1. 拦住 @version 与 package.json 版本漂移（油猴靠 @version 判断是否升级）；
//   2. 产出 dist/ 供文档体检核对；
//   3. 统一换行成 LF（部分安装器对 CRLF 解析有差异）。
//
// 用法：node tools/build.cjs

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'ubisoft-library-export.user.js';
const DIST_DIR = 'dist';
const DIST = path.join(DIST_DIR, SRC);

function fail(message) {
    console.error('BUILD FAILED: ' + message);
    process.exit(1);
}

const started = Date.now();

const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) fail('找不到 package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const srcPath = path.join(ROOT, SRC);
if (!fs.existsSync(srcPath)) fail('找不到 ' + SRC);

const raw = fs.readFileSync(srcPath, 'utf8');
const content = raw.replace(/\r\n/g, '\n');

// 从油猴头部取 @version，不信任任何其它来源。
const versionMatch = content.match(/^\/\/\s*@version\s+(\S+)\s*$/m);
if (!versionMatch) fail('脚本头部缺少 @version');
const scriptVersion = versionMatch[1];
if (scriptVersion !== pkg.version) {
    fail('版本不一致：脚本 @version=' + scriptVersion + '，package.json version=' + pkg.version);
}

// 头部必需字段：缺一个油猴那边就会行为异常，在构建期拦住比装到浏览器里再查便宜。
const REQUIRED_HEADER = ['@name', '@namespace', '@version', '@match', '@grant', '@run-at'];
const headerEnd = content.indexOf('// ==/UserScript==');
if (headerEnd === -1) fail('脚本缺少 // ==/UserScript== 结尾标记');
const header = content.slice(0, headerEnd);
for (const field of REQUIRED_HEADER) {
    if (header.indexOf('// ' + field) === -1) fail('脚本头部缺少 ' + field);
}

fs.mkdirSync(path.join(ROOT, DIST_DIR), { recursive: true });
fs.writeFileSync(path.join(ROOT, DIST), content, 'utf8');

const bytes = Buffer.byteLength(content, 'utf8');
console.log('SUMMARY version=' + scriptVersion + ' bytes=' + bytes + ' built in ' + (Date.now() - started) + 'ms');
console.log('BUILD OK: ' + DIST + ' (' + bytes + ' 字节, v' + scriptVersion + ')');
