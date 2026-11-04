# 逆向分析笔记

> 目标：微信 **4.1.10.27 x64**。所有偏移都是 RVA（相对 `Weixin.dll` 基址）。
> 这份笔记记录本 Hook 的结构、它 hook 了什么、以及崩溃分析的结论，方便后续维护/适配新版本。

## 一、整体结构

```
Weixin.exe
 └─ 加载同目录 version.dll（本 Hook）
      ├─ 导出 17 个 version.dll 代理函数（保证系统/微信正常调用不失败）
      ├─ DllMain 里起后台线程：等待 Weixin.dll 就绪 → 解析偏移 → 装 Hook
      ├─ 本地 HTTP 服务 127.0.0.1:30001（httplib，多线程）
      └─ 回调推送 127.0.0.1:18998/recv（可选）
```

代理导出（`version.def`）：`GetFileVersionInfoA/W`、`GetFileVersionInfoExA/W`、`GetFileVersionInfoSizeA/W`、
`VerFindFileA/W`、`VerInstallFileA/W`、`VerLanguageNameA/W`、`VerQueryValueA/W`、`GetFileVersionInfoByHandle`。

## 二、HTTP 端点（16 个）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/QueryDB/execute` | 执行 SQL（`{optDbName, SQL}`）|
| GET | `/QueryDB/status` | 登录状态（`IsLogin`、`hWeixin`）|
| POST | `/QueryDB/GetAllDBName` | 列出数据库名 |
| GET | `/QueryDB/debug` | 句柄注册表诊断 |
| POST | `/SendTextMsg` | 发文本（支持 `atlist` 真 @）|
| POST | `/SendImgMsg` | 发图片 |
| POST | `/SendVoiceMsg` | 发语音（SILK → type 34 气泡）|
| POST | `/Decode_Pic` | 解密图片 |
| POST | `/ForwardXMLMsg` | 转发 XML 消息 |
| POST | `/GetSelfProfile` | 取自己资料 |
| GET | `/Debug/ApiTable` | sqlite API 表槽位 |
| POST | `/Debug/DBRescan` | 重扫数据库句柄 |
| GET/POST | `/Debug/VuProbe` | 眼睛探针状态 |
| GET/POST | `/Debug/VoiceDump` | 语音发送探针 |
| POST | `/Debug/VoiceSend` | 语音发送开关 |

## 三、偏移与跨版本机制

`include/offset_patterns.h` 由 `scripts/gen-offset-patterns.py` 从 `Weixin.dll` 自动生成，每个偏移含：

- `fallback`：当前版本的硬编码 RVA
- `bytes/len`：特征字节（`0xFF` 为通配）
- `ripRelative/insnLen/dispOffset`：数据目标需从指令反算

运行时 `offset_resolver.cpp` 在 `Weixin.dll` 里搜特征码：**搜到用新地址，搜不到回退 fallback**。
换微信版本时：

1. 用新版 `Weixin.dll` 跑 `tools_rva_dump.py` / `scripts/gen-offset-patterns.py` 重新生成
2. 核对 `global.h` 里的兜底值
3. 校验结构体大小（消息 `0x768`、语音构造器 `0x208`）与 vtable
4. 逐项回归测试

关键偏移（4.1.10.27）：

| 名称 | RVA | 用途 |
|---|---|---|
| `XWECHAT_SQLITE3_API_ROUTINES_OFFSET` | `0x8BB0D38` | sqlite 函数表 |
| `XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET` | `0x8BB1570` | sqlcipher 函数表 |
| `XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC` | `0x4EE64D0` | 取每库密钥 |
| `send_message` | `0x1677A30` | 消息发送 |
| `txt_message_ctr` | `0x6B2C30` | 文本消息构造 |
| `voice_msg_ctr` | `0xA203B0` | 语音消息构造（`0x208` 字节）|
| `voice_send_factory` | `0x619A190` | 语音发送对象工厂 |
| `dec_pic_call` | `0x493E70` | 图片解密 |

## 四、数据库层（`xdb/db_mgr.cpp`）

微信的库是 SQLCipher 加密的，**只能用客户端自己打开的连接**。所以 Hook 的做法是：

1. Hook `open` / `open16` / `open_v2` / `prepare`，记录「sqlite3* 句柄 → 数据库名」
2. `/QueryDB/execute` 用记下的句柄直接 `prepare/step/finalize`
3. 启动时 API 表可能还没填（`api->open16 == nullptr`）→ 需要 **late-arm**：
   每次查询前补装缺失钩子（幂等）

## 五、崩溃分析（`Weixin.dll+0x32BB50C`）

多个 dump 显示客户端固定崩在同一地址，反汇编（capstone）得到：

```asm
; 函数起点约 0x32BB4D0
0x32BB4E6  movzx r8d, word [rcx+0x19C]   ; 块大小上限
0x32BB4EE  mov eax, 0x1A8
0x32BB4F3  cmp rdx, r8                   ; 请求大小
0x32BB4F6  jbe .small
0x32BB4F8  inc dword [rcx+rax]           ; 大块计数
0x32BB4FB  jmp 0x32BB550                 ; malloc

.small:
0x32BB500  mov rax, [rcx+0x1B8]          ; 空闲链表头（小块）
0x32BB507  test rax, rax
0x32BB50A  je  .next
0x32BB50C  mov rdx, [rax]                ; ★ 崩：rax = 0x35
0x32BB50F  mov [rcx+0x1B8], rdx
0x32BB516  inc dword [rcx+0x1A4]
0x32BB51C  ret
```

这是 **sqlite 的 lookaside 分配器**（按尺寸维护两条空闲链表）。`pFree` 被写坏成 `0x35`，
下次分配时 `mov rdx,[0x35]` 崩溃 —— 属于**内存结构被并发踩坏**。

### 根因（推断）

Hook 调用的是 `sqlite3_api_routines` 函数表里的 `prepare/step/finalize`，
这些是**内部实现函数，不带连接互斥锁**；公开的 `sqlite3_prepare_v2()` 外层才会
`sqlite3_mutex_enter(db->mutex)`。因此：

```
客户端线程：公开 API → 加锁 → 用 lookaside
Hook 线程 ：函数表   → 不加锁 → 同时用同一个 lookaside
→ 空闲链表被并发改坏 → 下一次分配崩
```

### 缓解

- 已加全局 `std::recursive_mutex`，串行化 Hook 自身的查库与发送（减少 Hook 内部并发）
- **仍未根治**：客户端线程不走这把锁。彻底方案：
  1. 调用前 `sqlite3_mutex_enter(db->mutex)`（需逆 `sqlite3` db 结构）
  2. 或自己开一个只读 SQLCipher 连接（用 `codec_get_key` 拿密钥）

## 六、免责声明

以上内容仅供学习研究。修改/挂钩微信可能违反用户协议，风险自负。
