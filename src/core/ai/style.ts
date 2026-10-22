// How Zipply's drafts should sound: like the applicant wrote them for the
// person who will read them, not like a chatbot. The rules go into every
// writing prompt; the checker finds what slipped through so one revision pass
// can fix it.

/** What recruiters and hiring managers respond to, and what makes text read as AI. */
export const WRITING_RULES = `How to write it:
- Sound like a capable person typing their own answer: plain words, first person, contractions are fine, sentences of different lengths. Write the way the applicant would say it to a hiring manager across a table.
- Lead with the answer. A recruiter skims the first sentence; it should already say something specific.
- Prove, don't claim. One concrete example (what I did, with what, and what came of it) beats any adjective. Use numbers only if they appear in <profile>.
- Tie the evidence to what this team asks for. Use the posting's words for skills and tools where they're true for me, so it reads well to people and to an ATS, but don't copy its sentences.
- If I'm missing something they want, don't hide it or fake it: point to the closest real experience in one sentence.
- Stop when the point is made. No summary at the end.

Never use:
- Openers and closers like "I am writing to", "I am excited/thrilled to", "I hope this", "Thank you for your time and consideration", "I look forward to hearing from you", "In conclusion", "In summary", "Overall,".
- Filler words: passionate, leverage, utilize, delve, dynamic, fast-paced, synergy, cutting-edge, innovative, robust, seamless, spearheaded, tapestry, testament, journey, landscape, realm, honed, resonate(s), align(s) with my values, unique blend, proven track record, results-driven, detail-oriented, team player, go-getter, hit the ground running, wear many hats.
- Chatbot habits: em dashes (—), "not only ... but also", lists of three adjectives, "Moreover/Furthermore/Additionally" to start a sentence, rhetorical questions, exclamation marks, restating the question, flattering the company, emojis, markdown, bullet points (unless asked), placeholders in [brackets].`

interface Tell {
  re: RegExp
  label: string
}

