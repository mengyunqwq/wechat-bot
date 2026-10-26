"""列出机器人所在的所有会话：群/人、最新消息时间、以及各自的记忆文件情况。"""
import binascii
import hashlib
import json
import os
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOOK = 'http://127.0.0.1:30001/QueryDB/execute'
MEM_DIR = r'D:\dsh\data\wechat-bot\memory'
FACTS_DIR = r'D:\dsh\data\wechat-bot\facts'


def sql(db, q):
    body = json.dumps({'optDbName': db, 'SQL': q}).encode()
    r = subprocess.run(['curl.exe', '-s', '-X', 'POST', HOOK,
                        '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                       input=body, capture_output=True)
    try:
        return json.loads(r.stdout.decode('utf-8', 'replace'))
    except Exception:
        return {'data': []}


def main():
    tables = [d['name'] for d in sql('message_0.db',
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").get('data', [])]
    # 已知会话：contact.db 里的群 + 联系人（用 md5 反查表名）
    rooms = sql('contact.db', 'SELECT username, nick_name, remark FROM contact').get('data', [])
    by_hash = {}
    for c in rooms:
        u = c.get('username') or ''
        if not u:
            continue
        by_hash[hashlib.md5(u.encode()).hexdigest()] = (u, (c.get('remark') or c.get('nick_name') or '').strip())

    print(f'共 {len(tables)} 个会话表\n')
    rows = []
    for t in tables:
        h = t[4:]
        one = sql('message_0.db', f'SELECT local_id, local_type, create_time FROM {t} ORDER BY local_id DESC LIMIT 1').get('data', [])
        cnt = sql('message_0.db', f'SELECT COUNT(*) AS n FROM {t}').get('data', [])
        if not one:
            continue
        x = one[0]
        ts = int(x['create_time'])
        who = by_hash.get(h, ('(未匹配)', ''))
        rows.append({
            'table': t, 'hash': h, 'wxid': who[0], 'name': who[1],
            'last_id': x['local_id'], 'last_type': x['local_type'], 'last_ts': ts,
            'count': int((cnt[0]['n'] if cnt else 0)),
        })
    rows.sort(key=lambda r: -r['last_ts'])
    import datetime
    for r in rows:
        t = datetime.datetime.fromtimestamp(r['last_ts']).strftime('%m-%d %H:%M:%S')
        kind = '群' if r['wxid'].endswith('@chatroom') else '私聊'
        print(f"  [{kind}] {r['name'] or r['wxid']}")
        print(f"        wxid={r['wxid']}  最新={t}  消息数={r['count']}  最后类型={r['last_type']}")

    print('\n── 记忆文件（应按群分开）──')
    for d, label in ((MEM_DIR, '短期记忆'), (FACTS_DIR, '长期记忆')):
        if not os.path.isdir(d):
            print(f'  {label}: 目录不存在')
            continue
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            sz = os.path.getsize(p)
            print(f'  {label}: {f}  ({sz/1024:.1f} KB)')

    print('\n── 其他共享文件 ──')
    for p in (r'D:\dsh\data\wechat-bot\members.json',):
        if os.path.exists(p):
            j = json.load(open(p, encoding='utf-8'))
            print(f'  members.json: wxid映射 {len(j.get("wxid") or {})} 条, @名字 {len(j.get("atNames") or [])} 个（全局共享，跨群通用）')


if __name__ == '__main__':
    main()
