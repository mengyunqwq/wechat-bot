# -*- coding: utf-8 -*-
"""
清掉过短的训练切片（RVC 训练遇到 <2.5 秒的切片会崩：
  slice_segments: expanded size 12800 must match existing size 11200）

2026-11-18：TTS 语料句子短（3~6 秒），preprocess 按 per=3.0 切完产生一堆
0.5~0.7 秒的尾巴，414 片里 232 片太短 → 训练跑到一半崩。

做法：删除过短切片在 4 个目录里的所有对应文件，然后重新生成 filelist。
用法：python prune-short-slices.py [exp] [最短秒数]
"""
import glob
import os
import sys

import librosa

EXP = sys.argv[1] if len(sys.argv) > 1 else 'her3'
MIN_SEC = float(sys.argv[2]) if len(sys.argv) > 2 else 2.5
ROOT = r'E:\rvc\RVC\logs\%s' % EXP

DIRS = {
    'gt': os.path.join(ROOT, '0_gt_wavs'),
    'feat': os.path.join(ROOT, '3_feature768'),
    'f0': os.path.join(ROOT, '2a_f0'),
    'f0nsf': os.path.join(ROOT, '2b-f0nsf'),
}


def main():
    wavs = sorted(glob.glob(os.path.join(DIRS['gt'], '*.wav')))
    if not wavs:
        raise SystemExit('没有切片：' + DIRS['gt'])

    keep, drop = [], []
    for w in wavs:
        d = librosa.get_duration(path=w)
        (keep if d >= MIN_SEC else drop).append((w, d))

    print('  总切片 %d，保留 %d，删除 %d（<%0.1f 秒）' % (len(wavs), len(keep), len(drop), MIN_SEC))

    removed = 0
    for w, d in drop:
        stem = os.path.splitext(os.path.basename(w))[0]
        for key, path in [
            (None, w),
            ('feat', os.path.join(DIRS['feat'], stem + '.npy')),
            ('f0', os.path.join(DIRS['f0'], stem + '.wav.npy')),
            ('f0nsf', os.path.join(DIRS['f0nsf'], stem + '.wav.npy')),
        ]:
            try:
                if os.path.exists(path):
                    os.remove(path)
                    removed += 1
            except Exception as e:
                print('    删除失败 %s：%s' % (path, e))
    print('  已删除文件 %d 个' % removed)

    # 重新生成 filelist.txt（4 个文件齐全的才写）
    fl = os.path.join(ROOT, 'filelist.txt')
    n = 0
    with open(fl, 'w', encoding='utf-8') as fh:
        for w, _ in keep:
            stem = os.path.splitext(os.path.basename(w))[0]
            a = os.path.join(DIRS['feat'], stem + '.npy')
            b = os.path.join(DIRS['f0'], stem + '.wav.npy')
            c = os.path.join(DIRS['f0nsf'], stem + '.wav.npy')
            if all(os.path.exists(p) for p in (w, a, b, c)):
                fh.write('%s|%s|%s|%s|0\n' % (w, a, b, c))
                n += 1
    print('  filelist.txt 重建：%d 条' % n)


if __name__ == '__main__':
    main()
