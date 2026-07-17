<p align="center">
  <img src="wloc.jpg" width="144" />
</p>

# Apple WLOC 定位修改

修改 Apple 网络定位服务 (WiFi/基站) 返回的坐标，实现 iOS 网络定位虚拟定位。打开在线选点页面选位置即可生效，无需手动填经纬度。

---

## 🛠️ 底层原理与架构设计

本项目实现修改 iOS 网络定位（WLOC）的机制非常巧妙。它的核心逻辑由 **本地代理 MITM** 与 **Cloudflare Worker** 两个部分完美协作完成。

### 1. 苹果网络定位 (WLOC) 机制
当 iOS 设备的 GPS 信号不佳（如在室内、高架下）或系统试图通过基站快速定位时，会向苹果定位服务器 `gs-loc.apple.com/clls/wloc` 发送定位请求。
* **数据格式**：该请求和响应均使用 Google Protobuf 二进制序列化协议。
* **请求内容**：包含设备探测到的周围 Wi-Fi 路由器的 MAC 地址、蜂窝基站 ID 等信息。
* **响应内容**：苹果服务器计算出的地理坐标（经纬度、精度范围），以经过 **Gzip 压缩** 的 Protobuf 格式返回。

### 2. 代理中间人 (MITM) 解密与二进制篡改
当代理工具（如 Surge、Quantumult X 等）启用了 `gs-loc.apple.com` 的 MITM 解密并加载本模块后：
1. **脚本捕获**：设备发起的 `clls/wloc` 请求在收到响应时会被 `wloc.js` 脚本拦截。
2. **解压数据**：脚本使用内存中的 `pako` 库将响应体的 Gzip 数据解压为原始二进制 Protobuf 流。
3. **精密 Patch**：
   - 脚本并不会反序列化整个 Protobuf 结构，而是通过一个专用的二进制扫描器寻找包含基站纬度（Latitude）和经度（Longitude）的数据字段。
   - 在 WLOC 的数据结构中，坐标值是以 $10^8$ 倍的缩放值作为 Varint（可变长整型）存储的。
   - 脚本直接用我们在本地保存好的虚拟坐标，替换二进制流中所有的坐标数据，并动态修正字段长度。
4. **回放篡改响应**：最后将篡改好的二进制流交付给 iOS 系统的定位守护进程（`locationd`），从而使系统和所有 App 误以为设备正处在这个修改后的虚拟位置。

### 3. Cloudflare Worker 的精妙设计（无状态/零存储）
在这个项目中，自建的 Cloudflare Worker 扮演了两个不可或缺的角色：

#### A. 零存储的“本地化”选点控制台
* 传统的定位修改需要云端数据库或第三方服务来存储用户选定的经纬度。
* 本项目将 Worker 作为一个纯静态的 HTML 地图选点页面。当您在网页（`https://您的worker/`）上选好点并点击 **“储存到设备”** 时，页面会向 `/wloc-settings/save?lon=xxx&lat=xxx` 发起请求。
* **本地拦截**：由于您的代理工具对该域名启用了 MITM 拦截，此请求在发出手机前就会被 `wloc-settings.js` 脚本捕获。
* **数据本地落盘**：脚本将坐标参数直接存入您代理工具的本地持久化存储（`$persistentStore` 或 `$prefs`）中，**整个过程没有任何数据流向云端**，实现了绝对的个人隐私保护与零服务器存储开销。

#### B. 快捷指令的“智能中转与火星坐标偏转 API”
当您使用 iOS 快捷指令（直接分享地图卡片一键设置定位）时：
* 快捷指令在本地难以解析如高德地图分享出来的 `amap.com/xxx` 短链接。
* 快捷指令需要将链接发送到 Worker 的 `/api/parse` 接口。
* **短链追踪**：Worker 自动追踪 302 重定向并提取出真实的地图长链接和坐标信息。
* **火星坐标系（GCJ-02）逆偏转换算**：国内的苹果地图、高德地图使用的都是 GCJ-02 偏移坐标，而苹果 WLOC 机制底层需要标准的 WGS-84（地球坐标系）坐标。直接使用会导致数百米的偏差。Worker 会自动进行高精度的 GCJ-02 -> WGS-84 数学纠偏，将标准坐标返回给快捷指令，确保定位准确无误。

