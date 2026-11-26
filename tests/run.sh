#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

python3 -m py_compile cloud_sync.py build_worker.py upload_worker.py tests/test_kv_guard.py
python3 tests/test_kv_guard.py
python3 build_worker.py
node tests/test_regressions.js
node tests/test_noise.js
node tests/test_radar.js
node tests/test_default_tab.js
node tests/test_snapshot_key.js
node tests/test_tr_contract.js
node tests/test_worker_runtime.js
