# 数据库句柄 hook 的初始化时机问题（已修复）

> 这是本项目踩过的一个**真实生产故障**，症状很迷惑，根因却是"初始化时机"。
> 记录在这里，一是提醒后来者，二是给遇到同样现象的人一条排查路径。

---

## 一、症状

```
GET  /QueryDB/GetAllDBName   → 能列出 19 个库（含 message_0.db）
POST /QueryDB/execute        → 一律返回：
   {"status":-1,"desc":"get database handle which named message_0.db failed"}
```

同一条链路里，**列库正常、查询全挂**。对照实验：

| 版本 | 库数 | 查询 |
|---|---|---|
| 旧版 `version.dll`（748KB） | 22 | 全部正常 |
| 新版（自编译，762KB） | 19 | 全部失败 |

诊断端点 `/Debug/DBRescan` 显示：

```json
"counters": {
  "registrations": 40,     // 抓到了 40 次句柄
  "lookup_registry": 0,    // 按名查注册表：0 次成功
  "lookup_cache": 0,
  "lookup_miss": 70,       // 70 次全部 miss
  "lookup_ok": 0
},
"registry": {
  "count": 40,
  "named": 0,              // ★ 40 个句柄，一个名字都没有
  "entries": [{ "handle": "0x...", "db": "", "source": "prepare" }]
}
```

**关键特征：句柄抓到了（`registrations` 有值），但名字全是空的（`named=0`）。**

---

## 二、根因

句柄抓到了却没名字，是因为**抓的时机太晚**。

`DatabaseMgr` 是个懒加载单例：

```cpp
// 只有第一次访问 HTTP 路由时才会构造它
xmgr::DatabaseMgr& g_dbMgr = xmgr::DatabaseMgr::getInstance();
```

而 `prepare` / `open_v2` 的 hook 是在 `DatabaseMgr` 的**构造函数**里装的：

```cpp
DatabaseMgr::DatabaseMgr() {
    ...
    db_registry::install(m_sqlite3Rountines);        // 改 API 表
    db_registry::installCode(m_sqlite3Rountines);    // hook open_v2
    db_registry::installPrepare(m_sqlite3Rountines); // hook prepare
}
```

于是顺序变成：

```
微信启动 → 打开 message/contact/session 等主库（主连接建立）
        → 用户/桥第一次访问 /QueryDB/execute
        → DatabaseMgr 才被构造 → hook 才装上
        → 主连接早就开完了，一个都没抓到 ✗
```

后来抓到的那几个（`registrations=2~40`）都是**后续新建的临时连接**，它们要么很快关闭、要么不是我们要查的那个库 —— 所以：

- 注册表里没有「message_1.db → 句柄」这条映射
- `findByName("message_1.db")` 必然 miss
- 回退到"扫内存找句柄"（不稳定，实测命中数会在 219/225/3 之间跳）
- 最终表现就是"列库可以、查询全挂"

---

## 三、修复

**在 DLL 加载时就主动触发构造**，不要等第一次 HTTP 请求。

注意：不能在 `DllMain`（loader lock）里直接挂钩子 —— MinHook 会挂起线程，撞上就卡启动。
所以用"起线程 + 延迟 + 重试"的方式：

```cpp
// db_mgr.cpp
void StartEarlyInitThread() {
    static bool started = false;
    if (started) return;
    started = true;
    HANDLE h = CreateThread(nullptr, 0, [](LPVOID) -> DWORD {
        Sleep(2000);                       // 等微信填好 sqlite API 表
        for (int i = 0; i < 30; ++i) {
            if (g_hWeixinDll != nullptr) {
                DatabaseMgr::getInstance();    // 首次构造时装 hook
                // 那次若因 API 表未就绪而没装上，这里补装（构造只跑一次，必须自己重试）
                sqlite3_api_routines* api = (sqlite3_api_routines*)
                    ((size_t)g_hWeixinDll + XWECHAT_SQLITE3_API_ROUTINES_OFFSET);
                if (api != nullptr && api->prepare != nullptr) {
                    if (!db_registry::prepareHookInstalled()) db_registry::installPrepare(api);
                    if (!db_registry::openHookInstalled())    db_registry::installCode(api);
                }
                if (db_registry::prepareHookInstalled()) break;
            }
            Sleep(500);
        }
        return 0;
    }, nullptr, 0, nullptr);
    if (h) CloseHandle(h);
}
```

在 `Evt_WeixinLoad()`（DLL 加载时执行）里调用一次：

```cpp
xmgr::StartEarlyInitThread();
```

### 附带的两项改进

1. **`/Debug/ApiTable` 诊断端点**
   把 `sqlite3_api_routines` 里 13 个关键槽位（`prepare` / `prepare_v3` / `db_filename` /
   `open` / `open_v2` / `exec` / `step` …）的**地址、是否 null、是否在模块内、是否可读**
   全列出来。用来一眼区分：

   - 钩子没装上 → 槽位地址是 null 或不可读
   - 钩子装了但入口不对 → 地址正常，但 `lookup_ok` 一直是 0

2. **低频补名**
   按名查找失败时，用 `db_filename` 给"无名句柄"补一次名字再重试。
   **必须放在查询路径上，绝不能放进 `prepare` 的热路径** —— 热路径的红线是
   "零分配、无锁、不调 API"（见 `db_mgr.cpp` 顶部注释）。

---

## 四、修复效果（同一台机器实测）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `registrations` | 2 | **40** |
| `named`（有名句柄） | 0 | **33** |
| `db_count`（缓存库数） | 0 | **19** |
| `lookup_ok` | 0 | **204** |
| `query_ok` | — | **217**（fail=1）|
| `success_rate` | 0 | **99.5%** |