### 4. 本地代理脚本 (dist/) 逆向架构与代码审计
由于 iOS 代理软件（Surge 等）在本地执行 JS 脚本时对文件大小和运行效率有极高的要求，且部分依赖模块（如 `pako` 解压库）体积较大，原项目作者在发布时对 `dist/` 下的脚本进行了 **Minify 打包与代码混淆**。

为了确保代码的安全性与透明度，在此为您提供对 `dist/wloc.js` 与 `dist/wloc-settings.js` 混淆代码的逆向工程结构分析：

#### 📦 A. `dist/wloc.js` — WLOC 数据劫持与 Patch 脚本
该脚本大小约 40KB，负责在网络层拦截、解密、Patch 并重打包定位数据。核心模块构成如下：
1. **统一运行环境桥接库 (Platform Adapter)**：开头部分通过 `switch(true)` 判断 `globalThis.$task` (Quantumult X), `globalThis.$loon` (Loon), `globalThis.$rocket` (Shadowrocket) 等环境，封装了跨平台的本地日志器 `class t (Logger)` 和本地落盘类 `class o (Storage)`，使其能读写本地配置数据。
2. **轻量级 Protobuf 扫描器 (Varint/Protobuf Scanner)**：集成了 `Ae` (Varint解码), `$e` (Varint编码), `Re` (数据段解析) 等核心算法。因为没有苹果 WLOC 响应体的完整 Protobuf 格式定义，脚本通过查找特定的 Wire Type 和 Field Number，递归解析出 Wi-Fi 设备定位列表（Field 2）和基站定位列表（Field 5）。
3. **高精度坐标 Patch 算法 (Coordinate Injector)**：包含 `Oe` 算法。定位到 Wi-Fi 和基站的经纬度数据字段后，读取用户预设的经纬度，并将其乘以 $10^8$ 倍率换算为整数并重写 Varint 字段，更新整个 Protobuf 的长度。
4. **Pako 解压缩库 (Gzip Deflate/Inflate)**：由于苹果返回的 WLOC 定位报文均经过 Gzip 压缩，脚本中完整集成了 `pako.inflate` 字节流解压算法。脚本对响应体执行 `ungzip ➔ patch protobuf ➔ gzip ➔ 返回设备` 的闭环操作。

#### 📦 B. `dist/wloc-settings.js` — 设备端本地存储控制脚本
该脚本大小约 12KB，负责管理本地持久化存储（`wloc_settings` 键值）。核心模块构成如下：
1. **环境适配器与 HTTP 拦截器**：截获发往 `/wloc-settings/save` 的 HTTP 请求。
2. **命令路由选择器**：
   - **`action=save`** (默认)：从 URL query 参数中解析出 `lon`/`longitude`、`lat`/`latitude`、`acc`/`accuracy`（精度），封装为 JSON 对象存入本地 `wloc_settings`。
   - **`action=query`**：读取并以 JSON 格式返回当前设备中生效的虚拟经纬度信息，供前端 Leaflet 选点地图呈现“当前生效”状态。
   - **`action=clear`**：将本地 `wloc_settings` 数据擦除，使定位拦截脚本进入“透传模式”以恢复真实定位。

---

## 订阅地址

**Surge:**
https://raw.githubusercontent.com/AgentOpenAI/ChangeAppleLocation/refs/heads/master/modules/wloc.sgmodule

**Quantumult X:**
https://raw.githubusercontent.com/AgentOpenAI/ChangeAppleLocation/refs/heads/master/modules/wloc.conf

**Loon:**
https://raw.githubusercontent.com/AgentOpenAI/ChangeAppleLocation/refs/heads/master/modules/wloc.lpx

