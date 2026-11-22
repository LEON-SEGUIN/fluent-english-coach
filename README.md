# Fluent: an English speaking coach on a video call

Fluent is a private English coach that runs on your own Mac. You call Jake (San Francisco) or Emma (London)
like on a video call. They speak with a real voice, they correct what makes you sound foreign, they give you
homework, and they remember you from one class to the next. Jake is a 3D character whose mouth follows the
sounds he says.

Fluent is made for French speakers who already speak some English and want to become really fluent, in
business English and in everyday life. The app talks to you in French or in English.

## How it works

1. You open Fluent in Chrome and call your coach.
2. The microphone hears you, and a speech service writes down your words.
3. Claude (an AI model made by Anthropic) plays the coach and writes the answer.
4. A voice service speaks the answer, and the coach's face moves with the voice.
5. After the call, Claude writes a review, your homework, and notes about you for the next class.

Everything is run by a small program on your own Mac. There is no Fluent account, no Fluent server and no
subscription: the app uses your own keys for the AI services, and your data stays on your Mac.

## What you need

- A Mac. Fluent was built and tested on macOS only (an Apple-chip Mac shows Jake in 3D at full speed).
- [Node.js](https://nodejs.org) version 20.12 or newer (take the "LTS" download).
- Google Chrome (best for the microphone and for Jake in 3D).
- An internet connection.
- Your own API keys (see step 4). You pay the AI services directly, for what you use.

## Set up (about 10 minutes)

**1. Install Node.js.** Download the LTS version from https://nodejs.org and run the installer.

**2. Get the code.** Open https://github.com/LEON-SEGUIN/fluent-english-coach, click the green **Code**
button, then **Download ZIP**. Unzip it and put the folder (`fluent-english-coach-main`) on the Desktop.
(With git: `git clone https://github.com/LEON-SEGUIN/fluent-english-coach.git`.)

**3. Start Fluent.** Double-click `start.command` in the folder. The first start installs what the app needs,
then Chrome opens at http://localhost:4322.

If macOS refuses to open `start.command`: right-click it, choose **Open**, then confirm. If that does not work,
open the Terminal app and type:

```
cd ~/Desktop/fluent-english-coach-main
npm install
npm start
```

Then open http://localhost:4322 in Chrome.

**4. Add your keys.** Fluent shows a setup screen and asks for the first key. You add the others in
**Settings › API key**.

| Key | Needed? | What it does | Where to get it |
|---|---|---|---|
| Anthropic (starts with `sk-ant-`) | Required | The coach's brain (Claude) | https://console.anthropic.com/settings/keys, then add a little credit in Billing |
| ElevenLabs (starts with `sk_`) | Strongly recommended | The human voice and the fast, accurate ears | https://elevenlabs.io/app/settings/api-keys. Allow **Text to Speech**, **Speech to Text** and **Voices (read)** on the key |
| Groq (starts with `gsk_`) | Optional, free | Backup ears (Whisper) | https://console.groq.com/keys |

Fluent checks each key and saves it in a file named `.env` in the folder, on your Mac only.

**5. Allow the microphone** when Chrome asks. If you clicked "Block" by mistake: System Settings › Privacy &
Security › Microphone › turn on Google Chrome.

**6. Answer the first questions** (your name, your level, your coach), then do your first session.

### Set a spending limit first

Each class costs a little money on your own accounts. Before your first class, set a monthly limit in the
Anthropic Console (Settings › Limits) and check your ElevenLabs credit. Then you can never pay more than you
decided.

## Your first session and your plan

- **The first session** is 30 minutes of guided talk in ten short parts, with no corrections. You can stop
  and pick it up later; you get results from 10 minutes of talk.
- **Your results:** a level and six scores: fluency, the right words, sentence structures, business English,
  everyday life and relationships, understanding.
- **Your plan** is written from these results. Each week mixes business English, everyday life, the right
  word, sentence structures and fluency, with more time on your weak points.
- **The plan adapts:** after each finished week, the next week is rewritten from how your lessons went.

One thing to know: the app was first built for its author, so the default goal speaks of business English and
of life on a university exchange abroad, and some questions of the first session are about studying abroad.
When you create your plan, write your own goal in the goal box. In the first session, just answer about your
own life.

## Every day

- Start: double-click `start.command`. Keep the Terminal window open while you practise.
- Stop: close the Terminal window.
- If Fluent is already running, a second double-click just opens the app.

## What is in the app

- **Home:** your next lesson, today's list (homework, accent workout), your progress in one look.
- **Lessons:** your learning plan, your lesson days and time, notes from past lessons, the theory library.
- **Homework:** after each lesson, 15 to 25 minutes made from what you said: words, quiz, "say it like a
  native", speaking and writing (checked by the coach).
- **Practice:** the daily accent workout (10 to 30 minutes: you speak along with the native voice, one sound
  per day, and you get a score), flashcards, drills built from your mistakes, and free calls (free talk,
  today's news, role-plays such as a diner, an airport or a weekend plan with a friend).
- **Progress:** your level, practice time, words, score charts, what the coach remembers, your diary.

### During a call

- Hands-free: just talk. When you pause, the coach answers. The coach waits longer when you do not sound
  finished.
- Talk over the coach to interrupt. Small words such as "yeah" or "right" do not stop the coach.
  (On iPhone, tap to interrupt.)
- Subtitles show only when the coach corrects you, explains something or writes on the whiteboard.
  Settings › Subtitles brings back every line.
- Help button: repeat slowly, "I didn't understand", "How do I say…?", answer ideas.
- After the call: a review, new flashcards, updated skills, homework, and the plan for the next class.

### The coach's memory

After each class the coach writes notes about you: your life, your interests, your strong points, your usual
mistakes. The next call starts from these notes. You can read and correct them in **Progress**.
A class is saved even if you close the window or lose the connection: the Mac finishes the review later.

## Voices, ears and Jake in 3D

- With an ElevenLabs key: human voices (American for Jake, British for Emma), and your words are written
  while you speak. This gives the shortest wait before the coach answers.
- Without it: Fluent uses free backup voices (Microsoft's online voices, then the Mac's own voices) and
  Chrome's dictation or Groq for the ears. It works, but it sounds less natural and it is slower.
  The Microsoft backup voice is an unofficial free service and can stop working.
- Jake in 3D needs WebGL, which Chrome has by default. If the 3D cannot start, a drawn Jake takes over.
  Emma is drawn.
- Useful settings: Microphone, Tutor's volume, Speaking speed, Pause before sending, Writing down your voice.

## Use it on your phone (optional)

Settings › Phone: choose a PIN (6 to 10 digits), then **Turn on the phone link**. Scan the QR code with the phone.

- This opens a private https link to your Mac (a free Cloudflare quick tunnel), protected by your PIN.
- The app still runs on the Mac: keep it plugged in, with the lid open and the Terminal window open.
- The link changes each time Fluent restarts. Scan the new QR code and enter the PIN again.
- On iPhone: Safari › Share › Add to Home Screen gives an app icon.
- Turn the phone link off when you do not use it.

## Cost

You pay each service directly. These numbers were measured by the author in late 2026; prices change, so
check your own usage after the first class.

- Anthropic: about 20 to 40 cents for 15 minutes of class with the default Brain.
- ElevenLabs: about $0.40 of voice and $0.15 to $0.20 of listening for a 30-minute class.
- Groq: free.

Settings › Brain changes the price and the speed:

- "Natural and fast" (default): Sonnet for talking, Opus for the review.
- "Instant and cheapest": Haiku for talking, Sonnet for the review. About half the price.
- "Smartest": Opus for both. Slower, about twice the price.

## Privacy and security

- **Your keys** are in `.env`, on your Mac only. Never share this file and never publish it. The
  `.gitignore` file already keeps it out of git.
- **Your data** (profile, words, diary, coach memory) is in the `data/` folder, on your Mac only. It is also
  kept out of git. Copy this folder to back it up.
- **The app is closed to the network.** It answers only to your own Mac (`127.0.0.1`). Other devices on your
  Wi-Fi cannot reach it.
- **The phone link** is the only way in from outside, and it is off by default. It needs your PIN, and five
  wrong PINs lock the login for 10 minutes. Keys and the PIN can be changed on the Mac only.
- **What leaves your Mac** during a class:
  - what you say, as text, goes to Anthropic (Claude) to write the answer;
  - your voice goes to ElevenLabs to be written down (or to Groq, or to Chrome's own dictation);
  - the coach's text goes to ElevenLabs to be spoken (or to Microsoft for the backup voice);
  - news headlines come from public feeds (NPR, BBC);
  - the page loads its fonts from Google Fonts, and the QR code script from cdnjs (Settings › Phone only).

## If something goes wrong

- "Fluent is not running": double-click `start.command` again.
- Still stuck: close the Terminal window, then double-click `start.command`. Error messages appear in the
  Terminal window.
- "Node.js is missing": install it from https://nodejs.org, then start again.
- "No credit" or a key problem: open the service's website (Billing or API keys), then paste a new key in
  Settings › API key.
- The coach does not hear you: use Chrome, check System Settings › Privacy & Security › Microphone, and
  choose your microphone in Settings › Microphone.
- The coach is too quiet: Settings › Tutor's volume.
- Port 4322 is already used by another app: start with `PORT=4400 npm start` and open http://localhost:4400.

## For the curious: the files

| File | What it does |
|---|---|
| `server.js` | The local server: calls, coach prompts, first session, plan, reviews, homework, phone link |
| `curriculum.js` | The levels, the skills and the theory library |
| `tts.js`, `tts/` | The voices (ElevenLabs, backups, the Mac voice helper in Swift) |
| `stt.js` | The ears (ElevenLabs Scribe, Groq Whisper) |
| `shadowing.js` | The daily accent workout |
| `news.js` | Today's news in English |
| `public/` | The page: screens, call, styles |
| `public/stage3d.js`, `public/jake3d/`, `public/vendor/` | Jake in 3D: the code, the model, the word sounds, three.js |
| `tools/jake3d/` | The scripts that built Jake's model and his room |
| `.env.example` | A model of the `.env` file |
| `data/` | Made on first use: your private data |

The only npm package is the official Anthropic SDK.

## Credits and licences

- Jake's body and motion: Microsoft Rocketbox (MIT License).
- How English words sound: the CMU Pronouncing Dictionary (BSD-style licence).
- 3D engine: three.js (MIT License).
- Jake's room: a Poly Haven photo (CC0). Other room photos: Unsplash.

Details and licence texts are in `public/jake3d/CREDITS.md`, `public/img/CREDITS.md` and `public/vendor/`.

This is a personal project, shared as it is, with no guarantee.
