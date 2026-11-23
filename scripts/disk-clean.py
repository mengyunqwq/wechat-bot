# -*- coding: utf-8 -*-
"""
磁盘清理 / 日志轮转（P0，2026-11-24）

清什么：
  ① 桥日志：> 7 天的删掉；超大盘（如 11-17 那个 103MB）压成 gz 或直接删（默认删）
  ② 唱歌中间文件 sing-work：只留最近 N 个任务目录（默认 5）
  ③ 唱歌任务目录 sing-jobs：删「无 job.json 且超过 7 天」的空目录
  ④ 微信自己的日志目录：只留最近 N 天（默认 3）
  ⑤ DSH 插件日志：超过 50MB 截断（保留最后 2000 行）

用法：
  python disk-clean.py            # 真删
  python disk-clean.py --dry      # 只看会删什么
"""
import argparse
import gzip
import os
import shutil
import time
from collections import defaultdict

BOT = r'D:\微信deepseek'
LOG_DIR = os.path.join(BOT, 'data', 'logs')
SING_JOBS = r'E:\rvc\sing-jobs'
SING_WORK = r'E:\rvc\sing-work'
WX_LOG = os.path.join(os.environ.get('APPDATA', ''), 'Tencent', 'xwechat', 'log')
PLUGIN_LOG = r'D:\dsh\data\super-injector\wechat-bot-plugin.log'

DAY = 86400


def mb(n):
    return round(n / 1048576, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--log-days', type=int, default=7)
    ap.add_argument('--wx-days', type=int, default=3)
    ap.add_argument('--keep-work', type=int, default=5)
    ap.add_argument('--big-log-mb', type=int, default=30, help='单个日志超过这个体积就压缩')
    a = ap.parse_args()

    now = time.time()
    freed = 0
    acted = 0

    def size_of(path):
        """文件或目录（递归）的实际占用"""
        try:
            if os.path.isfile(path):
                return os.path.getsize(path)
            total = 0
            for r, _, fs in os.walk(path):
                for f in fs:
                    p = os.path.join(r, f)
                    try:
                        total += os.path.getsize(p)
                    except Exception:
                        pass
            return total
        except Exception:
            return 0

    def rm(path):
        nonlocal freed, acted
        try:
            size = size_of(path)
            if a.dry:
                print('    [dry] 删 %s（%.1f MB）' % (path, mb(size)))
            else:
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
            freed += size
            acted += 1
        except Exception as e:
            print('    ✗ 删除失败 %s：%s' % (path, str(e)[:60]))

    def gz(path):
        nonlocal freed, acted
        try:
            size = os.path.getsize(path)
            if a.dry:
                print('    [dry] 压缩 %s（%.1f MB → 约 %.1f MB）' % (path, mb(size), mb(size) / 8))
            else:
                with open(path, 'rb') as src, gzip.open(path + '.gz', 'wb', compresslevel=6) as dst:
                    shutil.copyfileobj(src, dst)
                os.remove(path)
                new = os.path.getsize(path + '.gz')
                freed += size - new
            acted += 1
        except Exception as e:
            print('    ✗ 压缩失败 %s：%s' % (path, str(e)[:60]))

    # ① 桥日志
    print('① 桥日志（%s）' % LOG_DIR)
    if os.path.isdir(LOG_DIR):
        groups = defaultdict(list)
        for fn in os.listdir(LOG_DIR):
            p = os.path.join(LOG_DIR, fn)
            if not os.path.isfile(p):
                continue
            st = os.stat(p)
            age_days = (now - st.st_mtime) / DAY
            if fn.endswith('.gz'):
                if age_days > a.log_days * 2:
                    rm(p)
                continue
            if age_days > a.log_days:
                rm(p)
            elif st.st_size > a.big_log_mb * 1048576:
                gz(p)
            groups[fn].append(st.st_size)
        total = sum(os.path.getsize(os.path.join(LOG_DIR, f))
                    for f in os.listdir(LOG_DIR) if os.path.isfile(os.path.join(LOG_DIR, f)))
        print('    清理后合计 %.1f MB' % mb(total))

    # ② sing-work：只留最近 N 个
    print('② 唱歌中间文件（%s）' % SING_WORK)
    if os.path.isdir(SING_WORK):
        dirs = [os.path.join(SING_WORK, d) for d in os.listdir(SING_WORK)
                if os.path.isdir(os.path.join(SING_WORK, d))]
        dirs.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for p in dirs[a.keep_work:]:
            rm(p)
        print('    保留最近 %d 个，其余 %d 个清理' % (min(a.keep_work, len(dirs)), max(0, len(dirs) - a.keep_work)))

    # ③ sing-jobs：无 job.json 且超 7 天
    print('③ 唱歌任务目录（%s）' % SING_JOBS)
    if os.path.isdir(SING_JOBS):
        n = 0
        for d in os.listdir(SING_JOBS):
            p = os.path.join(SING_JOBS, d)
            if not os.path.isdir(p):
                continue
            age = (now - os.path.getmtime(p)) / DAY
            if not os.path.exists(os.path.join(p, 'job.json')) and age > 7:
                rm(p)
                n += 1
        print('    清理 %d 个空/过期目录' % n)

    # ④ 微信日志
    print('④ 微信日志（%s）' % WX_LOG)
    if os.path.isdir(WX_LOG):
        n = 0
        for root, _, files in os.walk(WX_LOG):
            for fn in files:
                p = os.path.join(root, fn)
                try:
                    if (now - os.path.getmtime(p)) / DAY > a.wx_days:
                        rm(p)
                        n += 1
                except Exception:
                    pass
        print('    清理 %d 个旧文件' % n)

    # ⑤ 插件日志
    print('⑤ 插件日志（%s）' % PLUGIN_LOG)
    if os.path.isfile(PLUGIN_LOG):
        size = os.path.getsize(PLUGIN_LOG)
        if size > 50 * 1048576:
            if a.dry:
                print('    [dry] 截断到最近 2000 行（%.1f MB）' % mb(size))
            else:
                with open(PLUGIN_LOG, 'r', encoding='utf-8', errors='replace') as f:
                    lines = f.readlines()[-2000:]
                with open(PLUGIN_LOG, 'w', encoding='utf-8') as f:
                    f.writelines(lines)
                freed += size - os.path.getsize(PLUGIN_LOG)
                acted += 1
                print('    已截断')
        else:
            print('    体积正常（%.1f MB）' % mb(size))

    print()
    print('%s：%d 项操作，释放约 %.1f MB' % ('[dry] 预计' if a.dry else '完成', acted, mb(freed)))
    if not a.dry:
        try:
            for drive in ('D:/', 'E:/'):
                t, u, f = shutil.disk_usage(drive)
                print('  %s 可用 %.1f GB / %.1f GB' % (drive, f / 1073741824, t / 1073741824))
        except Exception:
            pass


if __name__ == '__main__':
    main()
