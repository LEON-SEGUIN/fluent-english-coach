# Makes Jake's room from one real 360 photo: the picture behind him and the light on him.
# usage: plate.py <pano jpg, 8k> <hdr, 1k> <yaw> <out dir> [lens radius] [gain]
import os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, sys.argv[0].rsplit("/", 1)[0])
from hdr import read_hdr
from view import view, load

src_jpg, src_hdr, yaw, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
lens = float(sys.argv[5]) if len(sys.argv) > 5 else 5.5
gain = float(sys.argv[6]) if len(sys.argv) > 6 else 0.92
# Same lens as Jake's camera (22 degrees, stage3d.js). TAN_V: a margin above and below, for when the camera moves.
TAN_V, ASPECT, W, H, PITCH = 0.24, 2.5, 1600, 640, -0.71


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(l):
    l = np.clip(l, 0, 1)
    return np.where(l <= 0.0031308, l * 12.92, 1.055 * np.power(l, 1 / 2.4) - 0.055)


def disc_blur(img, r):
    # A real lens blurs with a disc, in linear light.
    pad = int(r * 3)
    p = np.pad(img, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    hh, ww = p.shape[:2]
    yy, xx = np.mgrid[:hh, :ww]
    yy = np.minimum(yy, hh - yy); xx = np.minimum(xx, ww - xx)
    k = np.clip(r + 0.5 - np.hypot(xx, yy), 0, 1).astype(np.float32)
    k /= k.sum()
    K = np.fft.rfft2(k)
    res = np.stack([np.fft.irfft2(np.fft.rfft2(p[..., c]) * K, s=(hh, ww)) for c in range(3)], -1)
    return res[pad:-pad, pad:-pad].astype(np.float32)


def save(a, path, q):
    # A little noise so that the smooth blur does not show bands in the 8-bit picture.
    rng = np.random.default_rng(7)
    v = to_srgb(a * gain) * 255 + rng.normal(0, 0.7, a.shape[:2])[..., None]
    Image.fromarray(np.clip(v + 0.5, 0, 255).astype("uint8")).save(path, quality=q, subsampling=0, optimize=True)


pano = to_linear(load(src_jpg, 8192))
save(disc_blur(view(pano, yaw, PITCH, W, H, TAN_V * ASPECT, TAN_V), lens), f"{out}/jake-room.jpg", 88)
# The small round faces: a head shot, so a closer camera, higher up, on the same room.
save(disc_blur(view(pano, yaw, PITCH + 2.4, 480, 480, 0.15, 0.15), lens * 0.8), f"{out}/jake-room-sm.jpg", 84)

# The light on him: the whole room, small, turned so that the picture's middle is straight behind him (three.js looks along -Z).
env = read_hdr(src_hdr)
eh, ew = env.shape[:2]
env = np.roll(env, int(round((0.25 - (yaw / 360 + 0.5)) * ew)), axis=1)
LW, LH = 256, 128
bx, by = ew // LW, eh // LH
small = env[:LH * by, :LW * bx].reshape(LH, by, LW, bx, 3).mean((1, 3))
# A soft light beside the camera, as anyone filming lessons has: it lights his face and shines in his eyes.
# u = 0.75 is the camera; more is the viewer's left. Rows start at the top: row LH / 2 is the horizon.
u0, u1 = int(LW * 0.735), int(LW * 0.825)
v0, v1 = int(LH * (0.5 - 32 / 180)), int(LH * (0.5 - 3 / 180))
small[v0:v1, u0:u1] = np.maximum(small[v0:v1, u0:u1], np.array([3.7, 3.55, 3.4], np.float32))
rgba = np.concatenate([small[::-1], np.ones((LH, LW, 1), np.float32)], -1)  # bottom row first, like a texture
rgba.astype("<f2").tofile(f"{out}/room-light.bin")
for n in ("jake-room.jpg", "jake-room-sm.jpg", "room-light.bin"):
    print(n, os.path.getsize(f"{out}/{n}"))
