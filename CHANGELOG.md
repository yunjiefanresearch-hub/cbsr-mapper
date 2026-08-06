# 变更记录

## 0.11.1 — 演示模式与离线构建（register 数据版本 0.10.1 未改动）

`DATA` 与 `COMPUTE` 两个数据块**逐字节未动**。本次只加开关、不改结论。

### 一、`DEMO_MODE`：去掉病因，而不是藏起病症

0.11.0 把「未配置模型代理」的诊断做对了：黄色横幅、代理输入框、分门别类的错误文案。
诊断正确，但在向外演示时，这些恰恰是最不该出现在屏幕上的东西——它们是给自托管者看的运维信息。

`DEMO_MODE`（默认开启，`window.__CBSR_DEMO__ = false` 可关闭）不拦截失败的调用，而是**不发起**它：

- **路由**改为确定性关键词规则，写入的是与手动勾选框完全相同的六个业务特征标志位。
  下游的维度推导、分层、记录检索、可引用子集全部沿用原有确定性代码，一行未改。
  复述文案里明确写明「由关键词规则确定性提取，不是模型推断」，手动勾选框保留为修正入口。
- **问题生成**改为从每条记录自身的字段拼装（authority / pinpoint / source_primary /
  tension / resolution_channel / binding_status），因此每一个问题都指向登记册确实持有的内容。
  来源标签相应改为「由本条目的条款 / 张力字段确定性生成 · 非结论」。
- 文档 / 网址导入区块、降级横幅、代理输入框、降级运行按钮均不再渲染；
  `f1` 与 `empty` 两处文案不再提及已隐藏的导入路径。

AI 代码路径一行未删，`AI_AVAILABLE` / `aiRuntimeDown` / `callClaude` / `runFraming` 全部原样保留。

### 二、`npm run build:offline`：单文件、可离线、可双击

新增 `scripts/build-offline.mjs`。用 TypeScript 转译 JSX，并把 `node_modules` 里的
react / react-dom / scheduler / jsx-runtime 的 production CJS 构建打进一个**经典 script**，
输出单个自包含 HTML。

- 依赖全部经 `createRequire` 从项目位置解析，不含任何机器绝对路径；
  React 18 的 `.production.min.js` 与 React 19 的 `.production.js` 两种命名都兼容。
- 输出是经典 script 而非 ES module，因为 module script 在 `file://` 下会被 CORS 直接拦掉，
  而演示包的全部意义就是双击能开。
- 构建期替换两处：Vite 专有的 `import.meta.env`（在经典 script 里是**解析期**硬错误，
  会导致整个脚本不执行），以及样式表开头的 Google Fonts `@import`（离线时挂起后失败）。
  源码两处均保持原样，补偿动作只发生在打包器里。

这不是正式构建。`npm run build`（Vite）仍然是，GitHub Pages 部署的也仍然是它。

### 三、`typescript` 进入 devDependencies

离线构建器需要它做 JSX 转译。Vite 构建路径不受影响。

---

## 0.11.0 — 部署套件修复（register 数据版本 0.10.1 未改动）

本次只改部署套件与 UI 行为。`src/App.jsx` 里的 `DATA` 与 `COMPUTE` 两个数据块**逐字节未动**，
因为它们是引用承载的（BibTeX / CITATION.cff 导出都依赖 `DATA.meta.version`）。

---

### 一、「网络错误,检查连接后重试」——误诊，实为未配置模型代理

**病因链。** `LLM_PROXY = ""`，`index.html` 里的 `window.__CBSR_LLM_PROXY__` 仍是注释状态，
于是 `callClaude` 回落到直接向 `api.anthropic.com` 发跨域 POST。浏览器在 CORS 预检阶段就拒绝，
`fetch` reject，抛 `NETWORK:`，`classifyErr` 映射成「网络错误」。用户被指去检查网络，
而真正要改的是配置。

**改动。**

- `callClaude` 按「是否配置了代理」分流抛出 `NOPROXY:` 或 `PROXYDOWN:`，不再一律 `NETWORK:`。
- `classifyErr` 新增 4 条分支：`NOPROXY` / `PROXYDOWN` / `401·403` / `404`，每条中英文案都
  指名病因并给出具体修法。
- `aiEnvDown` 纳入 `NOPROXY` / `PROXYDOWN`，使降级横幅能正确触发。
- 新增 `normalizeProxyUrl()`：自动去除代理地址末尾斜杠。Worker 对 secret 路径段是精确匹配，
  多一个斜杠会 404 —— 这是最容易被误判为「代理坏了」的坑。
- 代理地址通过 `localStorage` 持久化（带 `try/catch`，沙盒禁用存储时静默降级），粘贴一次即可，
  刷新不丢。清空输入框再点「应用」即可清除。
- 模型串从 `callClaude` 内部提为顶部常量 `AI_MODEL`，并注明：模型串写错返回的是 **HTTP 404**
  而非网络错误，上线前请到 <https://docs.claude.com> 核对账号可用的串。

### 二、「问题未能生成」——失败被静默吞掉

**病因。** `assembleAndFrame` 里批次失败只是把条目丢进 `missed`，重试一轮仍失败就直接结束，
既不 `setError` 也不 `setAiRuntimeDown`。于是用户看到一条孤立的「可重试」，重试多少次都不会成功，
因为根因和上面的红色横幅是同一个。

