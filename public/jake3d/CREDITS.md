# Jake in 3D: credits

Model and motion capture: **Microsoft Rocketbox**, https://github.com/microsoft/Microsoft-Rocketbox (MIT License, see
`LICENSE-rocketbox.txt`). Character `Male_Adult_08` (the `_facial` file, with its face shapes), and 32 clips from
`Assets/Animations`. Downloaded on 2026-11-05.

`jake.glb` was made from those files in a browser with three.js:

- normals smoothed by position (the file's normals gave blocks of dark and light on the shirt);
- split by material, with only the 55 face shapes the app uses, renamed (`v_aa`, `smileL`, `tongueOut`…);
- face colour and normal maps at 2048 px (for the close-up on the mouth), the rest at 1024 px;
- shine (roughness) from the specular maps, with the eyes made wet by hand;
- clips without the face and leg tracks, and with near-duplicate keys removed.

`refine.mjs` then made the face shapes the same on both sides (the left and right halves of the sculpted shapes differed: the lip press
was 0.44 on one side and 0.73 on the other) and added the way each shape turns the skin, so the light follows the lips. The teeth,
the gums and the tongue are drawn by code in `../stage3d.js`, not from the model.

In `../stage3d.js`, at load time: each triangle of the head and the clothes becomes several (rounder jaw, ears and shoulders, with the same file size), the model's flat hair cards give way to thin strands made by code, and upper eyelashes are added, following the eyelids.

`words.txt` says how about 56,000 English words sound, so the mouth follows sounds and not spelling. It comes from the **CMU Pronouncing
Dictionary** (BSD-style licence, see `LICENSE-cmudict.txt`), https://github.com/cmusphinx/cmudict, written shorter by
`tools/jake3d/make-words.mjs`. The words were chosen by how common they are, with the word counts of Peter Norvig's `count_1w.txt` (MIT
License), which is not kept here.

`portrait.webp` is a picture of the model, rendered by `tools/jake3d/portrait.html`.

`../vendor/three-jake.min.js` is three.js 0.186.0 (MIT License, see `../vendor/LICENSE-three.txt`), bundled with esbuild:
only the classes in use and `GLTFLoader`.

`room-light.bin` is the light of Jake's room (the same 360° photo as `../img/jake-room.jpg`, CC0, see `../img/CREDITS.md`), with a soft light added beside the camera.

To build them again: the Learn English folder has `tools/jake3d/`, with the build page, the bundle's entry file and the list of clips.
