// camino-tts: long-running speech helper for Camino (see tts/README.md).
// stdin: one JSON request per line. stdout: one JSON reply per line.
//   {"op":"voices"}  -> {"op":"voices","voices":[{id,name,lang,quality,gender}]}
//   {"op":"synth","id":..,"text":..,"voice":..,"rate":..,"out":"/abs.wav"}
//                    -> {"op":"done","id":..,"ok":true,"sampleRate":N,"samples":N,"words":[{start,len,sample}]}
//                    or {"op":"done","id":..,"ok":false,"error":".."}
// Synth requests run one at a time (FIFO). Voices stay loaded between requests.
// Build: swiftc -O tts/camino-tts.swift -o tts/bin/camino-tts

import AVFoundation
import Foundation

let debug = ProcessInfo.processInfo.environment["CAMINO_TTS_DEBUG"] == "1"

func log(_ s: @autoclosure () -> String) {
    guard debug else { return }
    FileHandle.standardError.write(Data(("[camino-tts] " + s() + "\n").utf8))
}

let outLock = NSLock()

func send(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
    data.append(0x0A)
    outLock.lock()
    defer { outLock.unlock() }
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let base = raw.baseAddress else { return }
        var off = 0
        while off < raw.count {
            let n = Darwin.write(1, base + off, raw.count - off)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { exit(0) }  // parent is gone
            off += n
        }
    }
}

// Any PCM buffer -> mono Int16 samples.
func toMono(_ b: AVAudioPCMBuffer) -> [Int16] {
    let n = Int(b.frameLength)
    if n == 0 { return [] }
    let ch = max(1, Int(b.format.channelCount))
    let inter = b.format.isInterleaved
    let stride = max(1, b.stride)
    var out = [Int16](repeating: 0, count: n)
    @inline(__always) func f2i(_ x: Double) -> Int16 {
        let v = max(-1.0, min(1.0, x)) * 32767.0
        return Int16(v.rounded())
    }
    switch b.format.commonFormat {
    case .pcmFormatFloat32:
        guard let d = b.floatChannelData else { return [] }
        for i in 0..<n {
            var s = 0.0
            for c in 0..<ch { s += Double(inter ? d[0][i * stride + c] : d[c][i * stride]) }
            out[i] = f2i(s / Double(ch))
        }
    case .pcmFormatInt16:
        guard let d = b.int16ChannelData else { return [] }
        for i in 0..<n {
            var s = 0
            for c in 0..<ch { s += Int(inter ? d[0][i * stride + c] : d[c][i * stride]) }
            out[i] = Int16(clamping: s / ch)
        }
    case .pcmFormatInt32:
        guard let d = b.int32ChannelData else { return [] }
        for i in 0..<n {
            var s = 0
            for c in 0..<ch { s += Int(inter ? d[0][i * stride + c] : d[c][i * stride]) >> 16 }
            out[i] = Int16(clamping: s / ch)
        }
    case .pcmFormatFloat64:
        let abl = UnsafeMutableAudioBufferListPointer(b.mutableAudioBufferList)
        for i in 0..<n {
            var s = 0.0
            for c in 0..<ch {
                if inter {
                    guard let p = abl[0].mData?.assumingMemoryBound(to: Double.self) else { return [] }
                    s += p[i * ch + c]
                } else {
                    guard c < abl.count, let p = abl[c].mData?.assumingMemoryBound(to: Double.self) else { return [] }
                    s += p[i]
                }
            }
            out[i] = f2i(s / Double(ch))
        }
    default:
        return []
    }
    return out
}

func writeWav(path: String, samples: [Int16], rate: Int) throws {
    let dataBytes = UInt32(samples.count * 2)
    var d = Data(capacity: 44 + Int(dataBytes))
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataBytes); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
    u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(dataBytes)
    samples.withUnsafeBytes { d.append(contentsOf: $0) }  // arm64/x86 are little-endian
    try d.write(to: URL(fileURLWithPath: path))
}

// Emoji would be read aloud ("cara sonriente") and shift the voice's word ranges.
// Blank them out with spaces of the same UTF-16 length so indexes still match the text.
func speakable(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    for sc in text.unicodeScalars {
        let p = sc.properties
        let v = sc.value
        let blank = p.isEmojiPresentation || p.isEmojiModifier || (p.isEmoji && v >= 0x2100)
            || v == 0x200D || (0xFE00...0xFE0F).contains(v) || (0xE0020...0xE007F).contains(v)
        if blank {
            for _ in 0..<sc.utf16.count { out.append(" ") }
        } else {
            out.append(sc)
        }
    }
    return String(out)
}

