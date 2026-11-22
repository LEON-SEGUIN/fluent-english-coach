// The road to fluent English: CEFR levels A1 to C2, each with the skills a teacher covers.
// The learner already speaks English: A1-A2 are a short refresh. Since 2026-11-04 the weight is on a better American
// accent, smoother speech, everyday American English and general business English (the first C1 skills).
// The server uses it to plan lessons; the page shows it on the "Journey" screen.
// Fields: id, title {fr, en}, ex (an English example), teach (a short note for the tutor, in English).

export const LEVELS = [
  { id: "A1", es: "Beginner", fr: "Premiers pas", en: "Beginner", can: { fr: "Tu te présentes et tu parles de ta vie de tous les jours avec des phrases simples.", en: "You introduce yourself and talk about daily life in simple sentences." } },
  { id: "A2", es: "Elementary", fr: "Élémentaire", en: "Elementary", can: { fr: "Tu racontes ce que tu as fait et tu donnes ton avis simplement.", en: "You tell what you did and give simple opinions." } },
  { id: "B1", es: "Intermediate", fr: "Intermédiaire", en: "Intermediate", can: { fr: "Tu tiens une vraie conversation, tu racontes, tu parles de ta vie.", en: "You hold a real conversation, tell stories and talk about your life." } },
  { id: "B2", es: "Upper intermediate", fr: "Intermédiaire avancé", en: "Upper intermediate", can: { fr: "Tu débats, tu prends ta place en réunion et tu parles avec aisance et peu d'erreurs.", en: "You debate, hold your own in a meeting, and speak with ease and few mistakes." } },
  { id: "C1", es: "Advanced", fr: "Niveau avancé", en: "Advanced", can: { fr: "Tu nuances, tu racontes, tu négocies, avec un accent clair et sans chercher tes mots.", en: "You add nuance, tell stories and negotiate, with a clear accent and without searching for words." } },
  { id: "C2", es: "Mastery", fr: "Maîtrise", en: "Mastery", can: { fr: "Tu parles comme un natif, partout : humour, précision, influence, références culturelles.", en: "You speak like a native anywhere: humour, precision, influence, cultural references." } },
];

const S = (id, fr, en, ex, teach) => ({ id, title: { fr, en }, ex, teach });

// Lessons to read before the A1 skills (theory only: they are not skills the tutor grades).
export const STARTER_LESSONS = [
  S("a0-sounds", "Les sons de l'anglais pour un francophone", "English sounds for French speakers", "I think three thin things are worth it.", "th (think/this), h (never silent: hello, house), short i vs long ee (ship/sheep), schwa, word stress, -ed endings, the r, linking words"),
  S("a0-survival", "Les phrases pour garder la parole", "Phrases to keep the conversation going", "Sorry, could you say that again?", "sorry, could you repeat that?, what do you mean by…?, how do you say…?, fillers: well, you know, I mean, let me think, basically"),
];

