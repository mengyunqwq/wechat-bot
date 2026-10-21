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

## 四之二、遗留问题（重要 —— 这个修复**只解决了一半**）

上面的数据来自**一台特定的机器**。在另一台机器上复测时，仍然失败，症状不同：

```json
"hooks":    { "prepare": true, "open_v2": true },
"registry": { "count": 38, "named": 31, "unnamed": 7 },
"counters": { "registrations": 39, "open_v2_names": 0,
              "lookup_ok": 0, "lookup_miss": 3 },
"cache":    [ { "db": "message_0.db", "source": "name_pass", "registered": true } ]
```

关键差异：

| 现象 | 说明 |
|---|---|
| `registrations=39` | hook **装上了也命中了**（本节修复有效）|
| `named=31` 但来源全是 `name_pass` | 名字是**扫描猜的**，不是从 `db_filename` 读的 |
| `open_v2_names=0` | `open_v2` 钩子一次都没命中 |
| `lookup_ok=0` | 猜的名字和真实的对不上 → 按名查找全 miss |

### 为什么 `open_v2` 钩子不命中

对比同一进程里各 sqlite 函数的地址：

```
open       = 0x7FFB75078E20   （Weixin.dll 内）
prepare    = 0x7FFB76E1DB00   （Weixin.dll 内）
db_filename= 0x7FFB7507A9E0   （Weixin.dll 内）
open_v2    = 0x7FFC28868DE0   ← 完全不同的内存段，不在 Weixin.dll 里
```

**`sqlite3_api_routines` 表里的 `open_v2` 槽位指向的并不是微信实际使用的那个函数。**
微信静态链接了 sqlite，内部直接调用函数体；hook API 表里那个指针地址自然拦不到。

### 为什么名字取不到

取名依赖 `api->db_filename`。在出问题的机器上，这个槽位**非空但调用返回空**
（`safeDbName` 失败）—— 于是只能退化成"扫描内存猜文件名"，猜错的概率很高。

### 当前状态：**未彻底解决**

已做的两处缓解（都没能根治）：

1. `verifyName` 不再"拿不到名字就丢弃句柄"，改为"失败过的才丢弃"
   —— 让扫描到的健康句柄至少能被用上
2. 低频补名（`nameUnnamedFromApi`）：按名查找失败时用 `db_filename` 补一次

**还需要做的**（下一步方向）：

```
方案 A：不依赖 db_filename，直接扫描到句柄后用 SQL 探测它是哪个库
        （message_*.db 有 Msg_<hash> 表、contact.db 有 contact 表、
          session.db 有 session 表 —— 查一次 sqlite_master 就能判定）
        代价：违背"不主动探测"的设计红线，需要严格限频

方案 B：在 Weixin.dll 内用特征码定位真正的 sqlite3_open_v2（而不是读 API 表槽位），
        hook 它拿"文件名 + 句柄"的对应关系
```

如果你遇到同样问题，欢迎提供这两个端点的完整输出 —— 这是定位的关键：

```bash
curl http://127.0.0.1:30001/Debug/ApiTable
curl http://127.0.0.1:30001/Debug/DBRescan
```

> ⚠️ 一句话总结：**本页修复解决了"hook 装得太晚"，没有解决"名字取不到"。**
> 看到 `named` 全是 `name_pass` 来源、`lookup_ok` 一直是 0，就说明命中了后一个问题。

---

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
