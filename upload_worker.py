#!/usr/bin/env python3
"""把 /tmp/ts_worker.js 上传到 Cloudflare，附带 TR_KV 绑定。

service-worker 格式脚本要带绑定必须走 multipart/form-data：
  metadata 段 = {"body_part":"script","bindings":[...]}
  script   段 = 脚本正文
单文件 PUT（Content-Type: application/javascript）无法携带 bindings，
所以 deploy.sh 改用本脚本。
"""
import json
import os
import subprocess
import sys
import uuid

SCRIPT = '/tmp/ts_worker.js'
NAME = os.environ.get('WORKER_NAME', 'trendshift-lite')
KV_ID = os.environ.get('TR_KV_ID', '6a486ed588b24fb889fbd459668a5341')


def main():
    acc = os.environ.get('CF_ACCOUNT_ID')
    tok = os.environ.get('CF_API_TOKEN')
    if not acc or not tok:
        print('缺少 CF_ACCOUNT_ID / CF_API_TOKEN')
        return 1

    body_js = open(SCRIPT, 'rb').read()
    metadata = {
        'body_part': 'script',
        'bindings': [
            {'type': 'kv_namespace', 'name': 'TR_KV', 'namespace_id': KV_ID},
        ],
        'compatibility_date': '2024-11-01',
    }

    boundary = '----ts' + uuid.uuid4().hex
    parts = [
        ('--%s\r\nContent-Disposition: form-data; name="metadata"\r\n'
         'Content-Type: application/json\r\n\r\n%s\r\n'
         % (boundary, json.dumps(metadata))).encode(),
        ('--%s\r\nContent-Disposition: form-data; name="script"; filename="script.js"\r\n'
         'Content-Type: application/javascript\r\n\r\n' % boundary).encode(),
        body_js,
        ('\r\n--%s--\r\n' % boundary).encode(),
    ]
    open('/tmp/_up.bin', 'wb').write(b''.join(parts))

    url = ('https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s'
           % (acc, NAME))
    r = subprocess.run([
        'curl', '-s', '--noproxy', '*', '-m', '180', '-X', 'PUT', url,
        '-H', 'Authorization: Bearer ' + tok,
        '-H', 'Content-Type: multipart/form-data; boundary=' + boundary,
        '--data-binary', '@/tmp/_up.bin',
    ], capture_output=True, text=True)

    try:
        d = json.loads(r.stdout)
    except Exception:
        print('上传返回非 JSON：', r.stdout[:300])
        return 1

    if not d.get('success'):
        print('上传失败：', json.dumps(d.get('errors'), ensure_ascii=False)[:400])
        return 1

    res = d.get('result') or {}
    print('上传成功 id=%s modified=%s' % (res.get('id'), res.get('modified_on')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
