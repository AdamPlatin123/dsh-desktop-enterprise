# DSH Desktop Enterprise — Fork 升级 SOP

本文件是 `dsh-enterprise` 分支相对上游 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 的升级标准作业程序（SOP）。企业改造以"少量侵入 + 集中插件"方式叠加在上游之上，每次跟进上游都必须按本流程执行，先留痕、再验证、后提交。

配套脚本：`scripts/sync-upstream.sh`（默认 dry-run 检查，见第 5 节）。

## 1. 上游 pin 记录

| 项 | 值 | 落盘位置 |
| --- | --- | --- |
| 上游基线 commit | `e71a9ef`（fork 起点，分支基线） | 本文件 + fork 起点 merge-base |
| deepseek-harness 子模块 | `cd5ef8148158c3a752a658978873241fdf8e2bbc`（tag `dsh-v0.1.2-alpha.1`） | `deepseek-harness` 子模块指针 + `upstream.json` |
| 运行时物化 | `0.1.2-alpha.1` | `vendor/dsh-runtime/0.1.2-alpha.1/manifest.json`，由 `node scripts/sync-vendored-runtime.mjs --write` 物化，`--check` 校验 |
| 依赖锁定 | `@deepseek-ai/dsh*` 统一锁定到运行时版本 | 根 `package.json` 的 `resolutions` + `yarn.lock` |

**规则：pin 变更（子模块指针 / `upstream.json` / resolutions / vendored runtime）必须是一个独立 commit**，与代码改造 commit 分离，保证"上游跟进"与"企业补丁"在历史上始终可分。

## 2. 企业补丁登记（quilt 式清单）

企业改动 = 新增文件（纯增量，不与上游冲突）+ 少量对上游文件的修改（"侵入点"）。升级前先跑：

```bash
git diff --name-status <上游pin>..HEAD
```

与下表核对，任何"计划外"的修改文件都必须先解释清楚再继续。

### 2.1 根目录与文档（上游允许改动的区域）

| 文件 | 性质 |
| --- | --- |
| `FORK.md`、`docs/fork-sop.md`、`docs/enterprise-self-hosting.md`、`scripts/sync-upstream.sh` | 企业新增 |
| `PRIVACY.md` / `PRIVACY.zh.md` / `PRIVACY.i18n.yaml` | 企业重写（企业部署版隐私政策 + 双语 blob 哈希记录，`node scripts/verify-bilingual-docs.mjs` 校验） |
| `README.md` / `README.zh.md` / `README.en.md` | 修改：品牌外联链接清理（下载站/赞助/Discord 等锚点） |
| `docs/user-guide.md` / `.en`、`docs/faq.md` / `.en`、`dsh-plugin-desktop/README.md` / `.zh` | 修改：更新检查行为描述更正为"预置自建源、默认关闭" |

### 2.2 `dsh-plugin-desktop/src`（企业核心区）

新增模块（纯增量）：`enterprise-gate.ts`、`enterprise-oauth.ts`、`enterprise-loopback-callback.ts`、`enterprise-login-window.ts`、`enterprise-login-coordinator.ts`、`enterprise-login-copy.ts`、`enterprise-token-store.ts`、`enterprise-token-refresher.ts`、`enterprise-llm-tokens.ts`、`enterprise-llm-token-refresher.ts`、`enterprise-identity.ts`、`enterprise-launch-environment.ts`、`enterprise-gateway-preset.ts`、`enterprise-update-preset.ts`、`enterprise-telemetry.ts`、`enterprise-desktop-routes.ts`、`enterprise-cordis-patch.ts`、`native-ui/enterprise-login.html`、`native-ui/enterprise-login/main.ts`、`native-ui/enterprise-login/style.css`、`client/enterprise-session-banner.ts`。

修改的上游文件与侵入点：

