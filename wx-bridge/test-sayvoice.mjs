import { WeChatHookBridge } from './lib/wechat-hook.mjs';
const hook = new WeChatHookBridge({ apiPort: 30001, wechatExe: 'D:\\wxhook\\wx4110\\Weixin.exe', log: (m) => console.log('[bridge]', String(m).slice(0,180)) });
try {
  const r = await hook.sayVoice('47390425951@chatroom', '测试语音发送', { emotion: 'main' });
  console.log('sayVoice:', JSON.stringify(r).slice(0, 300));
} catch (e) {
  console.log('ERR:', e.message, '| cause:', e.cause ? String(e.cause) : 'none');
}
process.exit(0);
