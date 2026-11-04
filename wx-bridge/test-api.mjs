// 用 bridge 的 api() 测试（模拟 bridge 内部）
import { WeChatHook } from './lib/wechat-hook.mjs';
const hook = new WeChatHook({ apiPort: 30001, cbPort: 18998, wechat: 'D:\\wxhook\\wx4110\\Weixin.exe' });
try {
  const r = await hook.api('/SendVoiceMsg', { wxidorgid: '47390425951@chatroom', path: 'C:\\temp\\test_voice3.silk', str0Mode: 'bytes', durationMs: 2220 }, 'POST', 30000);
  console.log('OK:', JSON.stringify(r).slice(0, 200));
} catch (e) {
  console.log('ERR:', e.message, '| cause:', e.cause ? String(e.cause) : 'none');
}
process.exit(0);
