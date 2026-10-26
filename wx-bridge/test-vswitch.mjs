import { WeChatHookBridge } from './lib/wechat-hook.mjs';
const hook = new WeChatHookBridge({ apiPort: 30001, wechatExe: 'D:\\wxhook\\wx4110\\Weixin.exe', log: (m) => console.log('[b]', String(m).slice(0,100)) });
try {
  // 查询语音开关
  const q = await hook.voiceSendSwitch();
  console.log('voiceSwitch 状态:', JSON.stringify(q));
} catch (e) { console.log('ERR:', e.message); }
process.exit(0);
