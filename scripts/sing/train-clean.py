# -*- coding: utf-8 -*-
"""
RVC 训练：干净重建流水线（2026-11-18）

为什么需要这个脚本（踩坑记录）
① preprocess 用 per=3.0 切 TTS 短句，产生大量 0.5~0.7 秒碎尾
   → 训练在 slice_segments 崩：expanded size 12800 must match existing 11200
② 只删 wav 不删对应 feature/f0 会导致"同名不同源"
   → 崩成 12800 vs 8000（更隐蔽）
③ 所以必须：清空 → 切分(per 更大) → 立刻瘦身 → 抽 f0/特征 → 再瘦身 → 训练 → 建索引

用法：
  E:\\rvc\\venv-rvc\\Scripts\\python.exe train-clean.py her3 E:/rvc/tts-corpus/wav 300 12
"""
import os
import shutil
import subprocess
import sys

PY = r'E:\rvc\venv-rvc\Scripts\python.exe'
ROOT = r'E:\rvc\RVC'
LOG = r'D:\微信deepseek\data\prune-short-slices.py'

EXP = sys.argv[1] if len(sys.argv) > 1 else 'her3'
DATA = sys.argv[2] if len(sys.argv) > 2 else 'E:/rvc/tts-corpus/wav'
EPOCHS = sys.argv[3] if len(sys.argv) > 3 else '300'
PER = sys.argv[4] if len(sys.argv) > 4 else '12'

EXP_DIR = os.path.join(ROOT, 'logs', EXP)
RAW_DIR = os.path.join(ROOT, 'raw', EXP)


def run(args, cwd=ROOT):
    print('  $ ' + ' '.join(args), flush=True)
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                       encoding='utf-8', errors='replace',
                       env={**os.environ, 'PYTHONPATH': ROOT, 'PYTHONIOENCODING': 'utf-8'})
    out = (r.stdout or '') + (r.stderr or '')
    for line in out.strip().splitlines()[-4:]:
        print('    | ' + line[:150], flush=True)
    if r.returncode != 0:
        print('    ✗ 退出码 %s' % r.returncode, flush=True)
        sys.exit(r.returncode)
    print('    ✓ 用时完成', flush=True)


def main():
    # ① 清空旧的预处理产物（只留 config/filelist 会重建）
    for d in ['0_gt_wavs', '1_16k_wavs', '2a_f0', '2b-f0nsf', '3_feature768', 'eval']:
        p = os.path.join(EXP_DIR, d)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
            print('  清空 ' + d)
    for f in ['filelist.txt']:
        p = os.path.join(EXP_DIR, f)
        if os.path.exists(p):
            os.remove(p)

    # ② 素材汇入 raw
    if os.path.isdir(RAW_DIR):
        shutil.rmtree(RAW_DIR, ignore_errors=True)
    os.makedirs(RAW_DIR, exist_ok=True)
    n = 0
    for root, _, files in os.walk(DATA):
        for fn in files:
            if fn.lower().endswith('.wav'):
                shutil.copy2(os.path.join(root, fn), os.path.join(RAW_DIR, fn))
                n += 1
    print('  素材 %d 个 → %s' % (n, RAW_DIR))

    # ③ 切分（per 放大：TTS 短句基本不再二次切碎）
    print('═══ 切分（per=%s 秒）═══' % PER)
    run([PY, '-m', 'train.preprocess', RAW_DIR, '40000', '4', EXP_DIR, 'True', PER])

    # ④ 立刻瘦身（删碎尾 + 重建 filelist）
    print('═══ 瘦身 ═══')
    run([PY, LOG, EXP, '2.5'])

    # ⑤ 抽 f0 / 特征（只处理瘦身后剩下的）
    print('═══ 抽音高 ═══')
    run([PY, '-m', 'train.dataset.extract_f0', 'cuda', '1', '0', '0', EXP_DIR, 'True'])
    print('═══ 抽特征 ═══')
    run([PY, '-m', 'train.dataset.extract_hubert_feature', 'cuda:0', '1', '0', EXP_DIR, 'v2', 'True'])

    # ⑥ 再瘦身（确保 4 个文件齐全且同源）
    print('═══ 复核瘦身 ═══')
    run([PY, LOG, EXP, '2.5'])

    # ⑦ 训练
    print('═══ 训练 %s 轮 ═══' % EPOCHS)
    run([PY, '-m', 'train.train', '-e', EXP, '-sr', '40k', '-f0', '1', '-bs', '4', '-g', '0',
         '-te', EPOCHS, '-se', '50', '-pg', 'assets/pretrained_v2/f0G40k.pth',
         '-pd', 'assets/pretrained_v2/f0D40k.pth', '-l', '1', '-c', '0', '-sw', '1', '-v', 'v2'])

    # ⑧ 建索引
    print('═══ 建索引 ═══')
    run([PY, '-m', 'train.train_index', EXP, 'v2', os.path.join(ROOT, 'logs'), '4'])
    print('  完成：%s' % os.path.join(ROOT, 'assets', 'weights', EXP + '.pth'))


if __name__ == '__main__':
    main()