`message_1.db` 的注册表条目变成 `src=prepare, fail_streak=0`。

---

## 四之三、真正的根因：**数据目录不能包含中文**

> 这一节是排查了两天之后才找到的答案。前面那些「hook 装太晚」「open_v2 不命中」「verifyName 丢句柄」都是真的，
> 但**都不是**某些机器上"名字永远取不到"的原因。

### 现象

同一份代码，两台机器：

| 指标 | A 机器 | B 机器 |
|---|---|---|
| `registrations` | 40 | 40（hook 命中了）|
| `named` | 33 | 31 |
| **名字来源** | `prepare`（真实文件名）| **全部 `name_pass`（扫描猜的）** |
| `db_count` | 19 | 0 |
| **`lookup_ok`** | 204 | **0** |

`db_filename` 槽位非空、可读、在模块内 —— 函数是好的，但**调用结果被我们自己扔掉了**。

### 根因

`db_filename` 返回的是**完整路径**（含目录）。而取值函数里有一条 ASCII 白名单：

```cpp
size_t n = 0;
while (n < 260 && fn[n] != '\0') {
    const unsigned char c = (unsigned char)fn[n];
    if (c < 0x20 || c > 0x7E) return false;      // ★ 只放行可见 ASCII
    ++n;
}
out = baseName(std::string(fn, n));              // ← 先检查完整路径，才取文件名
```

**UTF-8 编码的中文字符，每个字节都 > 0x7E**。所以：

```
D:\Users\Administrator\xwechat_files\wxid_xxx\...\message_1.db    → 纯 ASCII，通过 ✓
C:\Users\xxx\Documents\微信数据\db_storage\message\message_0.db    → 含中文，直接 return false ✗
```

**而且这个检查在 `baseName()` 之前** —— 连文件名都没机会取，整个函数就失败了。

于是：
1. 名字取不到 → 句柄只能靠 `name_pass`（扫描内存找 `.db` 字符串）猜
2. 扫描是"按地址邻近猜"，命中率不高
3. 猜的名字和真实的对不上 → `findByName` 全 miss → `lookup_ok = 0`
4. 表现就是 `GetAllDBName` 能列库、`QueryDB/execute` 一律失败

### 修复

```cpp
// 只挡控制字符（< 0x20），允许 UTF-8 多字节（中文路径）；
// 取到文件名（baseName）之后再用 looksLikeDbName 校验 —— 文件名本身是 ASCII 的 *.db
size_t n = 0;
while (n < 512 && fn[n] != '\0') {
    const unsigned char c = (unsigned char)fn[n];
    if (c < 0x20) return false;
    ++n;
}
if (n == 0 || n >= 512) return false;
out = baseName(std::string(fn, n));
return looksLikeDbName(out);
```

### ⚠️ 部署建议

**微信数据目录（`xwechat_files` 所在路径）不要包含中文、空格以外的特殊字符。**

- 默认位置通常是 `C:\Users\<用户名>\Documents\xwechat_files` —— 如果**用户名是中文**，路径里就会带中文
- 换到纯 ASCII 路径（如 `D:\WeChatData\`）可以从根源上避开这类问题
- 在**微信 → 设置 → 文件管理** 里可以看到当前的数据目录

> 注：本项目 v2026-10-22 之后的版本已修复这个解析问题，
> 但**仍然建议**把数据目录放在纯 ASCII 路径下 —— 第三方组件（hook、SQLite、备份工具）
> 对非 ASCII 路径的支持程度各不相同，这类坑不止一处。

### 另外两个已知但已被兜住的问题

1. **`open_v2` 槽位是坏的**
   `sqlite3_api_routines` 表里 `open_v2` 指向的地址不在 `Weixin.dll` 内（而在 `0x7FFC...` 段），
   所以 hook 它一次都不命中。当前做法是 **open / open16 / open_v2 三个入口都挂**，命中哪个算哪个。

2. **`verifyName` 会丢弃健康句柄**
   原来"拿不到名字就判 false"，导致扫描到的句柄被 `m_dbs.erase()` 扔掉。
   现在改成"失败过的才丢弃（`fail>=1`），没失败过的先放行"。

## 五、排查这类问题的顺序

```
① GET /Debug/DBRescan
   ├─ hooks.prepare = false        → 钩子没装上（API 表读不到 / 偏移错）
   ├─ registrations = 0            → 钩子装了但没命中（入口不对 / 装太晚）
   ├─ named = 0 而 count > 0       → ★ 抓到了但没名字 → 查 db_filename
   └─ db_count = 0 而 named > 0    → 缓存没合并 → 查 searchDatabases
② GET /Debug/ApiTable             → 看槽位地址是否正常
③ 对比实验：换回旧版 DLL 是否恢复 → 区分"hook 问题"和"微信/环境问题"
```

---

## 六、两个反面教训

1. **不要在 `prepare` 热路径里做任何"顺手"的事**
   我第一版修复是"句柄首次登记时立刻用 `db_filename` 取名"—— 逻辑上很自然，
   但那个函数在 `prepare` detour 里，红线写着"零分配、无锁、不调 API"。
   加了 `std::string`（堆分配）和 sqlite 内部调用之后，数据库直接卡住：
   `registrations` 掉到 0、`dbs` 空、但微信界面照常（界面是缓存的）。
   **热路径就老老实实只做一次原子写。**

2. **"列库成功"不代表"库能用"**
   `GetAllDBName` 只需要遍历句柄表（不碰真实连接），
   `execute` 才需要按名找到健康句柄。两者失败模式完全不同，
   **不要因为一个接口正常就以为链路没问题**。