const TELLS: Tell[] = [
  { re: /—|–/, label: 'em or en dashes' },
  { re: /\bI am (writing|reaching out) to\b/i, label: '"I am writing to"' },
  { re: /\b(I am|I'm) (so |very |truly )?(excited|thrilled|eager|delighted)\b/i, label: '"I\'m excited/thrilled"' },
  { re: /\bpassion(ate)?\b/i, label: '"passionate"' },
  { re: /\b(leverag(e|ed|ing)|utiliz(e|ed|ing))\b/i, label: '"leverage/utilize"' },
  { re: /\b(delve|tapestry|testament|realm|landscape|synergy|cutting-edge|seamless(ly)?|spearhead(ed)?|honed|resonat(e|es|ed))\b/i, label: 'AI-sounding words (delve, testament, landscape...)' },
  { re: /\b(fast-paced|dynamic|results-driven|detail-oriented|team player|go-getter|proven track record|unique blend|hit the ground running|wear many hats)\b/i, label: 'resume clichés' },
  { re: /\balign(s)? (perfectly )?with my (values|goals|passion)\b/i, label: '"aligns with my values"' },
  { re: /\bnot only\b[^.]{0,80}\bbut also\b/i, label: '"not only ... but also"' },
  { re: /(^|[.!?]\s+)(Moreover|Furthermore|Additionally|In conclusion|In summary|Overall),/m, label: 'stiff transitions (Moreover, Furthermore...)' },
  { re: /\b(I look forward to (hearing|the opportunity)|Thank you for (your time and )?consideration|I hope this (message|letter) finds you)\b/i, label: 'stock closing lines' },
  { re: /!/, label: 'exclamation marks' },
  { re: /\[[^\]]{2,40}\]/, label: 'placeholders in [brackets]' },
  { re: /(\*\*|^#+\s|^\s*[*-]\s)/m, label: 'markdown or bullets' },
  { re: /\b(as an AI|language model)\b/i, label: 'mentions of AI' },
]

/** The chatbot tells in a draft, as short labels. Empty means it reads clean. */
export function styleIssues(text: string, opts: { bullets?: boolean } = {}): string[] {
  return TELLS.filter((t) => !(opts.bullets && t.label === 'markdown or bullets') && t.re.test(text)).map((t) => t.label)
}

/**
 * Mechanical cleanups that don't need a model: greeting and sign-off lines,
 * markdown emphasis, wrapping quotes, em dashes, stray spaces.
 */
export function tidy(text: string, opts: { bullets?: boolean } = {}): string {
  let t = text.trim().replace(/^["“](.*)["”]$/s, '$1').trim()
  const lines = t.split('\n')
  // A greeting line at the top ("Dear Hiring Manager,", "Hi team,").
  while (lines.length && /^(dear|hi|hello|to whom)\b[^.\n]{0,60},?\s*$/i.test(lines[0].trim())) lines.shift()
  // Sign-offs and name placeholders at the bottom.
  while (lines.length && /^(sincerely|best( regards)?|regards|kind regards|warm regards|thanks|thank you|cheers|respectfully)\b[^.\n]{0,20},?\s*$|^\[?(your name|name)\]?$|^\s*$/i.test(lines[lines.length - 1].trim())) lines.pop()
  t = lines.join('\n')
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#+\s+/gm, '')
  // "built X — and it worked" reads as AI; a comma reads as a person.
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',').replace(/,\s*([.;:])/g, '$1')
  if (!opts.bullets) t = t.replace(/^\s*[*•]\s+/gm, '')
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()
}

export type QuestionKind = 'whyCompany' | 'whyRole' | 'aboutYou' | 'story' | 'strengths' | 'weakness' | 'project' | 'goals' | 'extra' | 'other'

const KINDS: [QuestionKind, RegExp][] = [
  ['story', /\b(tell (us|me) about a time|describe a (time|situation)|give an example|example of a time|a time when|walk us through a)\b/i],
  ['whyCompany', /\bwhy (do you want to|would you like to|are you interested in|are you applying to|this company|us|join|work (at|for|with))\b|\binterest(s|ed)? you (about|in) (us|our|this company|working)|\bwhat (excites|attracts|draws) you\b/i],
  ['whyRole', /\bwhy (this|the) (role|position|job)\b|\binterest(ed)? in (this|the) (role|position)\b|\binterests? you about (this|the) (role|position|job)\b/i],
  ['project', /\b(project|something you('|’)?ve built|proudest|most proud|accomplishment|achievement)\b/i],
  ['weakness', /\b(weakness|area(s)? (for|of) (improvement|growth)|failure|mistake)\b/i],
  ['strengths', /\b(strength|what (makes you|would you bring)|why should we hire|why are you a (good|great|strong) fit|qualif(y|ies) you)\b/i],
  ['goals', /\b(goals?|five years|5 years|career (plans|aspirations)|where do you see)\b/i],
  ['aboutYou', /\b(tell (us|me) about yourself|introduce yourself|about you\b|describe yourself)\b/i],
  ['extra', /\b(anything else|additional information|is there anything)\b/i],
]

export function questionKind(q: string): QuestionKind {
  return KINDS.find(([, re]) => re.test(q))?.[0] ?? 'other'
}

/** What a hiring team wants from each kind of question. */
export const KIND_GUIDE: Record<QuestionKind, string> = {
  whyCompany: 'They want to know you picked them on purpose. Name one concrete thing from <posting> (the product, the problem they solve, who they serve, how the team works) and connect it to something real in my background. No praise of the company in general terms.',
  whyRole: 'Connect the actual work in <posting> to work I have already done and want more of. Say what I would be good at in the first months, based on <profile>.',
  aboutYou: 'Two or three sentences on what I do now and what I am good at, then the one experience most relevant to this posting. Not a life story and not a list of skills.',
  story: 'Tell one real story from <profile>: the situation in one sentence, what I did (the bulk of it), and the result. If <profile> has no fitting story, use the closest real experience and keep it short.',
  strengths: 'Pick the two strengths that matter most for this posting and back each with something I actually did. No generic traits without evidence.',
  weakness: 'Name a real, specific area I am working on that is not core to this role, and what I am doing about it. No disguised strengths like "I work too hard".',
  project: 'One project from <profile>: what it was for, what I built or did myself, the tools, and what happened as a result. Concrete nouns, not adjectives.',
  goals: 'Short and grounded: the kind of work I want to get better at, tied to what this role would let me do. No grand claims.',
  extra: 'Only add something useful that the rest of the application might not show, tied to this role. If nothing fits, one sentence is enough.',
  other: 'Answer exactly what is asked, directly, using real details from <profile>.',
}

/** Ask for one rewrite that fixes the tells and keeps every fact. */
export function revisionPrompt(draft: string, issues: string[], maxWords: number): { system: string; prompt: string } {
  return {
    system: `You edit a job application draft so it reads like the applicant wrote it. Keep every fact, claim and meaning the same and add nothing new. ${WRITING_RULES}`,
    prompt: `<draft>\n${draft}\n</draft>\n\nFix these problems: ${issues.join('; ')}.\nKeep it under ${maxWords} words. Return only the revised text.`,
  }
}
