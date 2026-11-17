# -*- coding: utf-8 -*-
"""
B 站搜索（wbi 签名版）—— 不依赖浏览器 cookie、不需要登录

原理：B 站 2023 年后给 web 接口加了 wbi 签名：
  ① GET /x/web-interface/nav 拿 img_key / sub_key
  ② 按固定 64 位重排表把两个 key 混成 mixin_key，取前 32 位
  ③ 参数按字典序拼成 query + wts 时间戳，md5(query + mixin_key) = w_rid
"""
import hashlib
import json
import time
import urllib.parse
import urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

MIXIN_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
    11, 36, 20, 34, 44, 52,
]


def _get(url, cookie=None):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com',
        **({'Cookie': cookie} if cookie else {}),
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8')), r.headers.get_all('Set-Cookie') or []


def _mixin_key(img_key, sub_key):
    raw = img_key + sub_key
    return ''.join(raw[i] for i in MIXIN_TABLE)[:32]


def search(keyword, limit=8):
    # ① 先访问首页拿 buvid（没有它接口会 412）
    cookie = ''
    try:
        req = urllib.request.Request('https://www.bilibili.com', headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            scs = r.headers.get_all('Set-Cookie') or []
        jar = {}
        for sc in scs:
            k, _, v = sc.split(';')[0].partition('=')
            jar[k.strip()] = v.strip()
        cookie = '; '.join('%s=%s' % (k, v) for k, v in jar.items())
    except Exception as e:
        print('  ⚠️ 首页 cookie 获取失败：%s' % str(e)[:60])

    # ② 拿 wbi 密钥
    nav, _ = _get('https://api.bilibili.com/x/web-interface/nav', cookie)
    wbi = (nav.get('data') or {}).get('wbi_img') or {}
    img = (wbi.get('img_url') or '').rsplit('/', 1)[-1].split('.')[0]
    sub = (wbi.get('sub_url') or '').rsplit('/', 1)[-1].split('.')[0]
    if not img or not sub:
        raise SystemExit('拿不到 wbi 密钥：%s' % json.dumps(nav)[:200])
    mixin = _mixin_key(img, sub)

    # ③ 签名
    params = {
        'search_type': 'video',
        'keyword': keyword,
        'page': 1,
        'page_size': limit,
        'wts': int(time.time()),
    }
    query = urllib.parse.urlencode(
        {k: str(v) for k, v in sorted(params.items())},
        quote_via=urllib.parse.quote)
    w_rid = hashlib.md5((query + mixin).encode('utf-8')).hexdigest()
    url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?' + query + '&w_rid=' + w_rid

    # 带 cookie 有时反而触发风控（返回空），失败就不带 cookie 再试一次
    data, _ = _get(url, cookie)
    res = (data.get('data') or {}).get('result') or []
    if not res:
        data2, _ = _get(url, None)
        if (data2.get('data') or {}).get('result'):
            data = data2
            res = data2['data']['result']
    if data.get('code') != 0:
        raise SystemExit('搜索失败 code=%s %s' % (data.get('code'), data.get('message')))
    if not res:
        raise SystemExit('搜索返回空（可能被限流），稍后再试')
    out = []
    for r in res:
        title = (r.get('title') or '')
        for tag in ('<em class="keyword">', '</em>'):
            title = title.replace(tag, '')
        out.append({
            'bvid': r.get('bvid'),
            'title': title,
            'duration': r.get('duration'),
            'author': r.get('author'),
            'play': r.get('play'),
        })
    return out


if __name__ == '__main__':
    import sys
    kw = sys.argv[1] if len(sys.argv) > 1 else '雨爱 司凤'
    print('  搜索：%s' % kw)
    for i, r in enumerate(search(kw), 1):
        print('  %d. %-13s %5ss  播放%-8s %s' % (i, r['bvid'], r['duration'], r['play'], r['title'][:40]))
