# 把 1280×720 RGBA 畫格做成 2560×720 左右並排（兩眼同一張）的 y4m，給 Chromium 的假鏡頭用（只在 repo 外的暫存資料夾）。
import sys
import numpy as np
import cv2
src, dst = sys.argv[1], sys.argv[2]
rgba = np.fromfile(src, np.uint8).reshape(720, 1280, 4)
bgr = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
wide = np.concatenate([bgr, bgr], axis=1)
yuv = cv2.cvtColor(wide, cv2.COLOR_BGR2YUV_I420)
with open(dst, "wb") as f:
    f.write(b"YUV4MPEG2 W2560 H720 F10:1 Ip A1:1 C420jpeg\n")
    for _ in range(2):
        f.write(b"FRAME\n")
        f.write(yuv.tobytes())
