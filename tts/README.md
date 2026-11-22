# Native voice engine

`camino-tts.swift` is a long-running helper that keeps macOS voices loaded (AVSpeechSynthesizer.write), so a sentence is ready in ~20-60 ms instead of ~1.2 s with `say`.
`../tts.js` compiles it on first use (`swiftc -O camino-tts.swift -o bin/camino-tts`, again whenever the .swift is newer), restarts it if it crashes, and falls back to `say` meanwhile. `FLUENT_TTS_DISABLE_NATIVE=1` forces `say`; `FLUENT_TTS_DEBUG=1` logs. (The helper keeps its first name, camino-tts: it is the same file as in the Spanish app.)

Protocol: one JSON object per line on stdin and stdout; synth requests run one at a time.
- `{"op":"voices"}` -> `{"op":"voices","voices":[{id,name,lang,quality,gender}]}`
- `{"op":"synth","id","text","voice":<identifier>,"rate":<AVSpeechUtterance rate>,"out":"/abs.wav"}` -> `{"op":"done","id","ok":true,"sampleRate","samples","words":[{start,len,sample}]}` or `{"op":"done","id","ok":false,"error"}`

Output: 16-bit mono WAV at the voice's own rate. `start`/`len` are UTF-16 indexes (JavaScript string indexes) into the text; emoji are skipped.
