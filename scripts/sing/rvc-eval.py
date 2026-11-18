# -*- coding: utf-8 -*-
"""
RVC 参数评测（librosa 版，不依赖 speechbrain）

指标：
  MFCC相似  MFCC(20 维 均值+方差) 余弦相似度 —— 越高越像同一个人（音色包络）
  F0(Hz)    输出中位基频 —— 她的真声基准 309 Hz
  质心      频谱质心 —— 她的真声约 1893 Hz（太亮/太闷都能看出来）

用法：
  E:\\rvc\\venv-rvc\\Scripts\\python.exe rvc-eval.py <源人声wav> [--ref E:\\rvc\\dataset-her]
"""
import argparse
import glob
import json
import math
import os
import subprocess
import tempfile

import librosa
import numpy as np

RVC_PY = r'E:\rvc\venv-rvc\Scripts\python.exe'
RVC_ROOT = r'E:\rvc\RVC'
MODEL = r'E:\rvc\RVC\assets\weights\her2.pth'
INDEX = r'E:\rvc\RVC\logs\her2\added_IVF289_Flat_nprobe_1_her2_v2.index'
HER_F0 = 309.0

VARIANTS = [
    ('A 当前', dict(index_rate=0.75, rms_mix_rate=1.0, protect=0.33)),
    ('B index0.85 rms0.25', dict(index_rate=0.85, rms_mix_rate=0.25, protect=0.33)),
    ('C index0.92', dict(index_rate=0.92, rms_mix_rate=0.25, protect=0.33)),
    ('D index0.92 protect0.25', dict(index_rate=0.92, rms_mix_rate=0.25, protect=0.25)),
    ('E index0.95 rms0.10', dict(index_rate=0.95, rms_mix_rate=0.10, protect=0.33)),
]


def feats(path):
    y, sr = librosa.load(path, sr=22050, mono=True)
    if len(y) < sr:
        y = np.pad(y, (0, sr - len(y)))
    y = y[:sr * 20]
    m = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
    vec = np.concatenate([m.mean(axis=1), m.std(axis=1)])
    try:
        f0 = librosa.yin(y, fmin=80, fmax=900, sr=sr)
        f0 = f0[np.isfinite(f0) & (f0 > 0)]
        f0m = float(np.median(f0)) if len(f0) else 0.0
    except Exception:
        f0m = 0.0
    cen = float(np.median(librosa.feature.spectral_centroid(y=y, sr=sr)))
    return vec, f0m, cen


def cos(a, b):
    a = a - a.mean()
    b = b - b.mean()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def ref_feats(ref_dir):
    files = sorted(glob.glob(os.path.join(ref_dir, '*.wav')))
    if not files:
        raise SystemExit('参考素材为空：' + ref_dir)
    vs, f0s, cs = [], [], []
    for f in files[:30]:
        try:
            v, f0, c = feats(f)
            vs.append(v)
            if f0 > 0:
                f0s.append(f0)
            cs.append(c)
        except Exception:
            continue
    return (np.mean(vs, axis=0),
            float(np.median(f0s)) if f0s else 0.0,
            float(np.median(cs)) if cs else 0.0)


def convert(src, dst, pitch, p):
    cmd = [RVC_PY, '-m', 'infer.cli', '--model', MODEL, '--input', src, '--output', dst,
           '--pitch', str(pitch), '--f0-method', 'rmvpe',
           '--index-rate', str(p['index_rate']),
           '--rms-mix-rate', str(p['rms_mix_rate']),
           '--protect', str(p['protect']),
           '--index', INDEX, '--overwrite']
    r = subprocess.run(cmd, cwd=RVC_ROOT, capture_output=True, text=True,
                       env={**os.environ, 'PYTHONPATH': RVC_ROOT})
    if r.returncode != 0:
        raise RuntimeError(('rc=%s ' % r.returncode) + (r.stderr or r.stdout or '')[-240:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--ref', default=r'E:\rvc\dataset-her')
    ap.add_argument('--secs', type=int, default=14)
    ap.add_argument('--start', type=int, default=25)
    ap.add_argument('--pitch', type=float, default=None)
    a = ap.parse_args()

    work = tempfile.mkdtemp(prefix='rvc-eval-')
    clip = os.path.join(work, 'clip.wav')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(a.start), '-t', str(a.secs),
                    '-i', a.src, '-ar', '40000', '-ac', '1', clip], check=True)

    rv, rf0, rc = ref_feats(a.ref)
    n = min(30, len(glob.glob(os.path.join(a.ref, '*.wav'))))
    print('  参考（真实录音 %d 条）：F0 %.0f Hz，质心 %.0f Hz' % (n, rf0, rc))

    sv, sf0, sc = feats(clip)
    print('  源人声：F0 %.0f Hz，质心 %.0f Hz' % (sf0, sc))
    pitch = a.pitch
    if pitch is None:
        pitch = 12 * math.log2(HER_F0 / sf0) if sf0 > 0 else 0
    pitch = int(round(pitch))
    print('  移调 %+d 半音（目标 %.0f Hz）' % (pitch, HER_F0))
    print()
    print('  %-24s %6s %6s %9s %8s %7s' % ('参数组', 'index', 'rms', 'MFCC相似', 'F0(Hz)', '质心'))
    print('  ' + '-' * 68)

    rows = []
    for name, p in VARIANTS:
        out = os.path.join(work, name.split()[0] + '.wav')
        try:
            convert(clip, out, pitch, p)
            v, f0, c = feats(out)
            sim = cos(v, rv)
            rows.append({'name': name, 'params': p, 'mfcc': sim, 'f0': f0, 'centroid': c})
            print('  %-24s %6.2f %6.2f %9.4f %8.1f %7.0f' % (
                name, p['index_rate'], p['rms_mix_rate'], sim, f0, c))
        except Exception as e:
            print('  %-24s 失败：%s' % (name, str(e)[:70]))

    if rows:
        best = max(rows, key=lambda r: r['mfcc'])
        print()
        print('  MFCC 相似度最优：%s（%.4f）' % (best['name'], best['mfcc']))
        print('  试听文件：' + work)
        with open(os.path.join(work, 'result.json'), 'w', encoding='utf-8') as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