export const SKILLS = {
  A1: [
    S("a1-intro", "Se présenter", "Introduce yourself", "Hi, I'm Alex. I'm from France and I work in IT.", "to be, I'm from, I work in/as, nice to meet you"),
    S("a1-present", "Le présent simple", "Present simple", "I start work at nine and I usually drink coffee.", "present simple, the -s for he/she/it, do/does in questions, frequency words"),
    S("a1-questions", "Poser des questions", "Asking questions", "What do you do? Where do you live?", "what, where, when, why, how, who, how much/many, do/does word order"),
    S("a1-continuous", "Le présent continu", "Present continuous", "I'm working on a new project this week.", "be + -ing for now and temporary situations, vs present simple"),
    S("a1-plans", "Les projets : going to", "Plans with going to", "I'm going to call the client tomorrow.", "going to + verb, days, tomorrow / next week"),
  ],
  A2: [
    S("a2-past", "Le passé simple (prétérit)", "Past simple", "Yesterday I fixed a bug and went home late.", "regular -ed (and its 3 sounds), common irregular verbs, did in questions"),
    S("a2-perfect", "Le present perfect (bases)", "Present perfect (basics)", "I've already sent the email. Have you ever used Docker?", "have + past participle, ever/never/already/yet/just, vs past simple with a time"),
    S("a2-compare", "Comparer", "Comparing", "Python is easier than C, but it's not as fast.", "-er/more, the -est/most, as… as, better/worse"),
    S("a2-modals", "Les modaux : can, must, should", "Modals: can, must, should", "You should restart the server. You can't push to main.", "can/could, must/have to, should, mustn't vs don't have to"),
    S("a2-opinions", "Donner son avis simplement", "Simple opinions", "I think it's a good idea because it saves time.", "I think, in my opinion, I agree/disagree, because, so"),
  ],
  B1: [
    S("b1-narrate", "Raconter une histoire au passé", "Telling a story in the past", "I was deploying the app when the database crashed.", "past simple vs past continuous, then / after that / suddenly"),
    S("b1-perfect", "Present perfect vs past simple", "Present perfect vs past simple", "I've worked here for three years. I joined in 2023.", "for/since, unfinished time vs finished time, a classic French speaker mistake"),
    S("b1-future", "Parler du futur", "Talking about the future", "The release will probably slip. We're meeting the client on Monday.", "will, going to, present continuous for arrangements, probably / likely"),
    S("b1-conditional", "Les phrases avec if", "Conditionals", "If the tests pass, we'll ship it. If I had more time, I'd refactor it.", "first and second conditional, unless, as long as"),
    S("b1-work", "Expliquer son travail", "Explaining your job", "I'm in charge of the back end and I mainly work with Node and Postgres.", "I'm responsible for, I deal with, my role is to, team and stack words"),
    S("b1-meetings", "Participer à une réunion", "Taking part in a meeting", "Can I just jump in here? I'd like to add something.", "jumping in, asking for clarification, agreeing and disagreeing politely"),
    S("b1-phrasal", "Les phrasal verbs essentiels", "Essential phrasal verbs", "Let's set up a call and figure out the issue.", "set up, figure out, look into, come up with, run into, roll out, back up"),
    S("b1-connectors", "Les connecteurs", "Connectors", "It works locally; however, it fails in production.", "however, although, so, therefore, whereas, on top of that"),
  ],
  B2: [
    S("b2-standup", "Le stand-up quotidien", "The daily stand-up", "Yesterday I wrapped up the auth refactor; today I'm picking up the billing ticket; I'm blocked on the API keys.", "short status updates, blockers, wrapped up / picked up / blocked on, sounding confident and brief"),
    S("b2-explain-tech", "Expliquer un sujet technique simplement", "Explaining tech simply", "Basically, a cache is a shortcut: we keep the answer so we don't have to ask again.", "basically, in a nutshell, think of it as, the idea is that, analogies for non-technical people"),
    S("b2-code-review", "La revue de code à l'oral", "Code review talk", "Have you considered pulling this into a helper? It might be easier to test.", "suggesting changes without sounding rude: have you considered, what if we, I'd lean towards, nit"),
    S("b2-passive", "Le passif et le langage des process", "Passive and process language", "The data is encrypted before it's sent to the server.", "be + past participle, describing pipelines and systems, gets + participle"),
    S("b2-reported", "Le discours rapporté", "Reported speech", "The client said they needed it by Friday and asked whether we could help.", "said that, told me, asked if/whether, tense back-shift in speech"),
    S("b2-debate", "Argumenter et contredire", "Arguing and countering", "I see your point, but I'm not sure it scales.", "I see your point but, that's fair, on the other hand, the trade-off is, conceding"),
    S("b2-email-call", "Appels et visios pro", "Professional calls", "Sorry, you cut out for a second. Could you share your screen?", "video call phrases: you're on mute, can you see my screen, let's take this offline, follow up"),
    S("b2-idioms", "Expressions idiomatiques du bureau", "Workplace idioms", "Let's touch base next week, we're not out of the woods yet.", "touch base, on the same page, ballpark figure, low-hanging fruit, out of the woods, in the loop"),
    S("b2-pron-stress", "L'accent tonique et le rythme", "Word stress and rhythm", "We need to deVELop a deVELopment enVIronment.", "word stress (develop, component, analysis), weak forms (to, for, of), sentence stress on key words"),
    S("b2-numbers", "Chiffres, données et versions", "Numbers, data and versions", "Latency dropped by roughly forty percent, from two hundred to one-twenty milliseconds.", "reading numbers, percentages, versions (two point one), dates, increase/decrease by/to, roughly"),
  ],
  C1: [
    // The American accent, sound by sound.
    S("us-sounds", "Les sons qui trahissent un Français", "Sounds that give away a French speaker", "I think those three really are worth it.", "th (think, this), the American r (never rolled, tongue pulled back: car, world, really), the h (house, happy), short i against long ee (ship/sheep, live/leave)"),
    S("us-flap", "Le T américain", "The American T", "Better get a little water. It's not a lot of money.", "the flap t between vowels (water, better, a lot of, get it), the held t at the end (what, that), the dropped t (twenty, internet), can against can't"),
    S("us-vowels", "Les voyelles américaines", "American vowels", "My dad can't stand hot coffee, but he loves it with sugar.", "the vowel of cat, man, can't; the vowel of but, love, money; the vowel of hot, not, coffee; no French nasal vowels (on, an, in)"),
    S("us-reductions", "Les formes réduites", "Reductions", "I'm gonna grab some coffee. D'you wanna come?", "gonna, wanna, gotta, kinda, lemme, d'you, whaddaya, 'em, the weak forms of to, for, of, and, can"),
    S("us-stress", "L'accent de mot et le rythme", "Word stress and rhythm", "I didn't say she STOLE it. I said she BORROWED it.", "the stressed syllable (PHOtograph, phoTOgraphy, COMfortable), long content words, short small words, English rhythm against the even French rhythm"),
    S("us-linking", "Enchaîner les mots", "Linking words together", "Turn it off and pick it up. Not at all.", "a consonant joins the next vowel, no stop between words, the French stress at the end of a phrase goes away"),
    S("us-melody", "La mélodie américaine", "American melody", "You're coming, right? Well, I guess so. Oh, really?", "falling for statements, rising for yes/no questions, showing excitement, doubt and sarcasm, leaving the flat French melody behind"),
    // Smoother speech.
    S("sm-fillers", "Gagner du temps sans dire « euh »", "Buying time like a native", "Hmm, let me think. I mean, it's kind of hard to say, you know?", "you know, I mean, like, let me think, the thing is, how do I put this; no more euh or French fillers"),
    S("sm-chunks", "Parler par blocs", "Speaking in chunks", "At the end of the day, it kind of depends on what you want to do.", "ready-made chunks (at the end of the day, to be honest, it turns out, I was gonna say), breathing between chunks, no translating word by word"),
    S("sm-recover", "Se rattraper sans s'arrêter", "Recovering without stopping", "What's the word? It's the thing you use to, you know what I mean.", "going around a missing word, sorry I mean, keep going, never switch to French"),
    S("sm-story", "Raconter une histoire d'une traite", "Telling a story smoothly", "So I'm at this party, right, and this guy comes up to me and he's like…", "the story present tense, so, then, anyway, long story short, he's like, keeping the pace and the listener's attention"),
    // Everyday American English.
    S("daily-reactions", "Réagir comme un Américain", "Reacting like an American", "No way! That's awesome. Oh man, that sucks.", "no way, for real?, that's wild, that sucks, good for you, follow-up questions, enthusiasm"),
    S("daily-out", "Sortir : café, resto, bar", "Going out: cafés, restaurants, bars", "Can I get an iced coffee to go? Could we get the check?", "can I get, for here or to go, the check, splitting it, tipping, small talk with servers"),
    S("daily-friends", "Parler entre amis", "Talking with friends", "I'm down. What are you up to this weekend? Let's hang out.", "hang out, I'm down, up to, rain check, bail, flake, making and changing plans"),
    S("daily-errands", "Se débrouiller au quotidien", "Everyday errands and problems", "Hi, I'd like to return this. It stopped working after two days.", "stores, returns, the doctor, the pharmacy, a problem with an apartment, appointments by phone, complaining politely"),
    S("daily-travel", "Voyager aux États-Unis", "Getting around in the US", "Could you drop me off at the corner? Is this the line for security?", "airport, Uber, hotel, directions, renting a car, American habits"),
    S("daily-shows", "Parler séries, sport et musique", "Talking about shows, sports and music", "No spoilers, but that finale was insane. I'm so into that show.", "giving opinions, recommending, spoilers, binge, sports talk, disagreeing lightly"),
    S("us-idioms", "Les expressions américaines du quotidien", "Everyday American idioms", "It's a piece of cake. Let's play it by ear.", "the most common idioms and slang, baseball and football metaphors, what sounds old-fashioned"),
    S("us-culture", "Les codes américains", "American conversation habits", "How's it going? Good, you? Love your jacket, by the way!", "how are you as a hello, compliments, safe small talk, American directness and enthusiasm against French habits, saying no softly"),
    // Business English, for any company.
    S("biz-intro", "Se présenter en pro", "Introducing yourself professionally", "I run a small company. We help businesses save time.", "a short natural answer to what do you do?, sounding sure of yourself without bragging, a question back"),
    S("biz-network", "Networker sans malaise", "Networking without the awkwardness", "So how do you know the host? It was great talking to you.", "openers, showing interest, exit lines, following up"),
    S("biz-meetings", "Prendre sa place en réunion", "Speaking up in meetings", "Can I jump in here? Just to build on what Sarah said…", "jumping in, agreeing, disagreeing, asking for clarity, summing up, moving on"),
    S("biz-calls", "Appels et visios pro", "Business calls", "Thanks for making the time. Can you hear me OK?", "opening a call, small talk before business, sound problems, next steps, closing"),
    S("biz-polite", "Demander et dire non poliment", "Asking and saying no politely", "I'd love to, but I can't commit to that right now.", "I was wondering if, would it be possible, I'd love to but, softening without being vague"),
    S("biz-present", "Présenter une entreprise", "Presenting a company", "We help small shops sell online. Let me walk you through how it works.", "what the company does and for whom in one sentence, signposting (first, let me show you, moving on, to wrap up), saying numbers aloud, ending on a clear next step"),
    S("biz-qa", "Répondre aux questions après une présentation", "Handling questions", "Good question. The short answer is yes, but it depends on the volume.", "buying time, answering first and explaining after, I'll get back to you on that, handling an objection without getting defensive"),
    S("biz-negotiate", "Négocier simplement", "Basic negotiation", "We could do that if you can move the deadline.", "if you can..., we could..., what would work for you?, meet halfway, that's a bit above our budget, let me check and come back to you"),
    S("biz-update", "Faire un point et donner des nouvelles", "Giving an update", "Quick update: we're on track, but the launch might slip a week.", "on track, behind schedule, the main issue is, next steps, what I need from you"),
    S("biz-email", "Écrire des mails pro simples", "Simple work emails", "Thanks for getting back to me. Could you send me the file by Friday?", "opening and closing lines, a clear request, following up politely, no French-style long formulas"),
    // Relationships and life abroad.
    S("rel-friends", "Se faire des amis", "Making friends", "We should hang out sometime. Are you free this weekend?", "starting a conversation, keeping it going, suggesting a plan, exchanging numbers without awkwardness"),
    S("rel-invite", "Inviter et dire non gentiment", "Inviting and saying no kindly", "I'd love to, but I've got a thing. Rain check?", "do you want to, are you down for, I can't make it, maybe next time, how to accept with real warmth"),
    S("rel-feelings", "Parler de ce qu'on ressent", "Talking about feelings", "I've been feeling a bit homesick lately. It's been kind of a rough week.", "homesick, overwhelmed, a bit down, stressed out, excited about, looking forward to, how much to say and when"),
    S("rel-support", "Soutenir quelqu'un", "Being there for someone", "That sounds really tough. Do you want to talk about it?", "reacting with empathy, not giving advice too fast, I'm here if you need, congratulating and comforting"),
    S("rel-conflict", "Régler un désaccord sans se fâcher", "Sorting out a disagreement", "I don't want to make a big deal of it, but could you do your dishes?", "bringing up a problem softly, I feel like, apologising for real, finding a middle ground, with flatmates and friends"),
    S("uni-life", "La vie à l'université", "University life abroad", "Could I get an extension on the paper? Do you want to team up for the project?", "talking to a professor, group work, office hours, deadlines, grades, the words of campus life"),
    // The right word for the situation.
    S("word-register", "Le bon registre", "The right word for the situation", "Hey, got a sec? / Would you have a moment?", "the same idea with a friend, with a colleague and with a client; too formal sounds cold, too casual sounds rude"),
    S("word-colloc", "Les mots qui vont ensemble", "Words that go together", "Make a decision, take a break, have a meeting, do your best.", "the most common verb and noun pairs, and the ones French speakers get wrong"),
    S("word-false", "Les faux amis", "False friends", "Actually, I went to the meeting. Eventually, we agreed.", "actually, eventually, attend, assist, sensible, library, control, pretend, resume, deception"),
    S("word-precise", "Trouver le mot précis", "More precise words", "It was exhausting, and honestly a bit of a letdown.", "replacing very, good, bad, thing, do and make with the word a native would pick"),
    // The right sentence structure.
    S("st-tenses", "Choisir le bon temps", "Choosing the right tense", "I've lived here for two years. I moved here in 2024.", "present perfect or simple past, for and since, the past continuous for the background of a story, will or going to"),
    S("st-questions", "Poser des questions sans erreur", "Asking questions correctly", "Where do you work? Do you know where she lives?", "do and did in questions, question words, indirect questions without inversion, short questions at the end"),
    S("st-order", "L'ordre des mots en anglais", "English word order", "I really like it. I often go there. She gave me a great idea.", "where adverbs go, nothing between the verb and its object, adjectives before the noun, the French order to lose"),
    S("st-french", "Les structures à la française", "French structures to lose", "I agree. It depends on you. I'm 25. Explain it to me.", "I am agree, it depends of, I have 25 years, since three years, explain me, the people is, informations"),
    S("st-link", "Relier ses idées en phrases longues", "Linking ideas in longer sentences", "Even though it was late, we stayed, which turned out to be a great idea.", "although, even though, which, so that, as soon as, not only, moving from short sentences to linked ones"),
    S("c1-nuance", "Nuancer son discours", "Adding nuance and hedging", "It's arguably the best option, although I'd be cautious about the cost.", "arguably, to some extent, I'd be inclined to, it might be worth, tend to, more or less"),
    S("c1-architecture", "Défendre une architecture", "Defending an architecture", "We went with a queue because it decouples the services and lets us absorb spikes.", "justifying technical choices, trade-offs, scalability, maintainability, we went with X because"),
    S("c1-incident", "Gérer un incident et un post-mortem", "Incidents and post-mortems", "The root cause was a misconfigured flag, and we've put safeguards in place so it won't happen again.", "root cause, impact, mitigation, timeline, blameless language, taking ownership"),
    S("c1-client", "Parler à un client exigeant", "Handling a demanding client", "I completely understand your frustration. Here's what we're going to do.", "empathy, managing expectations, saying no politely, scope creep, pushing back with options"),
    S("c1-mixed-cond", "Les regrets et les conditionnels mixtes", "Regrets and mixed conditionals", "If we had tested it properly, we wouldn't be in this mess now.", "third and mixed conditionals, should have, wish / if only"),
    S("c1-emphasis", "Insister : inversions et phrases clivées", "Emphasis: cleft sentences and inversion", "What really matters is the user experience. Not only is it faster, it's cheaper.", "what I mean is, it's X that, not only… but, never have I, the thing is"),
    S("c1-presenting", "Présenter une démo ou un projet", "Presenting a demo or a project", "Let me walk you through how it works, and then we'll take questions.", "signposting: first off, moving on to, to sum up; walking someone through; handling questions"),
    S("c1-phrasal-adv", "Phrasal verbs avancés du métier", "Advanced phrasal verbs at work", "We need to iron out a few issues before we roll it out.", "iron out, phase out, carry over, bring up, sign off on, scale back, follow through"),
    S("c1-interview", "Entretien technique en anglais", "Technical interviews", "Let me think out loud for a second: I'd start with a brute-force approach, then optimise.", "thinking out loud, STAR answers, talking about achievements without bragging, asking good questions"),
    S("c1-small-talk", "Small talk naturel avec des collègues", "Natural small talk with colleagues", "How was your weekend? Did you get up to anything fun?", "openers, follow-up questions, reacting naturally, get up to, keeping it light"),
    S("c1-pron", "Sonner naturel : liaisons et formes faibles", "Sounding natural: linking and weak forms", "Wha-d'you-think? I'm gonna check it out.", "linking, contractions, gonna/wanna in speech, the schwa, intonation for questions and lists"),
  ],
  C2: [
    S("c2-precision", "Précision et style", "Precision and style", "It's not a bug so much as an undocumented feature.", "precise word choice, collocations, register shifts, understatement"),
    S("c2-influence", "Convaincre et négocier", "Persuading and negotiating", "If we can agree on the timeline, I'm sure we can be flexible on the rest.", "framing, conditional offers, finding common ground, closing"),
    S("c2-humor", "L'humour et l'ironie", "Humour and irony", "Oh great, another meeting that could have been an email.", "irony, understatement, banter, dev jokes, when humour works in a meeting"),
    S("c2-leadership", "Mener une équipe", "Leading a team", "I want everyone to feel comfortable flagging problems early.", "giving feedback, motivating, delegating, running a retrospective"),
    S("c2-culture", "Références culturelles", "Cultural references", "It feels a bit like Groundhog Day: same bug, every Monday.", "films, series, sayings and tech culture that natives use"),
    S("c2-speed", "Suivre et parler à vitesse native", "Native speed", "Yeah no, totally, I mean it kinda depends, right?", "fast natural speech, reduced forms, overlapping talk, American and British accents"),
  ],
};

