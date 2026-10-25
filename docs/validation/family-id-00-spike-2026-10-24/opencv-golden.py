# 驗證工具，非產品程式。ID-00 spike 單元測試的 golden 值產生器。
# 依賴版本見同目錄 requirements.txt；在任一暫存目錄執行：python -I opencv-golden.py，輸出 golden.json，
# 壓成單行後即 prototype/ambient-shell/tests/fixtures/face-spike-opencv-golden.json。
# similarity 一節是 opencv face_recognize.cpp getSimilarityTransformMatrix（SVD Umeyama）的逐行移植，不是呼叫 OpenCV API；
# 端到端的對齊結果另由 opencv-reference.py＋opencv-crosscheck.ts 以 OpenCV alignCrop 直接比對。NMS 與 warpAffine 則直接呼叫 OpenCV。
import json, numpy as np, cv2
dst = np.array([[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]], dtype=np.float32)
dst_mean = np.array([56.0262,71.9008], dtype=np.float32)
def opencv_sim(src):
    # 逐行移植 face_recognize.cpp getSimilarityTransformMatrix
    src = np.asarray(src, dtype=np.float32)
    src_mean = src.mean(axis=0).astype(np.float32)
    sd = (src - src_mean).astype(np.float32); dd = (dst - dst_mean).astype(np.float32)
    A = np.zeros((2,2))
    A[0,0] = np.sum(dd[:,0].astype(np.float64)*sd[:,0])/5
    A[0,1] = np.sum(dd[:,0].astype(np.float64)*sd[:,1])/5
    A[1,0] = np.sum(dd[:,1].astype(np.float64)*sd[:,0])/5
    A[1,1] = np.sum(dd[:,1].astype(np.float64)*sd[:,1])/5
    d = [1.0,1.0]
    if np.linalg.det(A) < 0: d[1] = -1
    w, u, vt = cv2.SVDecomp(A)
    s = w.ravel()
    T = np.eye(3)
    D = np.diag(d)
    T[:2,:2] = u @ D @ vt
    var1 = np.sum(sd[:,0].astype(np.float64)**2)/5; var2 = np.sum(sd[:,1].astype(np.float64)**2)/5
    scale = 1.0/(var1+var2)*(s[0]*d[0]+s[1]*d[1])
    TS = T[:2,:2] @ src_mean.astype(np.float64)
    T[0,2] = dst_mean[0]-scale*TS[0]; T[1,2] = dst_mean[1]-scale*TS[1]
    T[:2,:2] *= scale
    return T[:2,:].ravel().tolist()
cases = {
  "frontal": [[512.3,300.1],[571.8,298.4],[543.0,334.2],[519.5,366.0],[566.2,364.9]],
  "rolled": [[400.0,420.0],[452.0,395.0],[436.0,440.0],[423.0,478.0],[466.0,458.0]],
  "mirrored": [[571.8,298.4],[512.3,300.1],[543.0,334.2],[566.2,364.9],[519.5,366.0]],
}
sim = {k: {"src": v, "m": opencv_sim(v)} for k, v in cases.items()}
# NMS
boxes = [[10,10,50,50],[12.7,11.2,50,49],[100,100,40,40],[105,98,42,41],[11,60,50,50],[300,300,20,20]]
scores = [0.9,0.95,0.7,0.65,0.61,0.59]
keep = cv2.dnn.NMSBoxes([[int(b[0]),int(b[1]),int(b[2]),int(b[3])] for b in boxes], scores, 0.6, 0.3, 1.0, 5000)
nms = {"boxes": boxes, "scores": scores, "score_threshold":0.6, "nms_threshold":0.3, "top_k":5000, "keep": [int(i) for i in np.array(keep).ravel()]}
keep2 = cv2.dnn.NMSBoxes([[int(b[0]),int(b[1]),int(b[2]),int(b[3])] for b in boxes], scores, 0.6, 0.3, 1.0, 2)
nms["keep_topk2"] = [int(i) for i in np.array(keep2).ravel()]
# warpAffine on synthetic image
h, w = 40, 48
yy, xx = np.mgrid[0:h, 0:w]
img = np.stack([(xx*5)%256, (yy*6)%256, ((xx+yy)*3)%256], axis=-1).astype(np.uint8)  # BGR order in OpenCV terms
M = np.array([[0.9,-0.2,4.3],[0.2,0.9,-2.1]], dtype=np.float64)
out = cv2.warpAffine(img, M, (16,16), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
warp = {"w": w, "h": h, "m": M.ravel().tolist(), "size": 16, "out_bgr": out.astype(int).tolist()}
json.dump({"opencv": cv2.__version__, "similarity": sim, "nms": nms, "warp": warp}, open("golden.json","w"))
print(json.dumps(sim, indent=0)[:1500]); print(nms["keep"], nms["keep_topk2"])
