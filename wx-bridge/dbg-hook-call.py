import json
import subprocess
import sys

HOOK = 'http://127.0.0.1:30001/QueryDB/execute'


def sql(db, q):
    body = json.dumps({'optDbName': db, 'SQL': q}).encode()
    r = subprocess.run(
        ['curl.exe', '-s', '-X', 'POST', HOOK,
         '-H', 'Content-Type: application/json', '--data-binary', '@-'],
        input=body, capture_output=True)
    return r


if __name__ == '__main__':
    r = sql('message_0.db', "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
    print('returncode:', r.returncode)
    print('stdout[:400]:', r.stdout[:400])
    print('stderr[:400]:', r.stderr[:400])
