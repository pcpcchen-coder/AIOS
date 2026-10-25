# 驗證工具，非產品程式。ID-00 交叉核對：以 OpenCV 5.0.0 FaceDetectorYN（2026may 模型）與 FaceRecognizerSF 產生參考框與特徵，
# 並把同一個 1280×720 畫格存成 RGBA 原始檔、alignCrop 的 112×112 對齊影像存成 BGR 原始檔，
# 給 prototype/ambient-shell/spike/face/tools/opencv-crosscheck.ts 用同一批像素比對。依賴版本見同目錄 requirements.txt。
# 用法：python -I opencv-reference.py <圖片資料夾> <模型資料夾> <輸出資料夾>
import json, sys, os, numpy as np, cv2
imgdir, models, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
W, H = 1280, 720
det = cv2.FaceDetectorYN.create(os.path.join(models, "face_detection_yunet_2026may.onnx"), "", (W, H), 0.6, 0.3, 5000)
rec = cv2.FaceRecognizerSF.create(os.path.join(models, "face_recognition_sface_2021dec.onnx"), "")
res = {}
for f in sorted(os.listdir(imgdir)):
    img = cv2.imread(os.path.join(imgdir, f))
    s = min(W / img.shape[1], H / img.shape[0])
    small = cv2.resize(img, (round(img.shape[1] * s), round(img.shape[0] * s)), interpolation=cv2.INTER_AREA)
    frame = np.full((H, W, 3), 58, np.uint8)
    x0 = (W - small.shape[1]) // 2; y0 = (H - small.shape[0]) // 2
    frame[y0:y0 + small.shape[0], x0:x0 + small.shape[1]] = small
    rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2RGBA)
    rgba.tofile(os.path.join(outdir, f + ".rgba"))
    _, faces = det.detect(frame)
    faces = [] if faces is None else faces
    feats = []
    for fc in faces:
        aligned = rec.alignCrop(frame, fc)
        if not feats:
            aligned.tofile(os.path.join(outdir, f + ".aligned.bgr"))
        feats.append(rec.feature(aligned).ravel().tolist())
    res[f] = {"faces": [fc.tolist() for fc in faces], "features": feats}
json.dump({"opencv": cv2.__version__, "frame": [W, H], "results": res}, open(os.path.join(outdir, "ref.json"), "w"))
for f, r in res.items(): print(f, [[round(v, 1) for v in fc[:4]] + [round(fc[14], 3)] for fc in r["faces"]])