| 文件 | 侵入内容（以锚字符串定位，行号为 15.3 收官时点） |
| --- | --- |
| `src/main.ts` | ① 企业模块 import 段（约 154-171 行，锚 `from './enterprise-gate.ts'`）；② `let enterpriseGate` 声明（约 365 行）；③ 企业更新源解析 `const updatePreset = resolveEnterpriseUpdatePreset()`（约 457-460 行）并传入 Electron 运行时构造；④ 全屏可用性探测 `if (enterpriseGate?.showSurface()) return true`（约 542 行）；⑤ 启动环境包装 `const environment = createDesktopEnterpriseLaunchEnvironment(loadLayeredEnv(BIN_NAME, process.cwd()))`（约 593-597 行，**package.spec 启动顺序锚**，见第 4 节）；⑥ LLM 代际令牌链 `resolveEnterpriseGatewayPreset(process.env)` / `EnterpriseLlmTokenRefresher` 建立/拆除（约 921-961 行）；⑦ 企业门构造与 `enterpriseGate.run()` 维护循环（约 966-994 行）；⑧ `desktopEnterprise` provider（`identity`/`sessionValid`/`signout`/`reauth`，约 1169-1173 行） |
| `src/index.ts` | 企业路由注册（`/api/desktop/enterprise/identity`、`/signout`、`/reauth` 三元组）+ `rejectDesktopRequest` 中的 `enterpriseSessionRejection` 企业会话栅栏层 |
| `src/updates.ts` | `apply()` 先解析更新源预置：关闭则不注册托盘/路由/生命周期直接返回；启用时路由在上游拒绝后追加企业会话栅栏 |
| `src/update-checker.ts` / `update-download.ts` / `update-lifecycle.ts` | `endpoint` / `downloadUrls` 可选参数化（上游默认值不变，生产行为由预置显式接线） |
| `src/electron-runtime.ts` | `updateOrigin` 构造参数 → 下载走预置源点的 `downloadUrls`；未预置源点时下载直接抛错（结构性兜底，杜绝回退到公共下载主机） |
| `src/desktop-terminal.ts` | 企业启动环境接入终端会话 |
| `src/client/DesktopSettingsSection.tsx` | 移除三个社区市场 GitHub 锚点链接；企业账号区块 |
| `src/client/desktop-settings-api.ts` / `desktop-settings-locales.ts` / `index.ts` | 企业设置面数据与文案 |
| `tsdown.config.ts` | `enterpriseDefines`（`__DSH_ENTERPRISE_GATEWAY_URL__` / `__DSH_ENTERPRISE_OAUTH_CLIENT_ID__` / `__DSH_ENTERPRISE_UPDATE_URL__` 构建期注入） |
| `vite.native-ui.config.ts` | 企业登录窗原生 UI 构建入口 |
| `scripts/verify-profile-boot.mjs` | profile 冒烟断言反转：无预置更新源时**不得**注册更新托盘项（企业默认外联归零的装配级断言） |

### 2.3 `dsh-plugin-desktop/tests`

新增：`tests/enterprise-*.spec.ts` 全系（gate/oauth/loopback/login-window/login-coordinator/token-store/token-refresher/llm-tokens/llm-token-refresher/identity/launch-environment/gateway-preset/update-preset/telemetry/desktop-routes/cordis-patch）、`tests/client-enterprise-identity.spec.ts`。
修改：`package.spec.ts`（启动顺序锚断言）、`plugin.spec.ts`（企业路由 + 会话栅栏 + surface 桩）、`desktop-terminal.spec.ts`、`update-checker.spec.ts`、`update-download.spec.ts`、`updates.spec.ts`（更新源预置 harness 与关闭态断言）、`electron-runtime.spec.ts`（更新下载用例预置源点 + download 模块 mock 补 `desktopUpdateDownloadUrlsForOrigin`）。

## 3. 升级流程（每次跟进上游）

