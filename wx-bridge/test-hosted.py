"""验证托管模式：起一个模拟 agent webhook，喂一条假消息，看它会不会正确交互。
用不存在的 roomId，避免真发到群里。"""
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time

PORT = 9999
got = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        got['body'] = body
        # 模拟一个 agent 的回复：带文字 + 表情包题材 + 要记的事实
        resp = json.dumps({
            'text': '（托管测试）我由外部 agent 驱动',
            'sticker': {'subject': '摸鱼', 'bubble': '别叫我'},
            'facts': ['托管模式测试：外部 agent 接入了'],
        }).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *a):
        pass


def main():
    srv = socketserver.TCPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f'模拟 agent webhook 已启动 :{PORT}')

    # 写托管配置（webhook 指向模拟 agent）
    cfg = {
        'hosted': {
            'enabled': True,
            'webhookUrl': f'http://127.0.0.1:{PORT}/reply',
            'botName': '蓝色大肥鱼',
            'replyProbability': 1.0,       # 测试时必回，方便验证
            'minReplyGapMs': 100,
            'quietHours': 'off',
        }
    }
    import os
    os.makedirs(r'D:\微信deepseek\data', exist_ok=True)
    with open(r'D:\微信deepseek\data\bridge-config.json', 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print('托管配置已写入（enabled=true, 指向模拟 agent）')

    # 用 node 跑一次 HostedMode.onMessage（假 roomId，不会真发到群）
    js = r'''
import { HostedMode } from './lib/hosted.mjs'
const h = new HostedMode({
  handle: async (op, args) => { console.log('  [handle]', op, JSON.stringify(args).slice(0,80)); if (op === 'sendText') throw new Error('假 roomId，故意失败'); return { id: 'fake-sticker' } },
  log: (s) => console.log('  [log]', s),
  dataDir: 'D:/微信deepseek/data',
})
console.log('  enabled =', h.cfg.enabled, ' webhook =', h.cfg.webhookUrl)
await h.onMessage({
  roomId: 'fake-room-测试@chatroom', roomName: '假群', sender: 'wxid_fake', senderName: '测试员',
  text: '@蓝色大肥鱼 你在吗', typeName: 'text', isAtMe: true, ts: Date.now(),
})
console.log('  stats =', JSON.stringify(h.stats))
'''
    out = subprocess.run(['node', '--input-type=module', '-e', js],
                         cwd=r'D:\微信deepseek\wx-bridge', capture_output=True, encoding='utf-8', errors='replace', timeout=120)
    print('--- node 输出 ---')
    print(out.stdout.strip() or '(空)')
    if out.stderr.strip():
        print('--- stderr ---')
        print(out.stderr.strip()[:800])

    print('--- 模拟 agent 收到的请求 ---')
    b = got.get('body')
    if not b:
        print('  ✗ agent 没收到请求')
        return 1
    print('  room =', json.dumps(b.get('room'), ensure_ascii=False))
    print('  trigger =', json.dumps(b.get('trigger'), ensure_ascii=False))
    print('  priority =', b.get('priority'))
    print('  recent 条数 =', len(b.get('recent') or []))
    print('  memory =', json.dumps(b.get('memory'), ensure_ascii=False))
    srv.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
