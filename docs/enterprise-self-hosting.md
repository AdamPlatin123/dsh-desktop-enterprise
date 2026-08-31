# DSH Desktop 企业版自托管与外联配置

本文面向企业部署管理员，说明本 fork（DSH Enterprise 桌面客户端）的全部对外网络触点及其默认状态。设计目标：**企业内网部署默认外联归零**——除贵组织自己的网关外，客户端不与任何第三方服务通信。

## 1. 更新源（默认关闭）

### 1.1 行为

- 打包时通过构建环境变量 `DSH_ENTERPRISE_UPDATE_URL` 预置自建更新源**源点（origin）**；未设置（空字符串，默认）时，更新检查**完全关闭**：不注册托盘"检查更新"命令、不注册设置页更新路由、不发起任何后台轮询或下载。
- 预置值非法（非绝对 URL、非 http/https、内嵌凭据、带查询/片段/路径）时同样按关闭处理，并在日志中给出原因；预置值命名为上游公共更新域名（`dshdesktop.cn` 及其任意子域，大小写不敏感）时会被以专门理由**直接拒绝**；**不存在**回退到上游公共端点的路径。
- 开发与无打包测试可通过同名运行时环境变量 `DSH_ENTERPRISE_UPDATE_URL` 覆盖构建预置。

### 1.2 预置后的请求面

配置了源点 `https://updates.corp.example` 后，客户端只会访问：

| 用途 | 方法与路径 | 携带内容 |
| --- | --- | --- |
| 版本检查（后台 60s 后首次，之后每 6 小时；托盘/设置页手动检查共用） | `GET {origin}/api/desktop/version` | 头 `X-DSH-Desktop-Version: <当前版本>`（严格稳定 SemVer）、`X-DSH-Desktop-Installation-Id: <本机随机 UUID v4>`、`Accept: application/json`；no-cache、禁止重定向 |
| 安装包下载（用户逐次确认后） | `GET {origin}/api/downloads/mac`、`GET {origin}/api/downloads/windows` | 普通请求元数据；不携带上述身份头 |

### 1.3 版本元数据格式（T17 验签对接的对接面）

版本响应即上游既有契约，未做扩展：

- HTTP 200，响应体 ≤ 4 KiB（超出即拒绝），`Content-Type: application/json`；
- 请求头 X-DSH-Desktop-Version 必须存在且为规范稳定 SemVer；响应体为 `{"version": "<稳定 SemVer>"}`——`version` 必须是不带 `v` 前缀、无预发布段的规范稳定版本字符串（如 `2.10.0`）。只有严格更新于本机版本时才提示；
- **T17 预留**：升级链验签（签名元数据字段与验签算法）由治理服务端任务 T17 定稿后并入本节；当前客户端不解析、不要求任何签名字段。

## 2. 社区市场源（默认禁用）

- Desktop Market 提供器默认状态为 `disabled`（机器级状态文件 `desktop-market/state.json`，缺省即禁用）：不安装、不加载、不访问任何市场服务。
- 用户显式切换提供器后才会产生外联：
  - `community-market`（本仓库捆绑的 `dsh-community-market`）：目录源来自用户配置的 catalog URL（含 GitHub raw 地址的默认目录），插件安装走 `registry.npmjs.org`（`pnpm add` 精确包名）；
  - `dsh-market`（`dshmarket` npm 包）：同走公共 npm registry。
- **接入私有源的路径**：将上游 npm 源指向贵组织制品库（`npm config registry` / `.npmrc`），并在目录配置中填写内网 catalog 地址；或维持提供器禁用、仅通过内部渠道分发插件。设置页中的三个社区市场链接（GitHub 仓库锚点）仅为浏览器跳转锚点，客户端自身不会请求它们。

## 3. 最小隐私遥测（默认关闭，端点 T17）

- 客户端上报模块已就绪（`enterprise-telemetry`），但当前**没有任何调用点**：应用默认遥测关闭，零外联。
- 上报目标固定为**企业网关预置地址**（`DSH_ENTERPRISE_GATEWAY_URL`，与登录同源）：`POST {gateway}/api/desktop/telemetry`。服务端端点由治理服务端任务 T17 交付；在 T17 交付并显式接线之前，该模块保持休眠。
- 载荷仅含三项统计面 + 安装标识：
  - `clientVersion`：客户端版本字符串；
  - `online`：客户端到网关的在线状态布尔值；
  - `errorCounts`：有界错误分类计数（键为 `[A-Za-z0-9._-]`，最多 32 类，每类饱和计数）；
  - `installationId`：本机安装 UUID（仅遥测启用时随载荷交予网关）；`sentAt`：上报时间。
- 上游会话遥测（`DSH_TELEMETRY_MODE`）在本客户端默认组合中保持禁用，与本模块互不相干。

## 4. 安装 UUID

- 本机生成、持久于 `<userData>/identity/installation-id` 的随机 UUID v4（0600/0700 权限），非硬件标识。
- 企业默认形态下更新检查关闭，该标识**不出网**。仅当管理员预置了自建更新源（发给贵组织源点）或启用遥测（发给贵组织网关）时才会传出；任何情况下都不会发往上游公共端点。

## 5. 其余网络行为（依赖物化与包操作，按需发生）

- **Electron 头文件与包管理外联**：当 profile 依赖需要在启动时物化，或用户执行 pnpm/终端包操作时，内置包管理器可能访问 npm registry、依赖承载方，以及经 `npm_config_disturl` 固定的 Electron Node 头文件服务 `https://electronjs.org/headers`（该地址当前为代码内硬编码，分布于 `profile-materializer.ts`、`pnpm.ts`、`desktop-runtime-environment.ts`、`desktop-terminal.ts`、`recovery-plugin-uninstall.ts`）。这是**打包应用运行路径上的按需外联**，未发生物化/包操作时不访问。
- **内网镜像配置**：Electron 二进制下载遵循标准 `ELECTRON_MIRROR` 环境变量（@electron/get 语义），物化与包操作子进程继承部署方环境——在启动客户端前预设 `ELECTRON_MIRROR=https://mirror.corp.example/electron`（及可选 `ELECTRON_CUSTOM_DIR`）即可把二进制下载引到内网镜像。`npm_config_disturl` 无对应环境覆盖；若内网完全阻断 `electronjs.org/headers` 且 profile 含原生依赖，物化会失败——此属 fork 级改造点，升级决策见 `docs/fork-sop.md` 安全停留节。
- 模型与工具流量全部经企业网关（登录、令牌刷新、身份读取、LLM 代际令牌与对话出口），见隐私政策。
