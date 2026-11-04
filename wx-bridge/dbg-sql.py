import json
import subprocess

HOOK = 'http://127.0.0.1:30001/QueryDB/execute'
T = 'Msg_a10d9fead9698b1b70b7d42e6d1de3c9'


def sql(db, q):
    body = json.dumps({'optDbName': db, 'SQL': q}).encode()
    r = subprocess.run(['curl.exe', '-s', '-X', 'POST', HOOK,
                        '-H', 'Content-Type: application/json', '--data-binary', '@-'],
                       input=body, capture_output=True)
    return r.stdout.decode('utf-8', 'replace')


tests = [
    ("count type=3", f"SELECT COUNT(*) AS n FROM {T} WHERE local_type=3"),
    ("count all", f"SELECT COUNT(*) AS n FROM {T}"),
    ("local_id only", f"SELECT local_id FROM {T} WHERE local_type=3 ORDER BY local_id DESC LIMIT 3"),
    ("content substr", f"SELECT local_id, substr(message_content,1,40) AS c FROM {T} WHERE local_type=3 LIMIT 2"),
    ("content full", f"SELECT local_id, message_content FROM {T} WHERE local_type=3 LIMIT 1"),
    ("source full", f"SELECT local_id, source FROM {T} WHERE local_type=3 LIMIT 1"),
]

for label, q in tests:
    out = sql('message_0.db', q)
    try:
        j = json.loads(out)
        n = len(j.get('data') or [])
        print(f'--- {label}: status={j.get("status")} desc={j.get("desc")!r} 行数={n}')
        if n:
            print('    ', json.dumps(j['data'][0], ensure_ascii=False)[:220])
    except Exception as e:
        print(f'--- {label}: 解析失败 {e}  原文={out[:200]!r}')
