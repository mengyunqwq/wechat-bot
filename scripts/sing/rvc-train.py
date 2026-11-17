# -*- coding: utf-8 -*-
"""
RVC 训练流水线（为「大肥鱼」训练她的歌声模型）

数据来源：
  · E:\\rvc\\dataset-her   57 段 / 4.63 分钟（原始录音，demucs 分离过）
  · E:\\rvc\\tts-corpus\\wav 184 段 / 8.9 分钟（云端 TTS 生成，干净无噪）
  → 合计约 13.5 分钟（RVC 建议 10 分钟以上）

四个阶段（对应 RVC 的四个脚本）：
  1. preprocess   切分 + 重采样到 40k
  2. extract_f0   rmvpe 抽音高（歌声必须要 f0）
  3. hubert       抽特征向量
  4. train        训练 f0G40k/f0D40k（8GB 用 bs=4）
  5. train_index  建检索索引（RVC 的"检索增强"，音色更像）

用法：
  python rvc-train.py --dry         # 只打印将执行的命令
  python rvc-train.py --stage 1     # 只跑到第 N 阶段
  python rvc-train.py               # 全跑
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

RVC = r'E:\rvc\RVC'
PY = r'E:\rvc\venv-rvc\Scripts\python.exe'
EXP = os.environ.get('RVC_EXP', 'her')
SR = '40000'          # f0G40k 对应 40k
BS = '4'              # 8GB 显存：batch size 4（再大容易 OOM）
EPOCHS = os.environ.get('RVC_EPOCHS', '200')
SAVE_EVERY = '50'
SR_TAG = '40k'

DATASETS = os.environ.get('RVC_DATASETS', 'E:/rvc/dataset-her|E:/rvc/tts-corpus/wav').split('|')
EXP_DIR = os.path.join(RVC, 'logs', EXP)
RAW_DIR = os.path.join(RVC, 'raw', EXP)


def sh(cmd, cwd=RVC, dry=False, log=None):
    printable = ' '.join('"%s"' % c if ' ' in str(c) else str(c) for c in cmd)
    print('  $ ' + printable[:160])
    if dry:
        return 0
    t0 = time.time()
    # RVC 的脚本 import infer.xxx，必须把仓库根放进 PYTHONPATH
    env = dict(os.environ)
    env['PYTHONPATH'] = RVC + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    env['PYTHONIOENCODING'] = 'utf-8'
    p = subprocess.run(cmd, cwd=cwd, env=env)
    print('    退出码 %d，用时 %.1f 分钟' % (p.returncode, (time.time() - t0) / 60))
    if p.returncode != 0:
        raise SystemExit('阶段失败，停在上面那条命令')
    return p.returncode


def collect_raw():
    """把两处素材汇到 RVC/raw/her（preprocess 的输入目录）"""
    os.makedirs(RAW_DIR, exist_ok=True)
    n = 0
    for d in DATASETS:
        if not os.path.isdir(d):
            print('  ⚠️ 素材目录不存在：' + d)
            continue
        for f in sorted(os.listdir(d)):
            if not f.lower().endswith('.wav'):
                continue
            tag = 'orig' if 'dataset-her' in d else 'tts'
            dst = os.path.join(RAW_DIR, '%s_%s' % (tag, f))
            if not os.path.exists(dst):
                shutil.copy2(os.path.join(d, f), dst)
            n += 1
    print('  素材汇总到 %s（%d 个 wav）' % (RAW_DIR, n))
    return n


def stage1_preprocess(dry):
    print('\n═══ 阶段 1：切分 + 重采样 40k ═══')
    sh([PY, '-m', 'train.preprocess', RAW_DIR, SR, '4', EXP_DIR, 'True', '3.0'], dry=dry)   # per = 每段切片秒数（必须 >0，0 会让切片长度算成负数）


def stage2_f0(dry):
    print('\n═══ 阶段 2：抽音高（rmvpe，GPU）═══')
    sh([PY, '-m', 'train.dataset.extract_f0', 'cuda', '1', '0', '0', EXP_DIR, 'True'], dry=dry)


def stage3_hubert(dry):
    print('\n═══ 阶段 3：抽 HuBERT 特征（GPU）═══')
    sh([PY, '-m', 'train.dataset.extract_hubert_feature', 'cuda:0', '1', '0', EXP_DIR, 'v2', 'True'], dry=dry)


def stage4_train(dry):
    print('\n═══ 阶段 4：训练（bs=%s, epochs=%s）═══' % (BS, EPOCHS))
    sh([PY, '-m', 'train.train',
        '-e', EXP, '-sr', SR_TAG, '-f0', '1', '-bs', BS, '-g', '0',
        '-te', EPOCHS, '-se', SAVE_EVERY,
        '-pg', 'assets/pretrained_v2/f0G40k.pth',
        '-pd', 'assets/pretrained_v2/f0D40k.pth',
        '-l', '1', '-c', '0', '-sw', '1', '-v', 'v2'], dry=dry)


def stage5_index(dry):
    print('\n═══ 阶段 5：建检索索引 ═══')
    sh([PY, '-m', 'train.train_index', EXP, 'v2', os.path.join(RVC, 'logs'), '4'], dry=dry)


def report():
    wdir = os.path.join(EXP_DIR, '0_gt_wavs')
    n = len(os.listdir(wdir)) if os.path.isdir(wdir) else 0
    print('\n═══ 产物 ═══')
    print('  切片文件: %d 个（%s）' % (n, wdir))
    w = os.path.join(EXP_DIR, 'weight')
    if os.path.isdir(w):
        for f in sorted(os.listdir(w)):
            p = os.path.join(w, f)
            print('  模型: %-40s %.1f MB' % (f, os.path.getsize(p) / 1048576))
    idx = os.path.join(EXP_DIR, 'added_IVF834_Flat_nprobe_1_%s_v2.index' % EXP)
    print('  索引: %s' % ('已生成' if os.path.exists(idx) else '未生成'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--stage', type=int, default=5)
    ap.add_argument('--skip-collect', action='store_true')
    args = ap.parse_args()

    print('  RVC 目录: %s' % RVC)
    print('  Python:   %s' % PY)
    if not os.path.exists(PY):
        raise SystemExit('venv 不存在：' + PY)

    if not args.skip_collect:
        collect_raw()
    os.makedirs(EXP_DIR, exist_ok=True)

    steps = [(1, stage1_preprocess), (2, stage2_f0), (3, stage3_hubert),
             (4, stage4_train), (5, stage5_index)]
    for i, fn in steps:
        if i > args.stage:
            break
        fn(args.dry)

    if not args.dry:
        report()


if __name__ == '__main__':
    main()
