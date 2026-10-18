# 微信 4.1.10.27 媒体自动下载 —— 逆向结论（2026-10-18）

**结论：自己拼 CDN 直链下载，在本版本【不可行】。** 已用证据否掉，别再重做。

## 一句话
微信的 CDN 下载**不是普通 GET**，而是 mars 自带的 KV 协议 **POST**，硬断言要求非空
**`authkey`** + `META`；而 `authkey` **不在** `videomsg` XML 节点里（那里只有
`aeskey` / `cdnvideourl` / `cdnthumburl` / `md5` / `length`）→ 必须从微信内部取。

## 关键证据（可复核）
| # | 证据 | 含义 |
|---|---|---|
| 1 | URL 模板 `POST http://%s/%s HTTP/1.1`，RVA `0x08d4ca29`（组装点 `0x5d3e510` / 调用 `0x5d3e59c`，`sprintf_s(buf,1023,fmt,host,path)`）| 拼法是 `http://host/path`，但 **path 是上层传进来的完整 URL**，不是从 token 拼的 |
| 2 | `Protocol::CBaseRequest::__MakeBody` 断言 `!authkey.empty()`（`0x8d4cb56`）、`!Exist(KEY_META)`（`0x8d4cb45`）| **必须有 authkey**，拿不到 → 必被拒 |
| 3 | 实测 **36 个主机 × 多种形态** → 全部 404/408/400，**无一个 200** | 环境对照：example.com/qq.com/baidu.com 全 200、无代理 → 是 CDN 拒绝 |
| 4 | 路由探测：`*/download`、`*/upload` → **408（鉴权不过）**；`/download/`、`/downloadx` → 404 | 路由**真实存在**，缺的是**鉴权**，不是文件不存在 |
| 5 | token 完全解开：嵌套 TLV（非 protobuf），内含 fileid UUID + **时间戳 `1791954934` = 2026-10-14** | ⚠️ **token 有时效** → 这条路天生短命 |
| 6 | `novac2c` / `encrypted_query_param`（ilink 新协议）在本安装目录 **0 命中** | 网上那条常见路**不适用本版本** |
| 7 | **AES 解密器自测 PASS**：AES-128-CBC，**IV = key** | 解密这一环可用（拿到密文就能出 MP4）|
| 8 | 样本视频 MD5 在 `xwechat_files` 下 768 个文件里查不到 | 印证：微信确实没下载 |

## 调内部函数也不划算
- 已定位到本版本的入口：`mars::cdn::StartSNSDownload` = **`Weixin.dll + 0x21ab7b0`**
  （微信层包装 `+0x21c0b60`，会校验 url 并挑主机）
- 但：要构造 `CdnTaskParam`（**0x400+ 字节**，url 在 `+0x380`），**仍要自己填 `authkey`**（来源未知）
- 与第三方 DLL（`wxhook.dll`，靠 `GetModuleHandleA("WeChatWin.dll")` + 硬编码 RVA 调
  `base+0x9C0080(mgr,ctx,0,1)`，其偏移是 **4.1.6.x** 的，本版本没有 `WeChatWin.dll`）同类
- 风险：**可能崩客户端**（`/ForwardXMLMsg` 已实测崩过一次）；且**每次微信升级都要重做**

## 可复用资产
- `D:\rea\cdn\FINDINGS.md` —— 完整报告（全部 RVA / 汇编片段）
- `D:\rea\cdn\wechat_cdn.py` —— 含**已验证可用的 AES 解密**（`wechat_decrypt()`），
  以及 `--selftest` / `--token <t> --aeskey <k>` 试下载入口（**必须先拿新鲜 token**，样本已过期）
- `D:\rea\cdn\{xref3,callxref,disctx,pe}.py` —— PE 解析 / RIP-relative xref / 反汇编上下文工具
- `D:\rea\wxhook-cps\wxhook.dll`（578.5KB，MD5 `0C62021A11966B6A`）+ `dump-download.txt` —— 第三方实现的反编译证据
- 踩坑：脚本目录里别放 `dis.py` / `token.py`（会遮蔽标准库，连 requests 都 import 不了）

## 所以现在的方案（已落地）
**不追自动下载**，改为：
1. 视频消息到达 → 立刻用**明文封面**识别（每条视频都有封面）
2. 后台 **+60s / +180s 复查** → 若视频文件出现了（群里有人点开过）→ 抽 6 帧 + 抽音轨 → 全部内容
3. **读完删掉**视频文件（省磁盘；再点开还能重新下载）
4. 找不到 → 降级封面 → 再降级 `[视频]`，**绝不阻塞回复**

## 如果将来还想做
两个前提之一必须满足：
- 找到 **`authkey` 的来源**（可能来自某个 CGI 或内存中的登录态结构）
- 或接受"**调内部函数**"的方案（要重新定位 4.1.10.27 的偏移 + 承担崩溃风险 + 每次升级重做）