// Skills about the accent: they stay in the library and the accent workout, but the course plan leaves them out (new goals, 2026-11-05).
export const ACCENT_SKILLS = new Set(["us-sounds", "us-flap", "us-vowels", "us-reductions", "us-stress", "us-linking", "us-melody", "c1-pron"]);
// Skills about software work: they stay in the library, but the course plan leaves them out (added on 2026-11-04).
export const IT_SKILLS = new Set(["b2-standup", "b2-explain-tech", "b2-code-review", "b2-passive", "c1-architecture", "c1-incident", "c1-interview"]);

export const ALL_SKILLS = Object.entries(SKILLS).flatMap(([level, list]) => list.map((s) => ({ ...s, level })));
export const SKILL_BY_ID = Object.fromEntries(ALL_SKILLS.map((s) => [s.id, s]));
export const LEVEL_IDS = LEVELS.map((l) => l.id);

// Skill states, from first contact to automatic use.
export const STATES = ["new", "seen", "practicing", "good", "mastered"];
const DONE = new Set(["good", "mastered"]);

// Share of the level's skills that are good or mastered.
export function levelProgress(level, skills = {}) {
  const list = SKILLS[level] || [];
  if (!list.length) return 0;
  const done = list.filter((s) => DONE.has(skills[s.id]?.state)).length;
  return done / list.length;
}

// The next skills to teach at this level: unfinished ones, the ones in progress first.
export function nextSkills(level, skills = {}, n = 2) {
  const list = SKILLS[level] || [];
  const rank = (s) => {
    const st = skills[s.id]?.state || "new";
    return st === "practicing" ? 0 : st === "seen" ? 1 : st === "new" ? 2 : 9;
  };
  return list.map((s, i) => ({ s, i, r: rank(s) }))
    .filter((x) => x.r < 9)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, n)
    .map((x) => x.s);
}

// Skills learned before that need a refresh (good, not mastered, not seen for 10+ days).
export function reviewSkills(skills = {}, n = 1) {
  const now = Date.now();
  return ALL_SKILLS
    .filter((s) => skills[s.id]?.state === "good" && now - (skills[s.id].last || 0) > 10 * 864e5)
    .sort((a, b) => (skills[a.id].last || 0) - (skills[b.id].last || 0))
    .slice(0, n);
}
