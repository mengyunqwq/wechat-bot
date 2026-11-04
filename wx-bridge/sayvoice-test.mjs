import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:17300');
const timeout = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
ws.on('open', () => {
  ws.send(JSON.stringify({ id: '1', op: 'identify', args: { ident: 'voice-test' } }));
});
let identified = false;
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.op === 'identify' && !identified) {
    identified = true;
    ws.send(JSON.stringify({ id: '2', op: 'sayVoice', args: { roomId: '47390425951@chatroom', text: '你好呀，我是鲸鱼娘，今天也要好好吃饭哦', emotion: 'main' } }));
  } else if (m.id === '2') {
    console.log('sayVoice:', JSON.stringify(m));
    clearTimeout(timeout);
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
