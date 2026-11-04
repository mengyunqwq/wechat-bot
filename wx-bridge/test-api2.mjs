import { WeChatHookBridge } from './lib/wechat-hook.mjs';
const hook = new WeChatHookBridge({ apiPort: 30001, wechatExe: 'D:\\wxhook\\wx4110\\Weixin.exe', log: (m) => console.log('[bridge]', String(m).slice(0,150)) });
try {
  const r = await hook.api('/SendVoiceMsg', { wxidorgid: '47390425951@chatroom', path: 'C:\\temp\\voice_now.silk', str0Mode: 'bytes', durationMs: 4000 }, 'POST', 30000);
  console.log('OK:', JSON.stringify(r).slice(0, 250));
} catch (e) {
  console.log('ERR:', e.message, '| cause:', e.cause ? String(e.cause) : 'none');
}
process.exit(0);
