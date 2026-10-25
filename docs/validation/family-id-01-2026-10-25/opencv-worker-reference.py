# 家人辨識 ID-01：產品 worker 管線的 OpenCV 參考（YuNet 2023mar 640 letterbox → SFace）。
# 輸入：<畫格資料夾> 內的 *.rgba（1280×720 RGBA，ID-00 交叉核對產生的公有領域肖像畫格）、模型資料夾、輸出資料夾。
# 另外合成兩個畫格：two_faces.rgba（兩張肖像並排，應判為多張臉）與 blank.rgba（灰底，沒有臉）。
# 輸出 ref.json：每格的臉數、臉框、5 點與 SFace 特徵（L2 normalize）。只供驗證，不是產品程式。
# 需要 opencv-python-headless 5.0.0.93、numpy 2.5.4；以 python -I 執行。
import json, os, sys
import numpy as np
import cv2

frames_dir, models, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
W, H, INPUT = 1280, 720, 640
os.makedirs(outdir, exist_ok=True)

frames = {}
for f in sorted(os.listdir(frames_dir)):
    if f.endswith(".rgba"):
        frames[f] = np.fromfile(os.path.join(frames_dir, f), np.uint8).reshape(H, W, 4)
names = sorted(frames)
# 兩張肖像各縮成一半寬並排（都在畫面內）。
a = cv2.resize(frames[names[0]], (W // 2, H // 2), interpolation=cv2.INTER_AREA)
b = cv2.resize(frames[names[-1]], (W // 2, H // 2), interpolation=cv2.INTER_AREA)
two = np.full((H, W, 4), 58, np.uint8); two[..., 3] = 255
two[H // 4:H // 4 + H // 2, 0:W // 2] = a
two[H // 4:H // 4 + H // 2, W // 2:W] = b
frames["two_faces.rgba"] = two
blank = np.full((H, W, 4), 58, np.uint8); blank[..., 3] = 255
frames["blank.rgba"] = blank
for name in ("two_faces.rgba", "blank.rgba"):
    frames[name].tofile(os.path.join(outdir, name))

det = cv2.FaceDetectorYN.create(os.path.join(models, "face_detection_yunet_2023mar.onnx"), "", (INPUT, INPUT), 0.6, 0.3, 5000)
rec = cv2.FaceRecognizerSF.create(os.path.join(models, "face_recognition_sface_2021dec.onnx"), "")
scale = min(INPUT / W, INPUT / H)
dw, dh = round(W * scale), round(H * scale)
res = {}
for name, rgba in frames.items():
    bgr = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
    small = cv2.resize(bgr, (dw, dh), interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros((INPUT, INPUT, 3), np.uint8)
    canvas[:dh, :dw] = small
    _, faces = det.detect(canvas)
    faces = [] if faces is None else faces
    out_faces, feats = [], []
    for fc in faces:
        full = fc.copy()
        full[:14] = fc[:14] / scale
        out_faces.append(full.tolist())
        f = rec.feature(rec.alignCrop(bgr, full)).ravel()
        feats.append((f / np.linalg.norm(f)).tolist())
    res[name] = {"faces": out_faces, "features": feats}
json.dump({"opencv": cv2.__version__, "results": res}, open(os.path.join(outdir, "ref.json"), "w"))
for name, r in res.items():
    print(name, len(r["faces"]), [[round(v, 1) for v in fc[:4]] + [round(fc[14], 3)] for fc in r["faces"]])