**Stash:**
https://raw.githubusercontent.com/AgentOpenAI/ChangeAppleLocation/refs/heads/master/modules/wloc.stoverride

**Shadowrocket(小火箭):**
https://raw.githubusercontent.com/AgentOpenAI/ChangeAppleLocation/refs/heads/master/modules/wloc.module

> Egern 可直接使用 Surge 模块
> Stash 请直接订阅上面的 `.stoverride`，无需用 Script Hub 转换

---

## 快捷指令（推荐，最方便）

直接用快捷指令切换 / 清除定位，无需打开选点页面：

- **wloc 设置地理位置**：https://www.icloud.com/shortcuts/a82717d8fdad4e6280866fcf911173f7
- **wloc 清理恢复位置**：https://www.icloud.com/shortcuts/f42632d406504f24a2cd163af4fe012f

**用法**

- **设置位置：** 在地图 App 里选好位置（长按地图选点）→ 共享 → 选「wloc 设置地理位置」即可切换。
  - 苹果地图：选点 → 共享 → 「wloc 设置地理位置」
  - 高德地图：选点 → 分享 → **更多** → 「wloc 设置地理位置」
- **清理位置：** 点「wloc 清理恢复位置」即可恢复真实定位。

支持苹果地图、高德（含短链，自动跟跳转 + GCJ-02→WGS84 坐标换算）。

> 前提：代理已开 + 模块已启用 + 信任 `gs-loc.apple.com`。选点页面（Worker / Pages）方案仍保留，见下方。

---

### 关于地图链接解析（worker）

为了让苹果地图和高德走同一条流程，链接统一发给 `changeapplelocation.appleai.workers.dev/api/parse` 解析：

- **高德**：分享出来是短链，真实坐标只藏在 302 跳转的 `Location` 头里，且是 GCJ-02 偏移坐标。快捷指令既读不到跳转头、也难做坐标换算，所以由 worker 跟跳转 → 抠坐标 → GCJ-02→WGS84 → 返回经纬度。
- **苹果地图**：链接里直接带 `coordinate=纬度,经度`，但在**中国大陆同样是 GCJ-02 偏移坐标**，所以和高德一样由 worker 做 GCJ-02→WGS84 换算后返回；境外坐标会自动跳过换算（`out_of_china` 判断）原样返回。除了统一坐标系，走同一接口也方便统一处理短链、文本夹链接、名称解码等。

**隐私：** `/api/parse` 是纯转发解析——收到链接 → 跟跳转 → 解析坐标 → 返回 JSON，全程不写任何存储、不记日志、不缓存，处理完即丢。

**部署个人 Worker：** worker 源码完全开源，建议自建部署后，将快捷指令中的域名替换为您的个人 Worker 域名即可。

---

<details>
<summary><b>使用方法</b></summary>

1. 订阅模块并启用 MITM
2. 打开在线选点页面（您自建的 Worker 选点网页，建议添加到主屏幕）
3. 地图选位置 / 搜索地名 / 粘贴地图链接
4. 点击「储存到设备」
5. 下次 Apple 定位触发时自动生效

支持 Apple Maps / Google Maps / 高德 / 百度 / 坐标文本 链接解析。

> **iOS 26/27 及更高版本注意：** Apple 从 iOS 26 开始大幅强化了 `locationd` 的定位缓存机制，系统会将之前获取的真实定位结果缓存在内存中并长时间复用。这意味着安装模块或切换目标坐标后，即使脚本已成功修改了 WLOC 响应（日志显示"已修改"），系统仍可能继续使用缓存中的旧坐标，导致定位看起来没有变化。
>
> **解决方法：重启设备。** 重启会清空 `locationd` 的内存缓存，系统重新发起 WLOC 请求时会拿到修改后的坐标。飞行模式开关、关闭定位服务等方式在 iOS 26+ 上**无法**清除此缓存，必须重启。iOS 15~18 通常不需要重启即可生效。