1. **留痕**：新建 pin commit 前置分支；记录目标上游 commit 与目标子模块 commit 到本文件第 1 节（先改文档，再动手）。
2. **更新子模块**：`git -C deepseek-harness fetch --tags && git -C deepseek-harness checkout <目标tag或commit>`，随后根目录 `git add deepseek-harness`。
3. **更新 `upstream.json`**：改写 `commit` / `sourceVersion` / `runtimePackageVersion`，保持 `runtimeSource` 指向新版本的 vendored manifest。
4. **物化 vendored runtime**：`node scripts/sync-vendored-runtime.mjs --write`（根 `package.json` 的 resolutions 由同一脚本重写到新版本），随后 `corepack install && corepack yarn install` 刷新 `yarn.lock`。
5. **补丁登记核对**：跑第 2 节开头的 `git diff --name-status`，逐文件与本清单比对；对每个"修改的上游文件"重放侵入点（锚字符串见 2.2），确认上游改动没有吃掉企业逻辑。
6. **回归验证**（全绿才算完成）：
   - R6 环境热更新回归：`cd dsh-plugin-desktop && corepack yarn vitest run tests/enterprise-launch-environment.spec.ts`（覆盖 `DSH_ENTERPRISE_GATEWAY_URL` / `DSH_ENTERPRISE_API_KEY_ENV` 对 baseURL 与 API key 的逐请求/逐调用热生效）；
   - 插件全量：`cd dsh-plugin-desktop && corepack yarn check`（build + typecheck + test + verify）；
   - 根全量：`corepack yarn check`（布局/双语/架构门/vendored runtime + 各 workspace）。
7. **提交**：pin 变更单独 commit（第 1 节规则），企业补丁重放如有修复另行 commit；**禁止 push**。

### 3.1 rebase 注意事项（已知脆弱点）

- **启动顺序锚**：`dsh-plugin-desktop/tests/package.spec.ts` 以源码字符串锚断言 `main.ts` 的启动顺序，关键是 `const environment = createDesktopEnterpriseLaunchEnvironment(loadLayeredEnv` （约 352 行附近断言，源点在 `main.ts` 约 597 行）。上游若重排 `main.ts` 启动序列（环境构造、窗口创建、门运行的相对顺序），此处会红——先改锚，不改语义。
- **路由清单断言**：`tests/plugin.spec.ts` 断言企业路由三元组的注册形状；`updates.spec.ts` 断言"更新源关闭 = 不注册托盘/路由"。上游给设置页/托盘新增路由时，核对这两个断言是否需要扩列。
- **main.ts 侵入点密集**（2.2 表 ⑦⑧ 段落嵌在上游启动流程中），rebase 冲突优先保上游结构、重放企业块，禁止整段覆盖。
- 更新链（`update-checker` / `update-download` / `updates`）上游演进时，保持 `endpoint` / `downloadUrls` 参数可选且默认值不变——企业预置在生产路径显式接线，上游默认路径必须保持原样，否则外联归零断言会失效。

## 4. 回滚

- **pin commit 回滚**：`git revert` 该 pin commit（子模块指针、`upstream.json`、resolutions、vendored manifest 一并还原），重跑 `node scripts/sync-vendored-runtime.mjs --write && corepack yarn install` 与第 3.6 步全部回归。
- **企业补丁重放修复回滚**：只 revert 对应修复 commit，pin 不动。
- 升级分支在验证全绿前不得合入 `dsh-enterprise`；验证失败且短期无法修复时，直接废弃升级分支，`dsh-enterprise` 原地不动。

## 5. 安全停留（何时**不**升级）

满足任一条件即暂停升级，升级决策升级到人工评审：

- 上游引入新的默认外联（遥测、崩溃上报、第三方账号、云同步类改动）——需先做外联清点再决定；
- 上游改动更新链验签/下载方式——与 T17 验签对接对齐后统一处理；
- 上游重排 `main.ts` 启动序列且无法用锚字符串等价表达；
- `corepack yarn check` 或企业测试系存在未解释的红。

## 6. `scripts/sync-upstream.sh` 用法

```bash
scripts/sync-upstream.sh            # 默认 dry-run：校验 pin 一致性，不改任何文件
scripts/sync-upstream.sh --check    # 同上（显式）
```

检查项：子模块指针与 `upstream.json` 一致、vendored runtime `--check` 通过、resolutions 锁定与运行时版本一致、第 2 节企业文件全部在位、`main.ts` 关键锚字符串在位。`--apply` 等真实升级动作**有意不提供**：升级必须按第 3 节人工逐步执行并留痕。
