# -*- coding: utf-8 -*-
"""生成 RVC 训练所需的 config.json 与 filelist.txt（webui 里由界面代劳）"""
import io
import json
import os

RVC = r'E:\rvc\RVC'
EXP = os.environ.get('RVC_EXP', 'her')
EXP_DIR = os.path.join(RVC, 'logs', EXP)
SR = '40k'
VERSION = 'v2'                 # 768 维 HuBERT 特征
FEAT_DIM = '768'

# ① config.json：40k 只有 v1/40k.json（webui 的取法：sr=="40k" 就用 v1/40k.json）
src = os.path.join(RVC, 'configs', 'v1', '%s.json' % SR)
dst = os.path.join(EXP_DIR, 'config.json')
cfg = json.loads(io.open(src, encoding='utf-8').read())
cfg.pop('speaker_info', None)
io.open(dst, 'w', encoding='utf-8').write(json.dumps(cfg, ensure_ascii=False, indent=1))
print('  config.json  ← %s' % src)

# ② filelist.txt：每行 "gt_wav|feature|f0|f0nsf"
gt = os.path.join(EXP_DIR, '0_gt_wavs')
feat_dir = os.path.join(EXP_DIR, '3_feature%s' % FEAT_DIM)
f0_dir = os.path.join(EXP_DIR, '2a_f0')
nsf_dir = os.path.join(EXP_DIR, '2b-f0nsf')

rows = []
for f in sorted(os.listdir(gt)):
    if not f.endswith('.wav'):
        continue
    base = f[:-4]                     # 0_1
    feat = os.path.join(feat_dir, base + '.npy')
    f0 = os.path.join(f0_dir, base + '.wav.npy')
    nsf = os.path.join(nsf_dir, base + '.wav.npy')
    if not (os.path.exists(feat) and os.path.exists(f0) and os.path.exists(nsf)):
        continue
    # 5 个字段：wav|特征|f0|f0nsf|说话人id（单说话人写 0）
    rows.append('%s|%s|%s|%s|0' % (os.path.join(gt, f), feat, f0, nsf))

dst2 = os.path.join(EXP_DIR, 'filelist.txt')
io.open(dst2, 'w', encoding='utf-8').write('\n'.join(rows))
print('  filelist.txt ← %d 条（要求 4 个文件齐全）' % len(rows))
if not rows:
    raise SystemExit('没有可训练样本，检查切片/特征目录')
print('  样例: ' + rows[0][:150])
