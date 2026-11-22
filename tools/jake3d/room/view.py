# Reprojects a 360 picture through a straight camera: the same optics as Jake's camera.
import sys, math
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
def load(path, width=None):
    im = Image.open(path).convert("RGB")
    if width and im.width > width: im = im.resize((width, width // 2), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255
def view(pano, yaw, pitch, w, h, tan_h, tan_v, roll=0):
    H, W = pano.shape[:2]
    xs = (np.arange(w) + 0.5) / w * 2 - 1
    ys = (np.arange(h) + 0.5) / h * 2 - 1
    x, y = np.meshgrid(xs * tan_h, -ys * tan_v)
    z = np.ones_like(x)
    p, q = math.radians(pitch), math.radians(yaw)
    y2 = y * math.cos(p) + z * math.sin(p)
    z2 = -y * math.sin(p) + z * math.cos(p)
    x3 = x * math.cos(q) + z2 * math.sin(q)
    z3 = -x * math.sin(q) + z2 * math.cos(q)
    lon = np.arctan2(x3, z3)
    lat = np.arctan2(y2, np.hypot(x3, z3))
    u = (lon / (2 * math.pi) + 0.5) * W - 0.5
    v = (0.5 - lat / math.pi) * H - 0.5
    u0 = np.floor(u).astype(int); v0 = np.clip(np.floor(v).astype(int), 0, H - 2)
    fu = (u - u0)[..., None]; fv = (v - v0)[..., None]
    u1 = (u0 + 1) % W; u0 = u0 % W
    return (pano[v0, u0] * (1 - fu) * (1 - fv) + pano[v0, u1] * fu * (1 - fv) + pano[v0 + 1, u0] * (1 - fu) * fv + pano[v0 + 1, u1] * fu * fv)
