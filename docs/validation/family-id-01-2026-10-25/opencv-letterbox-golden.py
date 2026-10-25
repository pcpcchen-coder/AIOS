# 產生 tests/fixtures/face-letterbox-opencv-golden.json：OpenCV cv2.resize（INTER_LINEAR）的參考輸出，
# 給 src/sense/face/yunet.ts 的 letterboxToChw 比對。需要 opencv-python-headless 5.0.0.93 與 numpy 2.5.4
# （同 ../family-id-00-spike-2026-10-24/requirements.txt）。以 python -I 執行：
#   python -I opencv-letterbox-golden.py <輸出 json>
import json, sys
import numpy as np
import cv2

rng = np.random.default_rng(20261025)
cases = []
# (來源寬, 來源高, 輸入寬, 輸入高)：剛好 0.5 倍（產品 1280×720 → 640×360 的同一比例）、非整數縮小、放大。
for sw, sh, iw, ih in [(64, 36, 32, 32), (40, 24, 16, 16), (10, 6, 32, 32), (37, 23, 20, 20)]:
    scale = min(iw / sw, ih / sh)
    dw, dh = min(iw, round(sw * scale)), min(ih, round(sh * scale))
    rgba = rng.integers(0, 256, size=(sh, sw, 4), dtype=np.uint8)
    bgr = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
    small = cv2.resize(bgr, (dw, dh), interpolation=cv2.INTER_LINEAR)
    cases.append({
        "src_w": sw, "src_h": sh, "input_w": iw, "input_h": ih, "drawn_w": dw, "drawn_h": dh,
        "rgba": rgba.ravel().tolist(),
        "bgr": small.ravel().tolist(),
    })
json.dump({"opencv": cv2.__version__, "cases": cases}, open(sys.argv[1], "w"))
print("cases", [(c["src_w"], c["src_h"], c["drawn_w"], c["drawn_h"]) for c in cases])
