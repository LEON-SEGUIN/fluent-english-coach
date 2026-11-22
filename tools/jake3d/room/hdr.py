# Reads a Radiance .hdr file (RLE RGBE) into a float32 array, no extra library.
import numpy as np
def read_hdr(path):
    data = open(path, "rb").read()
    pos = data.index(b"\n\n") + 2
    end = data.index(b"\n", pos)
    parts = data[pos:end].split()
    h, w = int(parts[1]), int(parts[3])
    pos = end + 1
    out = np.zeros((h, w, 4), dtype=np.uint8)
    for y in range(h):
        assert data[pos] == 2 and data[pos + 1] == 2 and (data[pos + 2] << 8 | data[pos + 3]) == w, "old RLE"
        pos += 4
        for c in range(4):
            x = 0
            while x < w:
                n = data[pos]; pos += 1
                if n > 128:
                    n -= 128
                    out[y, x:x + n, c] = data[pos]; pos += 1
                else:
                    out[y, x:x + n, c] = np.frombuffer(data, np.uint8, n, pos); pos += n
                x += n
    e = out[..., 3].astype(np.float32)
    k = np.where(e > 0, np.ldexp(1.0, (e - 136).astype(int)), 0.0).astype(np.float32)
    return out[..., :3].astype(np.float32) * k[..., None]