**高版本系统推荐操作流程（成功率最高）：**

方法一：
1. 先在选点页面选好需要修改的定位并储存到设备
2. 开飞行模式 → 关闭定位服务 → 重启设备
3. 关闭飞行模式（WiFi 也要关）→ 连接代理工具（确认 VPN 图标出现）→ 打开定位服务
4. 打开地图验证

方法二：
1. 关闭定位服务
2. 在选点页面选好位置并储存到设备
3. 打开定位服务 → 弹出「允许访问位置信息」时选择**「下次询问或在我共享时」**
4. 打开地图验证

</details>

<!-- 原“工作原理”折叠内容已升级至页面上方的【底层原理与架构设计】小节 -->

<details>
<summary><b>参数配置</b></summary>

| 参数 | 说明 | 默认值 |
|------|------|--------|
| longitude | 目标经度(在线选点优先) | null (透传) |
| latitude | 目标纬度(在线选点优先) | null (透传) |
| accuracy | 精度(米) | 25 |
| logLevel | 日志级别 | info |

优先级: 在线选点储存 > 模块参数 > 默认值

</details>

<details>
<summary><b>取消虚拟定位 / 恢复真实定位</b></summary>

**方法一：关闭或删除模块**（推荐）

关闭模块后脚本不再拦截 WLOC 请求，系统自动恢复真实定位。iOS 26+ 需要重启设备清除定位缓存。

**方法二：清除持久化数据（透传模式）**

清除已保存的坐标后，脚本进入**透传模式**——不修改 WLOC 响应，直接放行原始数据，系统自动恢复真实 GPS 定位。

**透传模式触发条件：** 持久化数据为空（null）且模块参数为默认值（113.94114, 22.544577）时，脚本判定用户未自定义坐标，自动跳过修改。模块默认参数无需更改，仅清除持久化数据即可触发透传。

在代理工具中删除持久化数据，字段名为 `wloc_settings`：

- **Surge** — 脚本编辑器运行: `$persistentStore.write(null, "wloc_settings")`
- **Quantumult X** — 运行: `$prefs.removeValueForKey("wloc_settings")`
- **Loon** — 运行: `$persistentStore.write(null, "wloc_settings")`

清除后重启设备即可恢复真实定位。无需关闭模块，脚本会自动检测到无自定义坐标并跳过修改。

> **注意：** 如果用户在模块参数中手动修改了经纬度（非默认 113.94114, 22.544577），即使清除持久化数据，脚本仍会使用模块参数中的坐标进行修改。只有保持默认参数不变时，清除持久化数据才会进入透传模式。

</details>

<details>
<summary><b>收藏位置功能</b></summary>

在线选点页面支持收藏多个位置，方便来回切换：

- **添加收藏**：选好位置后点击「收藏位置」→ 输入备注名称（支持中文/英文/数字，最多 30 字）→ 保存
- **快速切换**：点击收藏列表中的位置 → 地图自动跳转 → 点「储存到设备」即可切换
- **当前生效标记**：与设备已保存坐标一致的收藏会显示「✓ 当前生效」
- **删除管理**：单个删除（×按钮）或清空全部
- **当前生效坐标**：页面显示设备端持久化数据（wloc_settings），支持刷新查询和清除

**数据存储说明：**
- **收藏列表** → 保存在浏览器 `localStorage`（仅用于选点页面的 UI 便捷操作）
- **生效坐标** → 保存在代理工具持久化存储 `$persistentStore`（脚本运行时实际读取的数据）

两者独立存储。收藏列表是浏览器端的辅助数据，清除浏览器缓存或换浏览器后需重新收藏，但不影响已储存到设备的生效坐标。

</details>

<details>
<summary><b>自部署 Worker（推荐）</b></summary>

本项目不提供任何公共托管实例以保证绝对的安全性与隐私。建议部署您本人的专属 Worker 服务，部署成功后，将各代理模块中的域名替换为您的个人域名：

- **您的 Workers 域名**: `https://changeapplelocation.appleai.workers.dev/`