**改动。**

- 抽出 `runFraming(covered, groundById, L, aud, only)`，记录 `lastErr` 并分类展示。
- 环境级错误（缺代理 / 401 / 403）立即中止批次循环，不再空烧重试配额；未跑到的批次也计入缺失数，
  失败面板不会少报。
- 新增 `retryFraming()`：只重跑仍无问题的条目，已生成的部分和已核验记录不被丢弃。
- 结果区新增失败面板：真实原因 + 「已核验记录、条款出处、可引用标记与全部导出都不依赖模型」
  + 「只重试缺失的问题」按钮。
- 错误以**原始码**存入 state，渲染时才 `classifyErr`，因此中英切换时提示语跟着变。

### 三、时间轴停在 2026-06-30

**病因（两层）。**

1. `SNAPSHOT_DATE` 是模块级 `const`，「今日」显示的是数据快照日而非真实日期；更要紧的是
   `composeCorridorClasses(null)` 会**跳过所有日期转换**——意味着 2027-10-26 打开工具，
   看到的仍是英国制度生效前的世界。
2. `REGISTER_API` 同步只覆盖三条证据轴、`status`、`url`、`version`，**漏了 `meta.as_of`**；
   即使补上，模块级 `const` 在加载时已固化，也读不到。

**改动。**

- `SNAPSHOT_DATE` → `snapshotDate()` 函数（调用时读 `DATA.meta`，同步后能生效）；新增 `todayISO()`
  （按本地日历日，不用 UTC）。
- `composeCorridorClasses(asOf)`：`asOf == null` 现在解析为**真实日期**并应用所有已到期的排定翻转。
  已排定生效日是已公布的事实，到期自行翻转是这个时间引擎本来就该有的行为。
- 时间轴刻度改为按真实日期排序的 marks，含两个锚点：「今日（真实日期）」与「数据快照基线」；
  已过的生效日排在今日左侧并标「已生效」，未到的标「未到」。
- 新增双日期说明条，明确区分：**生效日按真实时钟走，条文内容仍停留在快照日**。不伪装成今天。
- 或有触发（`kr-daba-enacted`、`tw-vas-act-enacted`）仍不自动生效——与 register 的
  「已排定 vs 或有」纪律一致，未改。
- 同步逻辑补上 `DATA.meta.as_of` 与 `record_count`；快照横幅在 live 模式下显示实际快照日与天数。

**已验证行为**（对照快照基线的翻转边数）：

| 日期 | 翻转边数 | 说明 |
| --- | --- | --- |
| 2026-06-30 | 0 | 快照日 |
| 2026-08-05 | 0 | 真实今日，两个生效日都还没到 |
| 2027-01-17 | 0 | GENIUS 外限前一天 |
| 2027-01-18 | 8 | GENIUS 外限当天，8 条入美边翻转 |
| 2027-10-24 | 8 | 英国生效前一天 |
| 2027-10-25 | 16 | 英国生效当天，再 +8 条入英边 |
| 2030-01-01 | 16 | 远期不再多翻 |

### 四、Cloudflare Worker

- 同时去除路径首尾斜杠。
- `GET /<PROXY_SECRET>` 返回 JSON 健康检查（零 token 成本），可在浏览器直接验证 secret 路径与
  密钥绑定是否正确。
- `PROXY_SECRET` / `ANTHROPIC_API_KEY` 缺失时返回可读的 503，而非静默 404。
- 上游 `fetch` 失败包成带 CORS 头的 502；此前抛出的 Worker 异常不带 CORS 头，浏览器只能看到
  不透明的 CORS 错误。
- CORS 允许 `GET`，并补 `access-control-max-age`。

### 五、index.html

- **停用了占位符 Cloudflare Web Analytics beacon。** 它带着未替换的 token 上线，每次页面加载都发
  一个必然失败的请求，在控制台里制造与本应用无关的网络错误噪音——正是让真正的代理故障更难定位的
  原因之一。改为默认注释，填入真实 token 后再启用。
- 代理注入槽的注释改写为完整操作指引（含健康检查与免重建路径）。

### 六、构建不变量

`scripts/check-invariants.mjs` 新增第 5 项：**index.html 不得带着「活的」占位标签上线**
（剥离 HTML 注释后扫描，注释掉的模板是文档化的关闭状态，允许）。已双向验证：正常通过，
故意放一个活的占位 beacon 会失败并阻断构建。

### 七、版本号

`package.json` 0.10.2 → **0.11.0**（部署套件版本）。`DATA.meta.version` 保持 **0.10.1**
（register 快照版本，引用承载）。两者本就是不同的东西，README 已补充说明——不应对齐。

---

## 上线前请自行确认

容器无外网，以下两项无法在此验证：

1. `npm install && npm run build` —— 本次校验为语法级（TypeScript JSX 解析器）+ 不变量级
   + 时间引擎行为级，未做真实 Vite 构建。
2. `AI_MODEL` 当前为 `claude-sonnet-4-6`。请到 <https://docs.claude.com> 核对你账号实际可用的
   模型串；URL 导入路径还用到 `web_search_20250305` 工具，同样需要账号支持。
