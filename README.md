# 育碧库存导出

从 **Ubisoft Connect 网页端**导出一份完整的游戏库存清单（JSON），供第三方工具导入或做数据分析。

油猴（Tampermonkey）脚本，装一次就行：打开 `https://connect.ubisoft.com/login?appId=1068ef52-dfd2-4e62-8ac9-37a47e6c0b78` 登录后点右下角按钮，几秒后下载 JSON。

## 一键安装

装好 [Tampermonkey](https://www.tampermonkey.net/)（Edge 商店 ID `iikmkjmpaadaobahmlepeloendndfphd`）之后，点下面这个链接，浏览器会弹出 Tampermonkey 的安装确认页，点「安装」即可：

### 👉 [点此安装 育碧库存导出](https://raw.githubusercontent.com/1959771708/ubisoft-library-export/main/ubisoft-library-export.user.js)

安装完成后脚本会**自动检查并接收更新**，无需手动重新安装。

脚本头部声明了自动更新地址：

```javascript
@updateURL    https://raw.githubusercontent.com/1959771708/ubisoft-library-export/main/ubisoft-library-export.user.js
@downloadURL  https://raw.githubusercontent.com/1959771708/ubisoft-library-export/main/ubisoft-library-export.user.js
```

所以只要仓库里 `ubisoft-library-export.user.js` 的 `@version` 递增并推到 `main` 分支，已安装的用户下次检查时就会自动升级。

---

## 能导出什么

按育碧自己的**权益（entitlement）口径**导出，也就是「这个账号确实拥有的游戏」：

- 你在 Ubisoft Connect 上买过、兑换过、通过 Ubisoft+ 拿到过的 **游戏本体**
- 每款游戏附带：名称、育碧内部 spaceId（稳定主键）、productId、可用平台列表

**不包含**：DLC、试玩版、已过期（下架/退款）的条目、非自己拥有的共享条目。这些在导出时会分别计数，写在 `summary` 里，不是静默丢掉。

为什么不用「玩过的游戏」列表：那个只记录你启动过的游戏，买了没玩的一个都不会出现。

---

## 怎么用

1. 装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）。
2. 点上面的[一键安装](#一键安装)链接；手动安装的话，新建脚本把 [ubisoft-library-export.user.js](ubisoft-library-export.user.js) 整个粘进去保存。
3. 登录育碧账号：打开 <https://connect.ubisoft.com/login?appId=1068ef52-dfd2-4e62-8ac9-37a47e6c0b78> 登录。
4. 登录成功后页面会跳去 `ubisoft.com`（哪个区域取决于你的 IP）。如果面板提示「这一页读不到登录会话」，点面板上的**「前往抓取页面」**，它会在当前标签页跳到抓取页。
5. 页面右下角出现蓝色按钮「育碧库存导出」，点它。
6. 等进度条走完，浏览器自动下载 `ubisoft-library-*.json`。

### 为什么需要「前往抓取页面」

`localStorage` 是**按域隔离**的：在 A 域登录拿到的会话，B 域读不到。育碧登录完成后的落地页由服务端按 IP 决定（用美国代理就落到 `www.ubisoft.com/en-us`），而这些落地页不保证会把会话写进自己域下的 localStorage —— 这就会让脚本读到空，报「没登录」或导出失败。

能稳定读到会话的页面是 <https://zh-cn.ubisoft.com/>：它的服务端 HTML 里直接内联了育碧自己的 overlay 组件 `overlay.ubisoft.com/overlay-connect-integration/widget.js`，由它把票据写进宿主页的 `localStorage`（键 `PRODOverlayConnectLoginData`）；这一页还**没有 CSP**，不会被内容安全策略拦。相比之下 `www.ubisoft.com/en-us` 这类 Next.js 页面的服务端 HTML 里没有这个组件。

所以流程是：**先在 `connect.ubisoft.com` 登录，再回到抓取页导出**。面板发现当前域读不到会话时会自动显示「前往抓取页面」按钮，一键跳过去；那一页如果还是读不到，说明登录本身没成功，按面板提示重新登录。

面板上还有一个**「环境自检」**按钮：它用和真实导出完全相同的通道打一次库存接口，把「请求根本没发出去」「服务端回 401」「链路正常」三种情况进行区分，逐行写进面板日志。手机上开不了控制台，出问题时先点这个。

也可以在任意 `ubisoft.com` 页面直接打开面板 —— 只要那个页面已经登录，脚本就能从站点自己的 localStorage 里读到会话。没登录时面板上有一个「去登录育碧账号（新标签页）」按钮，它在新标签页打开登录页，当前页不会被跳走，登录完关掉那个标签页回来点「开始导出」即可。

脚本直接复用你**已经登录的网页会话**，不需要你输入密码，也不碰你的账号密码。

### 挂了代理 / 在海外也能用

登录页默认的返回地址是 `https://ubisoft.com`，那个域名会按访问者 IP 落到区域站（例如用美国代理就跳 `www.ubisoft.com/en-us`）。落到哪里都不影响使用：脚本覆盖 `ubisoft.com` 及其子域，也覆盖 `ubisoft.com.cn`，在哪个区域站都能跑到；**只要在能读到会话的那一页上导出**（见上一节），代理和地区都不构成障碍。

区域站页面里嵌着育碧自己的 WebAuth 组件，会把登录票据写进站点自己的 localStorage（键名 `PRODOverlayConnectLoginData`）。那张票属于站点自己的 appId，直接拿去调库存接口会被拒（401），脚本会自动换一次票（`POST /v2/profiles/sessions`）再读库——这条路径已在真实浏览器里跑通。

> 早期版本试过用 `nexturl` 参数把登录后的落地页钉回 `connect.ubisoft.com`，实测**只保得住一次跳转**：我们设的 nexturl 自身不再带 nexturl，落地后再登录一次就回落默认值，照样被甩到区域站。所以现在不跟它抢落点，改成用「前往抓取页面」把用户带到确定能读到会话的页面。

### 为什么不能直接打开 `https://connect.ubisoft.com`

那个根路径会 301 到育碧官网营销页，不是登录页。登录页必须带 `appId`，否则前端会把自己导航到 `/error` —— **打开 `/error` 看到错误页是正常的**，它只是这条路走错了，不代表脚本或账号有问题。`connect.ubisoft.com` 这个 SPA 只有 `/login` 这类路由，也不认 `/zh-CN/login` 这种语言前缀（会 404）。

同理**不要给登录地址加 `genomeId`**：实测 `?appId=…&genomeId=…` 会被服务端判为 `invalid:true`，一样跳 `/error`。

### 界面被页面清掉时会自动重挂

`ubisoft.com` 是 Next.js 单页应用，脚本注入时机可能早于页面 hydration，挂上去的按钮会被整棵替换掉。脚本每 1.5 秒检查一次根节点，发现没了就重新挂；已有导出结果也会接回来（下载按钮保持可用）。

### 导出的 JSON 是英文

键名固定英文；游戏标题由接口按 `Ubi-LocaleCode: en-US` 返回（这也是育碧自家网页登录用的做法）；连标题接口失败时的 `titleError` 也只会写英文错误码（`HTTP_500` / `NETWORK_ERROR` / `UNKNOWN`），中文原因只显示在界面日志里，不进 JSON。

英文不是碰巧——育碧是按这个请求头返回译名的。同一张票据、同一个查询，只换 `Ubi-LocaleCode`：`en-US` 得到 `WATCH_DOGS™`，`zh-CN` 得到「看门狗」。脚本的 `authHeaders()` 是唯一的请求头来源，所有出站请求（换票、权益、标题）都走它，不会有哪条路径漏带。

---

## 输出格式

```json
{
  "schemaVersion": 1,
  "source": "ubisoft-ubiconnect-entitlements",
  "generatedAt": "2026-11-24T14:56:50.375Z",
  "account": {
    "userId": "…",
    "nameOnPlatform": "…",
    "email": "…"
  },
  "summary": {
    "gameCount": 0,
    "entitlementCount": 0,
    "ownedGameEntitlementCount": 0,
    "duplicateSpaceIds": 0,
    "excludedNotGame": 0,
    "excludedNotOwned": 0,
    "excludedExpired": 0,
    "unresolvedCount": 0,
    "titleError": null
  },
  "games": [
    {
      "name": "Anno 1800",
      "spaceId": "…",
      "productId": "…",
      "platforms": ["PC"],
      "accessLevel": "owned",
      "availability": "owned",
      "resolved": true
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 格式版本。后续若改结构会递增，消费方按它分支 |
| `summary.gameCount` | 去重后的游戏数，也就是 `games` 数组长度 |
| `summary.entitlementCount` | 接口返回的原始权益条数（去重前） |
| `summary.duplicateSpaceIds` | 同一 spaceId 出现多次的条数（多平台/多次购买会产生） |
| `summary.excluded*` | 各口径被排除的条数，`excludedNotGame` 是 DLC 等、`excludedExpired` 是过期、`excludedNotOwned` 是共享/未拥有 |
| `summary.unresolvedCount` | 拿不到标题的游戏数（标题接口失败时全部落这里，库存本身不受影响） |
| `summary.titleError` | 标题接口的错误信息，成功时为 `null` |
| `games[].spaceId` | 稳定主键，跨次导出不变，适合做去重与增量比对 |
| `games[].platforms` | 该游戏可运行的平台并集 |
| `games[].resolved` | 是否成功取到标题；为 `false` 时 `name` 是 `null` |

`titleError` 非 `null` 不算失败——库存数据完整，只是名称缺失，重新导出通常就好。

---

## 实现要点

**走的是网页会话，不是账号密码。** 育碧网页登录后会把整份会话写进 `localStorage`（键 `PRODloginData`），里面含 `ticket`、`sessionId`、`userId` 等。脚本读这份会话，直接带 `Authorization: ubi_v1 t=<ticket>` 调接口。

**不需要 GM 跨域请求。** 这是和同类 Epic 脚本最大的区别：育碧的 `api-ubiservices.ubi.com` / `public-ubiservices.ubi.com` 对 `https://connect.ubisoft.com` 的 CORS 预检全部放行，所以页面内 `fetch` 就够了，脚本声明 `@grant none`，不申请任何额外权限。

**票过期会自动换。** 网页登录用的 appId 和 API 接受的不一样，直接拿网页 ticket 调接口可能 401。脚本遇 401/403 会先 `POST /v2/profiles/sessions` 换一张票再重试，只重试一次，避免死循环。

**标题接口挂了不影响库存。** 库存和标题是两个接口。标题失败时脚本仍然产出完整库存，只是 `name` 为 `null`、`resolved` 为 `false`，并在 `summary.titleError` 里记下错误。

**标题批量查。** 每 120 个 spaceId 打一次 GraphQL，避免 URL/请求体过大。

---

## 隐私

导出的 JSON 含你的**账号 ID、平台昵称、邮箱**。脚本不上传任何数据，文件只落在你本地。分享或提 issue 前请先删掉 `account` 段。

---

## 开发

```bash
npm run build     # 校验 @version 与 package.json 一致，产出 dist/
npm test          # 自测台：vm 沙箱 + 假 fetch + DOM 桩，覆盖换票/降级/分块/界面
npm run facts     # 重新生成 docs/FACTS.md
npm run check     # 文档体检
```

自测台不依赖浏览器：把用户脚本丢进 Node 的 vm 沙箱，用假的 `localStorage` 和 `fetch` 跑完整导出流程。覆盖的情形包括 401 换票后重试、换票仍失败时报错、标题接口 500 降级、未登录时不发请求、空库、300 条按 120 分块，以及环境自检对「请求没发出去 / 401 / 2xx / 5xx」四种情况的分类结论。

面板那一路也一起测了：自测台用一套最小 DOM 桩把界面真的挂起来，校验「该不该显示登录/前往抓取按钮」「自检报告是否成块写入且顺序正确」「网络层失败后是否自动跑自检」。这类问题导出流程照跑、只在界面上出错，不测就只能靠人眼。

## 文档

本项目文档只描述当前状态，不写历史轮次与演进过程。

- [FACTS.md](docs/FACTS.md)：所有会变的数字（版本、自测项数、产物字节）的唯一来源，机器生成
- [DOC-CONTRACT.md](docs/DOC-CONTRACT.md)：文档规范

## 许可

[CC BY 4.0](LICENSE)
