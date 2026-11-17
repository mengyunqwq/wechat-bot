# -*- coding: utf-8 -*-
"""
把 RVC 训练检查点（G_xxx.pth）转成推理模型（assets/weights/her.pth）

为什么需要：train.py 训练结束时调用 savee() 存到 assets/weights/，
但那个目录由 webui 启动时创建——我们走 CLI，目录不存在 → 保存失败。
检查点本身完好（G_2333333.pth 417MB），照 savee 的逻辑复刻一遍即可。
"""
import json
import os
import sys
from collections import OrderedDict

import torch

RVC = r'E:\rvc\RVC'
EXP = 'her'
CKPT = os.path.join(RVC, 'logs', EXP, 'G_2333333.pth')
CONFIG = os.path.join(RVC, 'logs', EXP, 'config.json')
OUT_DIR = os.path.join(RVC, 'assets', 'weights')
OUT = os.path.join(OUT_DIR, '%s.pth' % EXP)

os.makedirs(OUT_DIR, exist_ok=True)

print('  读取检查点: %s' % CKPT)
ckpt = torch.load(CKPT, map_location='cpu')
print('  字段: %s' % list(ckpt.keys())[:6])

cfg = json.load(open(CONFIG, encoding='utf-8'))
d, m = cfg['data'], cfg['model']

weight = ckpt['weight'] if 'weight' in ckpt else ckpt['model']
opt = OrderedDict()
opt['weight'] = {}
for k in weight.keys():
    if 'enc_q' in k:
        continue
    opt['weight'][k] = weight[k].half()

opt['config'] = [
    d['filter_length'] // 2 + 1, 32,
    m['inter_channels'], m['hidden_channels'], m['filter_channels'],
    m['n_heads'], m['n_layers'], m['kernel_size'], m['p_dropout'],
    m['resblock'], m['resblock_kernel_sizes'], m['resblock_dilation_sizes'],
    m['upsample_rates'], m['upsample_initial_channel'], m['upsample_kernel_sizes'],
    m['spk_embed_dim'], m['gin_channels'], d['sampling_rate'],
]
opt['info'] = '200epoch'
opt['sr'] = '40k'
opt['f0'] = 1
opt['version'] = 'v2'

torch.save(opt, OUT)
print('  已写出: %s（%.1f MB）' % (OUT, os.path.getsize(OUT) / 1048576))

# 顺手清掉 817MB 的判别器检查点（推理用不到，省空间）
dpath = os.path.join(RVC, 'logs', EXP, 'D_2333333.pth')
if os.path.exists(dpath):
    os.remove(dpath)
    print('  已删除判别器检查点 D_2333333.pth（817MB，推理不需要）')
