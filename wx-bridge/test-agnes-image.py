"""实测 Agnes 文生图/图生图：以用户给的参考图为主体生成一张表情包。

密钥从 ~/.dsh/.credentials.yaml 读，不硬编码。
"""
import base64
import json
import os
import re
import sys

import requests

CRED = os.path.join(os.environ["USERPROFILE"], ".dsh", ".credentials.yaml")
REF = r"D:\微信deepseek\data\stickers\ref\main.jpg"
OUT_DIR = r"D:\微信deepseek\data\stickers\import"
API = "https://apihub.agnes-ai.com/v1/images/generations"


def api_key():
    with open(CRED, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"\s*AGNES_API_KEY:\s*(\S+)", line)
            if m:
                return m.group(1).strip()
    raise SystemExit("找不到 AGNES_API_KEY")


def main():
    key = api_key()
    print("key:", key[:12] + "..." + key[-4:])

    with open(REF, "rb") as f:
        ref_b64 = base64.b64encode(f.read()).decode()
    print("参考图:", REF, os.path.getsize(REF), "字节 → base64", len(ref_b64), "字符")

    prompt = (
        "以参考图中的角色为主体（严格保持它的外观、配色、造型、画风不变），"
        "画一张聊天用的表情包：角色开心大笑、眼睛弯起来、有得意的神情；"
        "纯白色干净背景，Q 版贴纸风格，粗描边，主体居中，四周留白，不要文字。"
    )
    payload = {
        "model": "agnes-image-2.1-flash",
        "prompt": prompt,
        "size": "1K",
        "ratio": "1:1",
        "extra_body": {
            "image": [f"data:image/jpeg;base64,{ref_b64}"],
            "response_format": "url",
        },
    }
    print("请求中（图生图，最长等 180s）...")
    r = requests.post(API, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                      json=payload, timeout=180)
    print("HTTP", r.status_code)
    try:
        data = r.json()
    except Exception:
        print(r.text[:800]); return 1
    print(json.dumps(data, ensure_ascii=False)[:600])

    url = (data.get("data") or [{}])[0].get("url")
    if not url:
        print("没有拿到 url"); return 2
    print("图片 URL:", url)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "agnes-test-开心.jpg")
    img = requests.get(url, timeout=120).content
    with open(out, "wb") as f:
        f.write(img)
    print("已保存:", out, len(img), "字节")
    return 0


if __name__ == "__main__":
    sys.exit(main())