**一键部署（Workers）：**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AgentOpenAI/ChangeAppleLocation/tree/master/worker)

> 一键部署仅支持 Workers 模式，点击按钮后按提示授权即可完成部署。

**手动部署（Workers）：**

```bash
# 1. 克隆仓库
git clone https://github.com/AgentOpenAI/ChangeAppleLocation.git
cd ChangeAppleLocation/worker

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare（首次需要）
npx wrangler login

# 4. 部署
npm run deploy
```

部署成功后会得到你自己的 Worker 地址（如 `https://wloc-spoofer.<你的子域名>.workers.dev`），用这个地址选点即可。

> 免费账户每天 10 万次请求，个人使用完全够用。

<details>
<summary>高级：Pages 部署</summary>

Pages 部署不支持一键按钮，需要手动执行：

```bash
git clone https://github.com/AgentOpenAI/ChangeAppleLocation.git
cd ChangeAppleLocation/worker
npm install
npx wrangler pages deploy dist --project-name <自定义项目名>
```

部署时会提示设置 production branch，输入 `master` 即可。部署成功后得到 `https://<项目名>.pages.dev` 地址。

Pages 和 Workers 功能完全一致，按需选择即可。

</details>

</details>

<details>
<summary><b>注意事项</b></summary>

- 需要 MITM 证书信任 `gs-loc.apple.com` 和 `gs-loc-cn.apple.com`
- 仅修改网络定位(WiFi/基站)，不影响 GPS 硬件定位
- iOS 在 GPS 信号强时可能忽略网络定位结果
- 适用于 WiFi 定位为主的室内场景效果最佳
- 选点页面需在代理模式下使用（Safari 走代理才能拦截储存请求）

</details>

---

## 🛠️ 本地开发与代码构建自编译指南

为了保证本项目的代码彻底透明，我们已逆向还原了 `dist/` 下的混淆发布版脚本，并将高可读性、带有详尽中文注释的源码放置于 `src/` 目录下。

如果您想修改脚本逻辑（如优化坐标拦截算法、调整日志级别）或审计代码，可以在本地进行自编译构建：

### 1. 开发环境要求
您的电脑需要安装 [Node.js](https://nodejs.org/)（建议版本 v16+）。

### 2. 初始化项目依赖
在项目根目录下，运行以下命令安装打包器 `esbuild` 与依赖解压库 `pako`：
```bash
npm install
```

### 3. 一键编译与混淆打包
我们配置了极速的 `esbuild` 编译引擎，它能在数毫秒内完成摇树优化 (Tree Shaking)、模块合并与代码压缩混淆。

在根目录下执行以下构建命令：
```bash
npm run build
```

该命令会自动在 `dist/` 目录下生成两套版本的脚本供您选用：
*   **混淆压缩版** (供生产环境使用，以保证 iOS 设备极速执行且省电)：
    *   `dist/wloc.js` — WLOC 定位修改核心主脚本（约 40KB，自动打包嵌入了 pako 依赖库）。
    *   `dist/wloc-settings.js` — 存储配置写入控制脚本（约 12KB）。
*   **未压缩开发版** (供您直接阅读、安全审计或代理端 Debug 调试)：
    *   `dist/wloc.dev.js` — 包含了完整模块依赖和换行的未压缩 WLOC 脚本。
    *   `dist/wloc-settings.dev.js` — 未压缩的存储控制脚本。

### 4. 提交您的修改
自编译通过并测试无误后，将代码提交并推送至您的 GitHub 仓库 `master` 分支，您代理软件（如 Surge）订阅的 Raw 链接脚本就会自动同步更新为您自己开发编译的新版本。

---

## 致谢

- [proxypin-wloc-spoofer](https://github.com/FFF686868/proxypin-wloc-spoofer) - 原始 WLOC 定位修改思路 by FFF686868
- [NSNanoCat/Util](https://github.com/NSNanoCat/util) - 跨平台脚本工具框架