final class Job {
    let id: Any
    let text: String
    let out: String
    let utterance: AVSpeechUtterance
    let started = Date()
    var samples: [Int16] = []
    var sampleRate: Double = 0
    var bytesPerFrame = 0
    var marks: [(start: Int, len: Int, offset: Int)] = []
    var lastBuffer: Date?
    var finished = false
    var gotFinal = false
    var delegateDone = false

    init(id: Any, text: String, out: String, utterance: AVSpeechUtterance) {
        self.id = id
        self.text = text
        self.out = out
        self.utterance = utterance
    }
}

final class Engine: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    let synth = AVSpeechSynthesizer()
    var queue: [[String: Any]] = []
    var current: Job?
    var timer: Timer?
    var voiceCache: [String: AVSpeechSynthesisVoice] = [:]
    var dirty = false  // the last job ended without the final empty buffer

    override init() {
        super.init()
        synth.delegate = self
    }

    func handle(_ req: [String: Any]) {
        switch req["op"] as? String {
        case "voices": sendVoices()
        case "synth":
            queue.append(req)
            next()
        default:
            send(["op": "error", "error": "unknown op"])
        }
    }

    func sendVoices() {
        let list: [[String: Any]] = AVSpeechSynthesisVoice.speechVoices().map { v in
            let q: String
            switch v.quality {
            case .premium: q = "premium"
            case .enhanced: q = "enhanced"
            default: q = "default"
            }
            let g: String
            switch v.gender {
            case .female: g = "female"
            case .male: g = "male"
            default: g = "unspecified"
            }
            return ["id": v.identifier, "name": v.name, "lang": v.language, "quality": q, "gender": g]
        }
        send(["op": "voices", "voices": list])
    }

    func voice(_ id: String) -> AVSpeechSynthesisVoice? {
        if let v = voiceCache[id] { return v }
        guard let v = AVSpeechSynthesisVoice(identifier: id) else { return nil }
        voiceCache[id] = v
        return v
    }

    func next() {
        guard current == nil, !queue.isEmpty else { return }
        start(queue.removeFirst())
    }

    func fail(_ id: Any, _ error: String) {
        send(["op": "done", "id": id, "ok": false, "error": error])
        DispatchQueue.main.async { self.next() }
    }

    func start(_ req: [String: Any]) {
        let id = req["id"] ?? NSNull()
        guard let text = req["text"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return fail(id, "empty text") }
        guard let out = req["out"] as? String, out.hasPrefix("/") else { return fail(id, "bad out path") }
        guard let vid = req["voice"] as? String, let v = voice(vid) else { return fail(id, "unknown voice") }
        let rate = (req["rate"] as? NSNumber)?.floatValue ?? AVSpeechUtteranceDefaultSpeechRate

        let u = AVSpeechUtterance(string: speakable(text))
        u.voice = v
        u.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, rate))
        u.preUtteranceDelay = 0
        u.postUtteranceDelay = 0
        u.prefersAssistiveTechnologySettings = false
        let job = Job(id: id, text: text, out: out, utterance: u)
        current = job
        if dirty {
            synth.stopSpeaking(at: .immediate)
            dirty = false
        }

        synth.write(u, toBufferCallback: { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let mono = toMono(pcm)  // copy now: the buffer may be reused
            let rate = pcm.format.sampleRate
            let bpf = Int(pcm.format.streamDescription.pointee.mBytesPerFrame)
            let end = pcm.frameLength == 0
            DispatchQueue.main.async { self?.onBuffer(job, mono, rate, bpf, end) }
        }, toMarkerCallback: { [weak self] markers in
            // Not called on macOS 26 (marks come through the delegate), kept in case it is.
            let words = markers.filter { $0.mark == .word }
                .map { (start: $0.textRange.location, len: $0.textRange.length, offset: $0.byteSampleOffset) }
            if words.isEmpty { return }
            DispatchQueue.main.async { self?.onMarks(job, words) }
        })
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.tick() }
    }

    func onBuffer(_ job: Job, _ mono: [Int16], _ rate: Double, _ bpf: Int, _ end: Bool) {
        guard !job.finished else { return }
        if end {
            log("final empty buffer after \(Int(Date().timeIntervalSince(job.started) * 1000)) ms")
            job.gotFinal = true
            return finish(job, nil)
        }
        if job.samples.isEmpty { log("format \(rate) Hz, \(bpf) bytes/frame") }
        if rate > 0 { job.sampleRate = rate }
        if bpf > 0 { job.bytesPerFrame = bpf }
        job.samples.append(contentsOf: mono)
        job.lastBuffer = Date()
    }

    func onMarks(_ job: Job, _ words: [(start: Int, len: Int, offset: Int)]) {
        guard !job.finished else { return }
        for w in words where !job.marks.contains(where: { $0.start == w.start && $0.offset == w.offset }) {
            log("word \(w.start)+\(w.len) offset=\(w.offset) (samples so far \(job.samples.count))")
            job.marks.append(w)
        }
    }

    // During write(), word marks arrive here (not in toMarkerCallback).
    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeak marker: AVSpeechSynthesisMarker, utterance u: AVSpeechUtterance) {
        guard marker.mark == .word, let job = current, job.utterance === u else { return }
        onMarks(job, [(start: marker.textRange.location, len: marker.textRange.length, offset: marker.byteSampleOffset)])
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        if let job = current, job.utterance === u { job.delegateDone = true }
    }

    func tick() {
        guard let job = current, !job.finished else { return }
        let now = Date()
        if now.timeIntervalSince(job.started) > 10 {
            finish(job, "timeout")
        } else if let lb = job.lastBuffer, now.timeIntervalSince(lb) > (job.delegateDone ? 0.15 : 0.7) {
            log("no final empty buffer; finishing on silence")
            finish(job, nil)
        }
    }

    func finish(_ job: Job, _ error: String?) {
        guard !job.finished else { return }
        job.finished = true
        timer?.invalidate()
        timer = nil
        if !job.gotFinal { dirty = true }
        current = nil
        defer { DispatchQueue.main.async { self.next() } }

        if let error { return send(["op": "done", "id": job.id, "ok": false, "error": error]) }
        if job.samples.isEmpty || job.sampleRate <= 0 {
            return send(["op": "done", "id": job.id, "ok": false, "error": "no audio"])
        }
        let rate = Int(job.sampleRate.rounded())
        // Some voices (Eloquence) end with ~0.4 s of silence: keep at most 0.15 s so sentences
        // played back to back are not separated by a voice-dependent gap.
        if let lastLoud = job.samples.lastIndex(where: { abs(Int($0)) > 64 }) {
            let keep = min(job.samples.count, lastLoud + 1 + rate * 15 / 100)
            job.samples.removeSubrange(keep...)
        }
        do {
            try writeWav(path: job.out, samples: job.samples, rate: rate)
        } catch {
            return send(["op": "done", "id": job.id, "ok": false, "error": "write failed: \(error.localizedDescription)"])
        }
        send(["op": "done", "id": job.id, "ok": true, "sampleRate": rate, "samples": job.samples.count,
              "words": words(job)])
    }

    // Word marks -> [{start, len, sample}]. textRange is an NSRange in UTF-16 units: the same
    // indexes as JavaScript strings. byteSampleOffset is in BYTES of the buffer format
    // (measured: offset / samples-so-far == 4 for float32 mono), so divide by bytes per frame.
    // Ranges are trimmed to letters/digits (some voices include "¡", "¿", "?" in the range).
    func words(_ job: Job) -> [[String: Int]] {
        let ns = job.text as NSString
        let total = job.samples.count
        let bpf = job.bytesPerFrame > 0 ? job.bytesPerFrame : 4
        func isWordChar(_ i: Int) -> Bool {
            let c = ns.character(at: i)
            guard let u = Unicode.Scalar(c) else { return true }  // surrogate half: part of a symbol
            return CharacterSet.alphanumerics.contains(u)
        }
        var out: [[String: Int]] = []
        var last = 0, lastEnd = 0
        for m in job.marks.sorted(by: { ($0.offset, $0.start) < ($1.offset, $1.start) }) {
            var a = max(0, m.start), b = min(ns.length, m.start + m.len)
            while a < b && !isWordChar(a) { a += 1 }
            while b > a && !isWordChar(b - 1) { b -= 1 }
            guard b > a, a >= lastEnd else { continue }  // skip punctuation-only and repeated ranges
            let sample = max(last, min(total, m.offset / bpf))
            last = sample
            lastEnd = b
            out.append(["start": a, "len": b - a, "sample": sample])
        }
        return out
    }
}

let engine = Engine()

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            send(["op": "error", "error": "bad json"])
            continue
        }
        DispatchQueue.main.async { engine.handle(obj) }
    }
    exit(0)  // stdin closed: the parent is gone
}
reader.start()
RunLoop.main.run()
