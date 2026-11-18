# -*- coding: utf-8 -*-
"""对比两个 RVC 模型：同一段人声，分别看「像 TTS 生产音色」还是「像真实录音」"""
import os
import subprocess
import sys

sys.path.insert(0, r'D:\微信deepseek\data')
import importlib.util as _u

_spec = _u.spec_from_file_location('ev', r'D:\微信deepseek\data\rvc-eval.py')
m = _u.module_from_spec(_spec)
_spec.loader.exec_module(m)

RVC_PY = r'E:\rvc\venv-rvc\Scripts\python.exe'
RVC_ROOT = r'E:\rvc\RVC'
WORK = r'E:\挖漏洞\tools\tmp\rvc-eval-kkxth713'
CLIP = os.path.join(WORK, 'clip.wav')


def conv(model, index, out, pitch=1):
    cmd = [RVC_PY, '-m', 'infer.cli', '--model', model, '--input', CLIP, '--output', out,
           '--pitch', str(pitch), '--f0-method', 'rmvpe',
           '--rms-mix-rate', '0.25', '--protect', '0.33']
    if index:
        cmd += ['--index', index, '--index-rate', '0.85']
    else:
        cmd += ['--index-rate', '0']   # 没索引时必须 0，否则 infer.cli 直接报错
    cmd += ['--overwrite']
    r = subprocess.run(cmd, cwd=RVC_ROOT, capture_output=True, text=True,
                       env={**os.environ, 'PYTHONPATH': RVC_ROOT})
    return r.returncode


def main():
    tts_v, tts_f0, tts_c = m.ref_feats(r'E:\rvc\tts-corpus\wav')
    real_v, real_f0, real_c = m.ref_feats(r'E:\rvc\dataset-her')
    print('  参考·TTS生产音色  F0 %.0f  质心 %.0f' % (tts_f0, tts_c))
    print('  参考·真实录音     F0 %.0f  质心 %.0f' % (real_f0, real_c))
    print()
    print('  %-24s %9s %9s %8s %7s' % ('模型', '像TTS', '像真实', 'F0', '质心'))
    print('  ' + '-' * 62)

    models = [
        ('her2 真实录音训', r'E:\rvc\RVC\assets\weights\her2.pth',
         r'E:\rvc\RVC\logs\her2\added_IVF289_Flat_nprobe_1_her2_v2.index'),
    ]
    # 把 her3 的检查点都列进来（可能已有 e50/e100/...）
    import glob
    for p in sorted(glob.glob(r'E:\rvc\RVC\assets\weights\her3*.pth')):
        models.append((os.path.basename(p), p, None))

    for tag, model, idx in models:
        out = os.path.join(WORK, 'cmp_' + tag.split()[0].replace('.pth', '') + '.wav')
        rc = conv(model, idx, out)
        if rc != 0:
            print('  %-24s 转换失败 rc=%s' % (tag, rc))
            continue
        v, f0, c = m.feats(out)
        print('  %-24s %9.4f %9.4f %8.1f %7.0f' % (tag, m.cos(v, tts_v), m.cos(v, real_v), f0, c))
        print('      试听: ' + out)


if __name__ == '__main__':
    main()
